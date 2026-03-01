const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const http = require('http');
const https = require('https');

// ─── Persistent HTTP agents (keep-alive connection pooling) ───────────────────
// Reuse TCP connections to CDNs instead of a new handshake per segment.
// Each connection saved = ~50-200ms latency cut per segment request.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 3000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 3000 });

// ─── Configuration ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 60 * 60 * 1000; // 1 hour
const US_M3U_URL = process.env.US_M3U_URL || 'https://iptv-org.github.io/iptv/countries/us.m3u';
const CA_M3U_URL = process.env.CA_M3U_URL || 'https://iptv-org.github.io/iptv/countries/ca.m3u';
const ADULT_M3U_URL = process.env.ADULT_M3U_URL || 'https://iptv-org.github.io/iptv/categories/xxx.m3u';
// When set, all stream URLs are routed through this server as a relay proxy.
// Example: PROXY_HOST=http://123.45.67.89:7000
// Leave unset to serve original CDN URLs directly (local dev default).
const PROXY_HOST = process.env.PROXY_HOST ? process.env.PROXY_HOST.replace(/\/$/, '') : null;

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ─── M3U Parser ───────────────────────────────────────────────────────────────
function detectQuality(name) {
  if (/2160p|4k|uhd/i.test(name)) return '4K';
  if (/1080p|fhd/i.test(name)) return 'FHD';
  if (/720p|hd/i.test(name)) return 'HD';
  if (/480p|sd/i.test(name)) return 'SD';
  if (/360p/i.test(name)) return '360p';
  if (/240p/i.test(name)) return '240p';
  return null;
}

function parseM3U(content, country) {
  const channels = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXTINF')) continue;

    // Check for VLC options on next lines, skip them to find URL
    let urlLine = null;
    let extraHeaders = {};
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const nextLine = lines[j].trim();
      if (nextLine.startsWith('#EXTVLCOPT:http-referrer=')) {
        extraHeaders.referer = nextLine.replace('#EXTVLCOPT:http-referrer=', '');
      } else if (nextLine.startsWith('#EXTVLCOPT:http-user-agent=')) {
        extraHeaders['user-agent'] = nextLine.replace('#EXTVLCOPT:http-user-agent=', '');
      } else if (nextLine.startsWith('http')) {
        urlLine = nextLine;
        break;
      } else if (!nextLine.startsWith('#')) {
        break; // Not a comment/option, and not a URL — stop
      }
    }

    if (!urlLine) continue;

    const nameMatch = line.match(/,(.+)$/);
    const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
    if (!name || name === 'Unknown') continue;

    const idMatch = line.match(/tvg-id="([^"]+)"/);
    const rawId = idMatch ? idMatch[1] : name;
    const id = rawId.toLowerCase().replace(/[^a-z0-9]/g, '_');

    const logoMatch = line.match(/tvg-logo="([^"]+)"/);
    const logo = logoMatch ? logoMatch[1] : '';

    const groupMatch = line.match(/group-title="([^"]+)"/);
    const groupRaw = groupMatch ? groupMatch[1] : 'General';
    // Split semicolon-separated groups
    const groups = groupRaw.split(';').map(g => g.trim()).filter(Boolean);

    const quality = detectQuality(name);

    channels.push({
      id: `${country}_${id}`,
      name,
      url: urlLine,
      logo,
      groups,
      primaryGroup: groups[0] || 'General',
      country,
      quality,
      extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : null,
      healthy: true // assume healthy until checked
    });
  }

  return channels;
}

// ─── Channel Store ────────────────────────────────────────────────────────────
let usChannels = [];
let caChannels = [];
let adultChannels = [];
let allChannels = [];
let allGenres = [];
let lastFetch = 0;

// ─── Segment Pre-fetch Cache ─────────────────────────────────────────────────
// When a playlist is served, the next PREFETCH_COUNT segments are downloaded
// immediately in the background. Cache hits are served from memory — zero CDN latency.
const segmentCache = new Map(); // url -> { data: Buffer, contentType, fetchedAt }
const SEGMENT_CACHE_TTL = 90 * 1000; // 90s — deeper buffer for live TV
const PREFETCH_COUNT = 10;         // segments to pre-fetch ahead (~20-60s of video)

