const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const http = require('http');
const {
  httpAgent,
  httpsAgent,
  PORT,
  CACHE_TTL,
  US_M3U_URL,
  CA_M3U_URL,
  UG_M3U_URL,
  EXTRA_M3U_URLS,
  ADULT_M3U_URLS,
  ENABLE_ADULT,
  HEALTH_FILTER,
  STRICT_IPTV_VALIDATION,
  HEALTH_CHECK_INTERVAL,
  PROXY_HOST,
  IPTV_VALID_CONTENT_TYPES,
  PROXY_HEADERS
} = require('./src/config');
const { log } = require('./src/log');
const { runtimeState, cacheConfig, syncRuntimeState } = require('./src/state');
const { parseM3USource } = require('./src/sources/m3u');
const { findAlternativeChannels } = require('./src/normalize/channel-matching');
const { collectCatalogGenres } = require('./src/normalize/channel-ranking');
const { buildCatalogPage } = require('./src/catalog/channel-catalog');
const { SEGMENT_CACHE_TTL, PREFETCH_COUNT, PLAYLIST_CACHE_TTL, MAX_CONCURRENT_PREFETCHES, HEALTH_BATCH_SIZE } = cacheConfig;
const { segmentCache, playlistCache } = runtimeState;
let {
  usChannels,
  caChannels,
  ugChannels,
  extraChannels,
  adultChannels,
  allChannels,
  allGenres,
  lastFetch,
  activePrefetches,
  healthCheckDone,
  healthCheckRunning,
  lastHealthCheckAt
} = runtimeState;

function normalizeContentType(contentType) {
  if (!contentType) return '';
  return String(contentType).split(';')[0].trim().toLowerCase();
}

function looksLikeLiveStream(url) {
  return /\.(m3u8|ts|mpd)(\?|$)/i.test(url || '');
}

function scoreChannelVariant(channel) {
  let score = 0;
  if (channel.poster || channel.logo) score += 4;
  if (channel.tvgId) score += 2;
  if (channel.extraHeaders) score += 1;
  if (channel.quality === '4K') score += 4;
  else if (channel.quality === 'FHD') score += 3;
  else if (channel.quality === 'HD') score += 2;
  else if (channel.quality) score += 1;
  score += Math.min((channel.groups || []).length, 3);
  return score;
}

function dedupeKeyForChannel(channel) {
  const identity = channel.canonicalId || channel.normalizedName || String(channel.name || '').trim().toLowerCase();
  return `${identity}:${channel.url}`;
}

function dedupeChannels(channels) {
  const deduped = new Map();
  for (const channel of channels) {
    const key = dedupeKeyForChannel(channel);
    const existing = deduped.get(key);
    if (!existing || scoreChannelVariant(channel) > scoreChannelVariant(existing)) {
      deduped.set(key, channel);
    }
  }
  return [...deduped.values()];
}

function formatRegionLabel(country) {
  const normalized = String(country || '').trim().toLowerCase();
  if (!normalized || normalized === 'global') return 'Global';
  if (normalized === 'us') return 'USA';
  if (normalized === 'ca') return 'Canada';
  if (normalized === 'ug') return 'Uganda';
  if (normalized === 'adult') return 'Adult';
  return normalized
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function fetchM3USource({ url, sourceId, country, label }) {
  const attempts = [
    { timeout: 15000, retryLabel: 'attempt 1' },
    { timeout: 25000, retryLabel: 'retry' }
  ];

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      const response = await axios.get(url, {
        timeout: attempt.timeout,
        httpAgent,
        httpsAgent
      });
      const parsed = parseM3USource({ content: response.data, sourceId, country });
      const phase = index === 0 ? 'loaded' : 'loaded on retry';
      log(`${label} source ${phase}: ${url} (${parsed.length} channels)`);
      return parsed;
    } catch (err) {
      if (index === attempts.length - 1) {
        log(`${label} source failed (${url}) — ${err.message} — status: ${err.response?.status || 'no response'}`);
        return [];
      }
      log(`${label} source ${attempt.retryLabel} failed (${url}): ${err.message}, retrying...`);
    }
  }

  return [];
}

