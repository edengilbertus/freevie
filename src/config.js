const http = require('http');
const https = require('https');

function envFlag(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function envInt(name, defaultValue) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseUrlList(rawValue) {
  if (!rawValue) return [];
  const urls = String(rawValue)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^https?:\/\//i.test(part));
  return [...new Set(urls)];
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 3000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 3000 });

const PORT = process.env.PORT || 7000;
const CACHE_TTL = envInt('CACHE_TTL', 60 * 60 * 1000);
const US_M3U_URL = process.env.US_M3U_URL || 'https://iptv-org.github.io/iptv/countries/us.m3u';
const CA_M3U_URL = process.env.CA_M3U_URL || 'https://iptv-org.github.io/iptv/countries/ca.m3u';
const UG_M3U_URL = process.env.UG_M3U_URL || 'https://iptv-org.github.io/iptv/countries/ug.m3u';
const DEFAULT_EXTRA_M3U_URLS = [
  'https://iptv-org.github.io/iptv/countries/gb.m3u',
  'https://iptv-org.github.io/iptv/countries/ke.m3u',
  'https://iptv-org.github.io/iptv/countries/ng.m3u',
  'https://iptv-org.github.io/iptv/countries/za.m3u'
];
const EXTRA_M3U_URLS = (() => {
  const configuredList = parseUrlList(process.env.EXTRA_M3U_URLS);
  if (configuredList.length > 0) return configuredList;
  return DEFAULT_EXTRA_M3U_URLS;
})();
const LEGACY_ADULT_M3U_URL = process.env.ADULT_M3U_URL ? process.env.ADULT_M3U_URL.trim() : '';
const DEFAULT_ADULT_M3U_URLS = [
  'https://raw.githubusercontent.com/sacuar/MyIPTV/main/Play1.m3u',
  'https://iptvmate.net/files/adult.m3u'
];
const ADULT_M3U_URLS = (() => {
  const configuredList = parseUrlList(process.env.ADULT_M3U_URLS);
  if (configuredList.length > 0) return configuredList;
  if (/^https?:\/\//i.test(LEGACY_ADULT_M3U_URL)) return [LEGACY_ADULT_M3U_URL];
  return DEFAULT_ADULT_M3U_URLS;
})();
const ENABLE_ADULT = envFlag('ENABLE_ADULT', true);
const HEALTH_FILTER = envFlag('HEALTH_FILTER', true);
const STRICT_IPTV_VALIDATION = envFlag('STRICT_IPTV_VALIDATION', false);
const HEALTH_CHECK_INTERVAL = envInt('HEALTH_CHECK_INTERVAL', 30 * 60 * 1000);
const PROXY_HOST = process.env.PROXY_HOST ? process.env.PROXY_HOST.replace(/\/$/, '') : null;

const IPTV_VALID_CONTENT_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'video/mp2t',
  'application/octet-stream',
  'application/dash+xml'
]);

const PROXY_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive'
};

module.exports = {
  envFlag,
  envInt,
  parseUrlList,
  httpAgent,
  httpsAgent,
  PORT,
  CACHE_TTL,
  US_M3U_URL,
  CA_M3U_URL,
  UG_M3U_URL,
  DEFAULT_EXTRA_M3U_URLS,
  EXTRA_M3U_URLS,
  LEGACY_ADULT_M3U_URL,
  DEFAULT_ADULT_M3U_URLS,
  ADULT_M3U_URLS,
  ENABLE_ADULT,
  HEALTH_FILTER,
  STRICT_IPTV_VALIDATION,
  HEALTH_CHECK_INTERVAL,
  PROXY_HOST,
  IPTV_VALID_CONTENT_TYPES,
  PROXY_HEADERS
};