// ─── Playlist Cache ───────────────────────────────────────────────────────────
// Stremio polls the .m3u8 playlist every 2s. Cache the rewritten playlist for
// 4s to cut CDN hits by ~50% with zero quality impact.
const playlistCache = new Map(); // url -> { content, fetchedAt }
const PLAYLIST_CACHE_TTL = 4 * 1000; // 4s

// ─── Concurrent Prefetch Limiter ──────────────────────────────────────────────
// Prevent CDN/server overload when multiple viewers are active simultaneously.
const MAX_CONCURRENT_PREFETCHES = 6;
let activePrefetches = 0;

// Evict stale entries every 30 seconds
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

const PROXY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive'
};

async function prefetchSegments(urls, extraHeaders) {
  for (const url of urls) {
    if (segmentCache.has(url)) continue; // already cached or in-flight
    if (activePrefetches >= MAX_CONCURRENT_PREFETCHES) break; // don't overload CDN
    segmentCache.set(url, null); // placeholder to prevent duplicate fetches
    activePrefetches++;
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
    }).finally(() => { activePrefetches--; });
  }
}

async function refreshChannels() {
  const now = Date.now();
  if (allChannels.length > 0 && now - lastFetch < CACHE_TTL) {
    return;
  }

  log('Fetching fresh channel lists...');

  try {
    const [usRes, caRes, adultRes] = await Promise.all([
      axios.get(US_M3U_URL, { timeout: 15000 }),
      axios.get(CA_M3U_URL, { timeout: 15000 }),
      axios.get(ADULT_M3U_URL, { timeout: 15000 }).catch(e => { log(`Adult fetch failed: ${e.message}`); return null; })
    ]);

    usChannels = parseM3U(usRes.data, 'us');
    caChannels = parseM3U(caRes.data, 'ca');
    adultChannels = adultRes ? parseM3U(adultRes.data, 'adult') : [];
    allChannels = [...usChannels, ...caChannels, ...adultChannels];

    // Collect unique genres
    const genreSet = new Set();
    allChannels.forEach(ch => ch.groups.forEach(g => genreSet.add(g)));
    allGenres = [...genreSet].sort();

    lastFetch = now;
    log(`Loaded ${usChannels.length} US + ${caChannels.length} CA + ${adultChannels.length} Adult = ${allChannels.length} total channels`);
    log(`Found ${allGenres.length} genres: ${allGenres.slice(0, 15).join(', ')}...`);

    // Run async health check on a sample
    runHealthCheck();
  } catch (err) {
    log(`ERROR fetching channels: ${err.message}`);
    // Keep old data if we have it
  }
}

// ─── Health Check ─────────────────────────────────────────────────────────────
let healthCheckDone = false;

async function checkStreamHealth(channel) {
  const start = Date.now();
  try {
    await axios.head(channel.url, {
      timeout: 6000,
      maxRedirects: 3,
      headers: channel.extraHeaders || {},
      validateStatus: (status) => status < 500
    });
    channel.healthy = true;
    channel.responseMs = Date.now() - start;
  } catch {
    channel.healthy = false;
    channel.responseMs = 99999;
  }
}

// Run in batches to avoid hammering servers but still check ALL channels
async function runHealthCheck() {
  const BATCH = 30;
  const channels = [...allChannels];
  log(`Running health check on all ${channels.length} channels in batches of ${BATCH}...`);

  for (let i = 0; i < channels.length; i += BATCH) {
    const batch = channels.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(ch => checkStreamHealth(ch)));
  }

  const healthy = allChannels.filter(ch => ch.healthy).length;
  const pct = Math.round((healthy / allChannels.length) * 100);
  log(`Health check complete: ${healthy}/${allChannels.length} (${pct}%) streams live`);
  healthCheckDone = true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function channelToMeta(ch) {
  const countryFlag = ch.country === 'us' ? '🇺🇸 USA' : ch.country === 'ca' ? '🇨🇦 Canada' : '🔞 Adult';
  const qualityBadge = ch.quality ? ` (${ch.quality})` : '';

  return {
    id: `freevie:${ch.id}`,
    type: 'tv',
    name: ch.name,
    poster: ch.logo || undefined,
    logo: ch.logo || undefined,
    posterShape: 'square',
    description: `Live TV: ${ch.name}${qualityBadge} — ${countryFlag}`,
    genres: [ch.primaryGroup, countryFlag],
    links: [],
    background: ch.logo || undefined
  };
}