setInterval(() => {
  const now = Date.now();
  let evicted = 0;
  for (const [url, entry] of segmentCache) {
    if (!entry || now - entry.fetchedAt > SEGMENT_CACHE_TTL) {
      segmentCache.delete(url);
      evicted++;
    }
  }
  for (const [url, entry] of playlistCache) {
    if (now - entry.fetchedAt > PLAYLIST_CACHE_TTL * 5) playlistCache.delete(url);
  }
  if (evicted > 0) log(`Segment cache: evicted ${evicted}, remaining ${segmentCache.size}`);
}, 30 * 1000);

async function prefetchSegments(urls, extraHeaders) {
  for (const url of urls) {
    if (segmentCache.has(url)) continue;
    if (activePrefetches >= MAX_CONCURRENT_PREFETCHES) break;
    segmentCache.set(url, null);
    activePrefetches++;
    runtimeState.activePrefetches = activePrefetches;
    axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { ...PROXY_HEADERS, ...extraHeaders },
      httpAgent, httpsAgent,
      maxRedirects: 5
    }).then(resp => {
      segmentCache.set(url, {
        data: Buffer.from(resp.data),
        contentType: resp.headers['content-type'] || 'video/mp2t',
        fetchedAt: Date.now()
      });
    }).catch(err => {
      segmentCache.delete(url);
      log(`Prefetch miss ${url.slice(0, 70)}: ${err.message}`);
    }).finally(() => {
      activePrefetches--;
      runtimeState.activePrefetches = activePrefetches;
    });
  }
}

async function refreshChannels() {
  const now = Date.now();
  if (allChannels.length > 0 && now - lastFetch < CACHE_TTL) {
    return;
  }

  log('Fetching fresh channel lists...');

  try {
    const fetchAdult = async () => {
      if (!ENABLE_ADULT) return [];
      const sourceResults = await Promise.all(
        ADULT_M3U_URLS.map((url, index) => fetchM3USource({
          url,
          sourceId: `adult_${index + 1}`,
          country: 'adult',
          label: 'Adult'
        }))
      );
      const merged = dedupeChannels(sourceResults.flat());
      return merged;
    };

    const extraSourceConfigs = EXTRA_M3U_URLS.map((url, index) => ({
      url,
      sourceId: `extra_${index + 1}`,
      country: 'global',
      label: `Extra ${index + 1}`
    }));

    const [fetchedUsChannels, fetchedCaChannels, fetchedUgChannels, fetchedExtraChannels, fetchedAdultChannels] = await Promise.all([
      fetchM3USource({ url: US_M3U_URL, sourceId: 'us', country: 'us', label: 'US' }),
      fetchM3USource({ url: CA_M3U_URL, sourceId: 'ca', country: 'ca', label: 'Canada' }),
      fetchM3USource({ url: UG_M3U_URL, sourceId: 'ug', country: 'ug', label: 'Uganda' }),
      Promise.all(extraSourceConfigs.map(fetchM3USource)).then((results) => dedupeChannels(results.flat())),
      fetchAdult()
    ]);

    usChannels = fetchedUsChannels;
    caChannels = fetchedCaChannels;
    ugChannels = fetchedUgChannels;
    extraChannels = fetchedExtraChannels;
    adultChannels = fetchedAdultChannels;

    if (!ENABLE_ADULT) {
      usChannels = usChannels.filter(ch => !ch.isAdult);
      caChannels = caChannels.filter(ch => !ch.isAdult);
      ugChannels = ugChannels.filter(ch => !ch.isAdult);
      extraChannels = extraChannels.filter(ch => !ch.isAdult);
      adultChannels = [];
    }

    allChannels = dedupeChannels([
      ...usChannels,
      ...caChannels,
      ...ugChannels,
      ...extraChannels,
      ...adultChannels
    ]);

    allGenres = collectCatalogGenres(allChannels);

    lastFetch = now;
    syncRuntimeState({
      usChannels,
      caChannels,
      ugChannels,
      extraChannels,
      adultChannels,
      allChannels,
      allGenres,
      lastFetch
    });
    log(`Loaded ${usChannels.length} US + ${caChannels.length} CA + ${ugChannels.length} UG + ${extraChannels.length} Extra + ${adultChannels.length} Adult = ${allChannels.length} total channels`);
    log(`Health filter=${HEALTH_FILTER} strictValidation=${STRICT_IPTV_VALIDATION} extraSources=${EXTRA_M3U_URLS.length} adult=${ENABLE_ADULT} adultSources=${ADULT_M3U_URLS.length}`);
    log(`Found ${allGenres.length} genres: ${allGenres.slice(0, 15).join(', ')}...`);

    runHealthCheck().catch(err => log(`Health check failed to start: ${err.message}`));
  } catch (err) {
    log(`ERROR fetching channels: ${err.message}`);
  }
}

