const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const http = require('http');

// ─── Configuration ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 7000;
const CACHE_TTL = parseInt(process.env.CACHE_TTL) || 60 * 60 * 1000; // 1 hour
const US_M3U_URL = process.env.US_M3U_URL || 'https://iptv-org.github.io/iptv/countries/us.m3u';
const CA_M3U_URL = process.env.CA_M3U_URL || 'https://iptv-org.github.io/iptv/countries/ca.m3u';

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
let allChannels = [];
let allGenres = [];
let lastFetch = 0;

async function refreshChannels() {
  const now = Date.now();
  if (allChannels.length > 0 && now - lastFetch < CACHE_TTL) {
    return;
  }

  log('Fetching fresh channel lists...');

  try {
    const [usRes, caRes] = await Promise.all([
      axios.get(US_M3U_URL, { timeout: 15000 }),
      axios.get(CA_M3U_URL, { timeout: 15000 })
    ]);

    usChannels = parseM3U(usRes.data, 'us');
    caChannels = parseM3U(caRes.data, 'ca');
    allChannels = [...usChannels, ...caChannels];

    // Collect unique genres
    const genreSet = new Set();
    allChannels.forEach(ch => ch.groups.forEach(g => genreSet.add(g)));
    allGenres = [...genreSet].sort();

    lastFetch = now;
    log(`Loaded ${usChannels.length} US + ${caChannels.length} CA = ${allChannels.length} total channels`);
    log(`Found ${allGenres.length} genres: ${allGenres.slice(0, 15).join(', ')}...`);

    // Run async health check on a sample
    runHealthCheck();
  } catch (err) {
    log(`ERROR fetching channels: ${err.message}`);
    // Keep old data if we have it
  }
}

// ─── Health Check (async, non-blocking) ───────────────────────────────────────
async function checkStreamHealth(channel) {
  try {
    await axios.head(channel.url, {
      timeout: 5000,
      maxRedirects: 3,
      headers: channel.extraHeaders || {},
      validateStatus: (status) => status < 500
    });
    channel.healthy = true;
  } catch {
    channel.healthy = false;
  }
}

async function runHealthCheck() {
  // Check a random sample of channels (max 50) to avoid hammering servers
  const sample = allChannels
    .sort(() => Math.random() - 0.5)
    .slice(0, 50);

  log(`Running health check on ${sample.length} channels...`);

  const results = await Promise.allSettled(
    sample.map(ch => checkStreamHealth(ch))
  );

  const healthy = sample.filter(ch => ch.healthy).length;
  log(`Health check complete: ${healthy}/${sample.length} streams responding`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function channelToMeta(ch) {
  const countryFlag = ch.country === 'us' ? '🇺🇸 USA' : '🇨🇦 Canada';
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

function channelToStream(ch) {
  const healthIcon = ch.healthy ? '🟢' : '⚠️';
  const qualityLabel = ch.quality || 'Live';
  const countryLabel = ch.country.toUpperCase();

  const stream = {
    url: ch.url,
    name: `${healthIcon} ${qualityLabel}`,
    title: `${ch.name} — ${countryLabel}`,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: 'freevie-live'
    }
  };

  // Add proxy headers if the stream requires them
  if (ch.extraHeaders) {
    stream.behaviorHints.proxyHeaders = {
      request: ch.extraHeaders
    };
  }

  return stream;
}

// ─── Manifest ─────────────────────────────────────────────────────────────────
const manifest = {
  id: 'community.freevie',
  version: '2.0.0',
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
  else pool = allChannels;

  let filtered = pool;

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

// Stream handler — returns all matching streams for a channel
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

  const streams = [channelToStream(ch)];

  // Add alternatives as extra streams
  alternatives.forEach(alt => {
    const stream = channelToStream(alt);
    stream.name += ' (alt)';
    streams.push(stream);
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

  // Handle manifest with dynamic genre injection
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