// Build a proxied URL that routes through our relay server
function buildProxyUrl(originalUrl, extraHeaders) {
  if (!PROXY_HOST) return originalUrl;
  const params = new URLSearchParams({ url: originalUrl });
  if (extraHeaders) params.set('headers', JSON.stringify(extraHeaders));
  return `${PROXY_HOST}/proxy?${params.toString()}`;
}

function channelToStream(ch) {
  const healthIcon = ch.healthy ? '🟢' : '⚠️';
  const qualityLabel = ch.quality || 'Live';
  const countryLabel = ch.country.toUpperCase();
  const speedLabel = ch.responseMs && ch.responseMs < 99999
    ? ` • ${ch.responseMs}ms`
    : '';
  const relayLabel = PROXY_HOST ? ' [Relay]' : '';

  // Route through relay proxy when PROXY_HOST is configured
  const streamUrl = buildProxyUrl(ch.url, ch.extraHeaders);

  const stream = {
    url: streamUrl,
    name: `${healthIcon} ${qualityLabel}${speedLabel}${relayLabel}`,
    description: `${ch.name} — ${countryLabel}`,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: 'freevie-live'
    }
  };

  return stream;
}

// ─── Manifest ─────────────────────────────────────────────────────────────────
const manifest = {
  id: 'community.freevie',
  version: '2.1.0',
  name: 'Freevie — Live TV',
  description: 'Free live TV channels from USA & Canada. Open source, self-hostable.',
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'freevie_us',
      name: '🇺🇸 USA TV',
      extra: [
        { name: 'genre', isRequired: false, options: [] },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'tv',
      id: 'freevie_ca',
      name: '🇨🇦 Canada TV',
      extra: [
        { name: 'genre', isRequired: false, options: [] },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'tv',
      id: 'freevie_adult',
      name: '🔞 Adult',
      extra: [
        { name: 'genre', isRequired: false, options: [] },
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'tv',
      id: 'freevie_all',
      name: '📺 All Channels',
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

// ─── Addon Builder ────────────────────────────────────────────────────────────
const builder = new addonBuilder(manifest);

// Catalog handler
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  if (type !== 'tv') return { metas: [] };

  await refreshChannels();

  let pool;
  if (id === 'freevie_us') pool = usChannels;
  else if (id === 'freevie_ca') pool = caChannels;
  else if (id === 'freevie_adult') pool = adultChannels;
  else pool = allChannels;

  let filtered = pool;

  // If health check is done, filter out dead streams from catalog
  if (healthCheckDone) {
    filtered = filtered.filter(ch => ch.healthy);
  }

  // Genre filter
  if (extra?.genre) {
    const genre = extra.genre.toLowerCase();
    filtered = filtered.filter(ch =>
      ch.groups.some(g => g.toLowerCase() === genre)
    );
  }

  // Search filter
  if (extra?.search) {
    const query = extra.search.toLowerCase();
    filtered = filtered.filter(ch =>
      ch.name.toLowerCase().includes(query)
    );
  }

  // Pagination
  const skip = parseInt(extra?.skip) || 0;
  const PAGE_SIZE = 100;
  const page = filtered.slice(skip, skip + PAGE_SIZE);

  return { metas: page.map(channelToMeta) };
});

// Meta handler
builder.defineMetaHandler(async ({ type, id }) => {
  if (type !== 'tv' || !id.startsWith('freevie:')) return { meta: null };

  await refreshChannels();

  const channelId = id.replace('freevie:', '');
  const ch = allChannels.find(c => c.id === channelId);
  if (!ch) return { meta: null };

  return { meta: channelToMeta(ch) };
});

// Stream handler — returns all matching streams sorted fastest-first
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'tv' || !id.startsWith('freevie:')) return { streams: [] };

  await refreshChannels();

  const channelId = id.replace('freevie:', '');
  const ch = allChannels.find(c => c.id === channelId);
  if (!ch) return { streams: [] };

  // Find all channels with similar names for alternative feeds
  const baseName = ch.name.replace(/\s*\(.*?\)\s*/g, '').trim().toLowerCase();
  const alternatives = allChannels.filter(alt => {
    const altBase = alt.name.replace(/\s*\(.*?\)\s*/g, '').trim().toLowerCase();
    return altBase === baseName && alt.id !== ch.id;
  });

  // Combine primary + alternatives, then sort for best stability
  // Priority: healthy > fast response > prefer HD (FHD/4K freezes on free CDNs)
  const QUALITY_SCORE = { 'SD': 0, '360p': 1, '240p': 2, 'HD': 3, 'FHD': 4, '4K': 5 };

  const candidates = [ch, ...alternatives]
    // Drop streams that are dead OR took >3s to respond (will freeze/buffer badly)
    .filter(c => c.healthy && (c.responseMs || 0) < 3000)
    .sort((a, b) => {
      // Faster response always wins
      const msDiff = (a.responseMs || 99999) - (b.responseMs || 99999);
      // Penalise FHD/4K: free CDNs can't sustain high bitrates reliably
      const aQ = QUALITY_SCORE[a.quality] ?? 3; // unknown = treat as HD
      const bQ = QUALITY_SCORE[b.quality] ?? 3;
      // If one is HD and the other is FHD/4K, prefer HD if response is similar
      const qualityPenalty = (aQ > 3 ? 500 : 0) - (bQ > 3 ? 500 : 0);
      return msDiff + qualityPenalty;
    });

  // Fallback: if all streams got filtered, include unhealthy ones rather than returning nothing
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

// ─── Server with Health Endpoint ──────────────────────────────────────────────
const addonInterface = builder.getInterface();

// Create a custom server that handles /health and delegates the rest to the SDK
const server = http.createServer(async (req, res) => {
  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check endpoint
  if (req.url === '/health') {
    const healthData = {
      status: 'ok',
      version: manifest.version,
      proxy: PROXY_HOST ? { enabled: true, host: PROXY_HOST } : { enabled: false },
      channels: {
        us: usChannels.length,
        ca: caChannels.length,
        total: allChannels.length
      },
      genres: allGenres.length,
      lastRefresh: lastFetch ? new Date(lastFetch).toISOString() : null,
      uptime: process.uptime()
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthData, null, 2));
    return;
  }

  // ─── Stream Proxy Relay ───────────────────────────────────────────────────────
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

    // ── Playlist cache hit: serve rewritten .m3u8 from memory (no CDN round-trip) ──
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

    // ── Segment cache hit: serve segment from memory instantly, no CDN round-trip ──
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

    // Shorter timeout for segments, longer for playlists
    const isSegment = /\.(ts|aac|mp4|m4s|cmfv|cmfa)(\?|$)/i.test(targetUrl);
    const timeout = isSegment ? 6000 : 12000;

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

        // Collect original segment URLs for pre-fetching BEFORE rewriting
        const toPreFetch = playlist.split('\n')
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'))
          .map(l => { try { return new URL(l, baseDir).href; } catch (_) { return null; } })
          .filter(Boolean)
          .slice(0, PREFETCH_COUNT);

        // Fire-and-forget: start downloading next segments immediately
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

        // Cache the rewritten playlist for 4s — Stremio polls every 2s so this
        // halves CDN hits with no quality impact on live streams.
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
      log(`PROXY ERROR [${timeout}ms] ${targetUrl.slice(0, 80)}: ${err.message}`);
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
    dynamicManifest.catalogs.forEach(cat => {
      const genreExtra = cat.extra.find(e => e.name === 'genre');
      if (genreExtra) genreExtra.options = allGenres;
    });

    res.end(JSON.stringify(dynamicManifest));
    return;
  }

  // Delegate all other requests to the Stremio addon SDK
  // addonInterface.get(resource, type, id, extra) is the SDK's routing method
  try {
    const cleanUrl = decodeURIComponent(req.url);
    const match = cleanUrl.match(/^\/(catalog|meta|stream)\/([^/]+)\/([^/]+?)(?:\/([^/]+?))?\.json$/);

    if (match) {
      const [, resource, type, id, extraStr] = match;

      // Parse extras
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

  // Fallback 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
  log('Freevie starting up...');

  // Pre-fetch channels before server starts
  await refreshChannels();

  server.listen(PORT, () => {
    log(`✅ Freevie Live TV addon running at http://localhost:${PORT}`);
    log(`📺 Install URL: http://YOUR_SERVER_IP:${PORT}/manifest.json`);
    log(`❤️  Health check: http://localhost:${PORT}/health`);
  });
}

start().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