async function probeStream(channel) {
  try {
    return await axios.head(channel.url, {
      timeout: 6000,
      maxRedirects: 3,
      headers: channel.extraHeaders || {},
      validateStatus: (status) => status >= 200 && status < 400,
      httpAgent,
      httpsAgent
    });
  } catch (headErr) {
    const status = headErr?.response?.status;
    if (![400, 401, 403, 405].includes(status)) throw headErr;

    const response = await axios.get(channel.url, {
      timeout: 6000,
      maxRedirects: 3,
      responseType: 'stream',
      headers: { ...(channel.extraHeaders || {}), Range: 'bytes=0-0' },
      validateStatus: (code) => code >= 200 && code < 400,
      httpAgent,
      httpsAgent
    });

    if (response?.data && typeof response.data.destroy === 'function') {
      response.data.destroy();
    }

    return response;
  }
}

async function checkStreamHealth(channel) {
  const start = Date.now();
  try {
    const response = await probeStream(channel);
    const contentType = normalizeContentType(response.headers['content-type']);
    const validType = IPTV_VALID_CONTENT_TYPES.has(contentType) || looksLikeLiveStream(channel.url);

    channel.healthy = STRICT_IPTV_VALIDATION ? validType : true;
    channel.responseMs = Date.now() - start;
    channel.contentType = contentType || null;
    channel.lastHealthAt = new Date().toISOString();
    channel.lastHealthError = channel.healthy
      ? null
      : `Unsupported content-type: ${contentType || 'unknown'}`;
  } catch (err) {
    channel.healthy = false;
    channel.responseMs = 99999;
    channel.lastHealthAt = new Date().toISOString();
    channel.lastHealthError = err.message;
  }
}

async function runHealthCheck() {
  if (healthCheckRunning || allChannels.length === 0) return;

  healthCheckRunning = true;
  runtimeState.healthCheckRunning = true;
  const BATCH = HEALTH_BATCH_SIZE;
  const channels = [...allChannels];
  log(`Running health check on all ${channels.length} channels in batches of ${BATCH}...`);

  try {
    for (let i = 0; i < channels.length; i += BATCH) {
      const batch = channels.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(ch => checkStreamHealth(ch)));
    }

    const healthy = allChannels.filter(ch => ch.healthy).length;
    const pct = Math.round((healthy / allChannels.length) * 100);
    log(`Health check complete: ${healthy}/${allChannels.length} (${pct}%) streams live`);
    healthCheckDone = true;
    lastHealthCheckAt = Date.now();
    syncRuntimeState({
      healthCheckDone,
      lastHealthCheckAt
    });
  } finally {
    healthCheckRunning = false;
    runtimeState.healthCheckRunning = false;
  }
}

function channelToMeta(ch) {
  const regionLabel = formatRegionLabel(ch.country);
  const qualityBadge = ch.quality ? ` (${ch.quality})` : '';
  const genres = [ch.primaryGroup, regionLabel].filter((value, index, list) => list.indexOf(value) === index);

  return {
    id: `freevie:${ch.id}`,
    type: 'tv',
    name: ch.name,
    poster: ch.poster || ch.logo || undefined,
    logo: ch.logo || ch.poster || undefined,
    posterShape: 'square',
    description: `Live TV: ${ch.name}${qualityBadge} — ${regionLabel}`,
    genres,
    links: [],
    background: ch.poster || ch.logo || undefined
  };
}

function buildProxyUrl(originalUrl, extraHeaders) {
  if (!PROXY_HOST) return originalUrl;
  const params = new URLSearchParams({ url: originalUrl });
  if (extraHeaders) params.set('headers', JSON.stringify(extraHeaders));
  return `${PROXY_HOST}/proxy?${params.toString()}`;
}

function channelToStream(ch) {
  const qualityLabel = ch.quality || 'Live';
  const countryLabel = formatRegionLabel(ch.country);
  const speedLabel = ch.responseMs && ch.responseMs < 99999
    ? ` • ${ch.responseMs}ms`
    : '';
  const relayLabel = PROXY_HOST ? ' [Relay]' : '';
  const fallbackLabel = ch.healthy === false ? ' Fallback' : '';

  const streamUrl = buildProxyUrl(ch.url, ch.extraHeaders);

  const stream = {
    url: streamUrl,
    name: `${qualityLabel}${speedLabel}${relayLabel}${fallbackLabel}`,
    description: `${ch.name} — ${countryLabel}`,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: 'freevie-live'
    }
  };

  if (ch.extraHeaders || ch.contentType) {
    const proxyHeaders = {};
    if (ch.extraHeaders) proxyHeaders.request = ch.extraHeaders;
    if (ch.contentType) proxyHeaders.response = { 'Content-Type': ch.contentType };
    stream.behaviorHints.proxyHeaders = proxyHeaders;
  }

  return stream;
}

const manifest = {
  id: 'community.freevie',
  version: '2.2.1',
  name: 'Freevie Live TV',
  description: 'Free live TV channels from USA, Canada & Uganda. Open source, self-hostable.',
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'freevie_us',
      name: 'USA TV',
      extra: [
        { name: 'genre', isRequired: false, options: [] },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'tv',
      id: 'freevie_ca',
      name: 'Canada TV',
      extra: [
        { name: 'genre', isRequired: false, options: [] },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'tv',
      id: 'freevie_ug',
      name: 'Uganda TV',
      extra: [
        { name: 'genre', isRequired: false, options: [] },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'tv',
      id: 'freevie_adult',
      name: 'Adult',
      extra: [
        { name: 'genre', isRequired: false, options: [] },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'tv',
      id: 'freevie_all',
      name: 'All Channels',
      extra: [
        { name: 'genre', isRequired: false, options: [] },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    }
  ],
  resources: ['catalog', 'meta', 'stream'],
  logo: 'https://i.imgur.com/Gr0vknt.png',
  background: 'https://i.imgur.com/ePKOGeL.jpg',
  behaviorHints: { configurable: false }
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== 'tv') return { metas: [] };
  if (!ENABLE_ADULT && id === 'freevie_adult') return { metas: [] };

  await refreshChannels();

  let pool;
  if (id === 'freevie_us') pool = usChannels;
  else if (id === 'freevie_ca') pool = caChannels;
  else if (id === 'freevie_ug') pool = ugChannels;
  else if (id === 'freevie_adult') pool = adultChannels;
  else pool = allChannels;

  let filtered = pool;

  if (HEALTH_FILTER && healthCheckDone) {
    filtered = filtered.filter(ch => ch.healthy);
  }

  const PAGE_SIZE = 100;
  const page = buildCatalogPage(filtered, {
    genre: extra?.genre,
    search: extra?.search,
    skip: extra?.skip,
    pageSize: PAGE_SIZE,
    rankContext: {
      catalogId: id,
      genre: extra?.genre
    }
  });

  return { metas: page.map(channelToMeta) };
});

builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'tv' || !id.startsWith('freevie:')) return { meta: null };

  await refreshChannels();

  const channelId = id.replace('freevie:', '');
  const ch = allChannels.find(c => c.id === channelId);
  if (!ch) return { meta: null };

  return { meta: channelToMeta(ch) };
});

builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'tv' || !id.startsWith('freevie:')) return { streams: [] };

  await refreshChannels();

  const channelId = id.replace('freevie:', '');
  const ch = allChannels.find(c => c.id === channelId);
  if (!ch) return { streams: [] };

  const alternatives = findAlternativeChannels(ch, allChannels);

  const QUALITY_SCORE = { 'SD': 0, '360p': 1, '240p': 2, 'HD': 3, 'FHD': 4, '4K': 5 };

  const candidates = [ch, ...alternatives]
    .filter(c => {
      if (!HEALTH_FILTER || !healthCheckDone) return true;
      return c.healthy && (c.responseMs || 0) < 3000;
    })
    .sort((a, b) => {
      const msDiff = (a.responseMs || 99999) - (b.responseMs || 99999);
      const aQ = QUALITY_SCORE[a.quality] ?? 3;
      const bQ = QUALITY_SCORE[b.quality] ?? 3;
      const qualityPenalty = (aQ > 3 ? 500 : 0) - (bQ > 3 ? 500 : 0);
      return msDiff + qualityPenalty;
    });

  const finalCandidates = candidates.length > 0
    ? candidates
    : [ch, ...alternatives].sort((a, b) => (a.responseMs || 99999) - (b.responseMs || 99999));

  const streams = finalCandidates.map((candidate, i) => {
    const stream = channelToStream(candidate);
    if (i > 0) stream.name += ' (alt)';
    return stream;
  });

  return { streams };
});

const addonInterface = builder.getInterface();

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    const healthData = {
      status: 'ok',
      version: manifest.version,
      config: {
        cacheTtlMs: CACHE_TTL,
        healthFilter: HEALTH_FILTER,
        strictIptvValidation: STRICT_IPTV_VALIDATION,
        healthCheckIntervalMs: HEALTH_CHECK_INTERVAL,
        adultCatalogEnabled: ENABLE_ADULT
      },
      proxy: PROXY_HOST ? { enabled: true, host: PROXY_HOST } : { enabled: false },
      channels: {
        us: usChannels.length,
        ca: caChannels.length,
        ug: ugChannels.length,
        extra: extraChannels.length,
        adult: adultChannels.length,
        total: allChannels.length
      },
      health: {
        checkDone: healthCheckDone,
        checkRunning: healthCheckRunning,
        lastCheckAt: lastHealthCheckAt ? new Date(lastHealthCheckAt).toISOString() : null
      },
      genres: allGenres.length,
      lastRefresh: lastFetch ? new Date(lastFetch).toISOString() : null,
      uptime: process.uptime()
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthData, null, 2));
    return;
  }

  if (req.url.startsWith('/proxy')) {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    const targetUrl = reqUrl.searchParams.get('url');
    const headersParam = reqUrl.searchParams.get('headers');

    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    let extraHeaders = {};
    try {
      if (headersParam) extraHeaders = JSON.parse(headersParam);
    } catch (_) { }

    const isPlaylist = targetUrl.includes('.m3u8') || targetUrl.includes('m3u');
    if (isPlaylist) {
      const cachedPlaylist = playlistCache.get(targetUrl);
      if (cachedPlaylist && (Date.now() - cachedPlaylist.fetchedAt) < PLAYLIST_CACHE_TTL) {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store',
          'X-Cache': 'PLAYLIST-HIT'
        });
        res.end(cachedPlaylist.content);
        return;
      }
    }

    const cached = segmentCache.get(targetUrl);
    if (cached && cached.data && (Date.now() - cached.fetchedAt) < SEGMENT_CACHE_TTL) {
      res.writeHead(200, {
        'Content-Type': cached.contentType,
        'Access-Control-Allow-Origin': '*',
        'Content-Length': cached.data.length,
        'X-Cache': 'HIT'
      });
      res.end(cached.data);
      return;
    }

    const isSegment = /\.(ts|aac|mp4|m4s|cmfv|cmfa)(\?|$)/i.test(targetUrl);
    const timeout = isSegment ? 4000 : 12000;

    try {
      const upstream = await axios.get(targetUrl, {
        responseType: 'stream',
        timeout,
        headers: { ...PROXY_HEADERS, ...extraHeaders },
        httpAgent, httpsAgent,
        maxRedirects: 5
      });

      const contentType = upstream.headers['content-type'] || '';
      const isHLS = targetUrl.includes('.m3u8') || contentType.includes('mpegurl') || contentType.includes('x-mpegurl');

      if (isHLS) {
        const chunks = [];
        for await (const chunk of upstream.data) chunks.push(chunk);
        const playlist = Buffer.concat(chunks).toString('utf8');

        const base = new URL(targetUrl);
        const baseDir = base.href.substring(0, base.href.lastIndexOf('/') + 1);

        const toPreFetch = playlist.split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'))
          .map(l => { try { return new URL(l, baseDir).href; } catch (_) { return null; } })
          .filter(Boolean)
          .slice(0, PREFETCH_COUNT);

        prefetchSegments(toPreFetch, extraHeaders);

        const rewritten = playlist.split('\n').map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;
          if (trimmed.startsWith(`${PROXY_HOST}/proxy`)) return line;
          let segUrl;
          try { segUrl = new URL(trimmed, baseDir).href; } catch (_) { return line; }
          const proxyParams = new URLSearchParams({ url: segUrl });
          if (headersParam) proxyParams.set('headers', headersParam);
          return `${PROXY_HOST}/proxy?${proxyParams.toString()}`;
        }).join('\n');

        playlistCache.set(targetUrl, { content: rewritten, fetchedAt: Date.now() });

        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store'
        });
        res.end(rewritten);
      } else {
        res.writeHead(upstream.status, {
          'Content-Type': contentType || 'video/mp2t',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          ...(upstream.headers['content-length'] ? { 'Content-Length': upstream.headers['content-length'] } : {})
        });
        req.on('close', () => upstream.data.destroy());
        upstream.data.on('error', (err) => {
          log(`PROXY PIPE ERROR: ${err.message}`);
          if (!res.writableEnded) res.end();
        });
        upstream.data.pipe(res);
      }
    } catch (err) {
      const status = err.response?.status;
      const isTokenExpiry = status === 403 || status === 401;
      const isRateLimit = status === 429;
      const isMissing = status === 404;
      const label = isTokenExpiry ? 'TOKEN/AUTH EXPIRED'
        : isRateLimit ? 'RATE LIMITED'
          : isMissing ? 'STREAM GONE (404)'
            : err.code === 'ECONNABORTED' ? `TIMEOUT [${timeout}ms]`
              : err.code || 'UPSTREAM ERROR';
      log(`PROXY ${label} ${targetUrl.slice(0, 80)}: ${err.message}`);
      if (isTokenExpiry || isRateLimit) {
        playlistCache.delete(targetUrl);
        log(`Cleared playlist cache for ${targetUrl.slice(0, 60)} to force fresh token`);
      }
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream fetch failed', detail: err.message }));
      }
    }
    return;
  }
  if (req.url === '/manifest.json' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });

    const dynamicManifest = JSON.parse(JSON.stringify(manifest));
    if (!ENABLE_ADULT) {
      dynamicManifest.catalogs = dynamicManifest.catalogs.filter(cat => cat.id !== 'freevie_adult');
    }
    dynamicManifest.catalogs.forEach(cat => {
      const genreExtra = cat.extra.find(e => e.name === 'genre');
      if (genreExtra) genreExtra.options = allGenres;
    });

    res.end(JSON.stringify(dynamicManifest));
    return;
  }

  try {
    const cleanUrl = decodeURIComponent(req.url);
    const match = cleanUrl.match(/^\/(catalog|meta|stream)\/([^/]+)\/([^/]+?)(?:\/([^/]+?))?\.json$/);

    if (match) {
      const [, resource, type, id, extraStr] = match;

      const extra = {};
      if (extraStr) {
        extraStr.split('&').forEach(pair => {
          const eqIdx = pair.indexOf('=');
          if (eqIdx !== -1) {
            extra[pair.substring(0, eqIdx)] = pair.substring(eqIdx + 1);
          }
        });
      }

      const result = await addonInterface.get(resource, type, id, extra);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
  } catch (err) {
    log(`ERROR: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

async function start() {
  log('Freevie starting up...');

  await refreshChannels();

  if (HEALTH_CHECK_INTERVAL > 0) {
    setInterval(() => {
      runHealthCheck().catch(err => log(`Scheduled health check failed: ${err.message}`));
    }, HEALTH_CHECK_INTERVAL);
  }

  server.listen(PORT, () => {
    log(`Freevie Live TV addon running at http://localhost:${PORT}`);
    log(`Install URL: http://YOUR_SERVER_IP:${PORT}/manifest.json`);
    log(`Health check: http://localhost:${PORT}/health`);
  });
}

start().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
