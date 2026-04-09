const { createChannelRecord } = require('../models/channel');
const { enrichChannelCategory } = require('./channel-ranking');

const ADULT_KEYWORD_REGEX = /\b(adult|xxx|18\+|porn|sex|erotic)\b/i;
const QUALITY_REGEX = /\b(2160p|4k|uhd|1080p|fhd|720p|hd|480p|sd|360p|240p)\b/ig;
const ADULT_LABEL_REGEX = /\b(adult|xxx|porn|sex|erotic)\b/ig;
const DISPLAY_NAME_NOISE_REGEX = /\b(?:geo(?:\s|-)?blocked|backup(?:\s*feed)?|feed|test(?:ing)?|not\s*24\/7|24\/7|hevc|h\.?265|h\.?264|hdr|vip|server\s*\d+|multi(?:ple)?\s*audio|audio)\b/ig;
const TRAILING_REGION_REGEX = /\b(?:us|usa|uk|gb|ca|canada|ug|uganda|ke|kenya|ng|nigeria|za|africa|south\s+africa)\b$/i;

function collapseWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectQuality(name) {
  if (/2160p|4k|uhd/i.test(name)) return '4K';
  if (/1080p|fhd/i.test(name)) return 'FHD';
  if (/720p|hd/i.test(name)) return 'HD';
  if (/480p|sd/i.test(name)) return 'SD';
  if (/360p/i.test(name)) return '360p';
  if (/240p/i.test(name)) return '240p';
  return null;
}

function normalizeGroups(groups, fallbackGroup) {
  const list = Array.isArray(groups)
    ? groups
    : String(groups || '')
      .split(/[,;|]/)
      .map((group) => group.trim())
      .filter(Boolean);

  const normalized = [];
  const seen = new Set();
  list.forEach((group) => {
    const value = collapseWhitespace(group);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return;
    seen.add(key);
    normalized.push(value);
  });

  if (normalized.length > 0) return normalized;
  return [fallbackGroup];
}

function normalizeChannelName(name) {
  const cleaned = cleanChannelDisplayName(name)
    .replace(QUALITY_REGEX, ' ')
    .replace(ADULT_LABEL_REGEX, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');

  return collapseWhitespace(cleaned).toLowerCase();
}

function cleanChannelDisplayName(name) {
  const raw = collapseWhitespace(name);
  let cleaned = raw
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/\([^)]*]/g, ' ')
    .replace(QUALITY_REGEX, ' ')
    .replace(DISPLAY_NAME_NOISE_REGEX, ' ')
    .replace(/[_|]+/g, ' ')
    .replace(/\s*[-–:]\s*/g, ' ')
    .replace(/[^\p{L}\p{N}.&+]+/gu, ' ');

  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(TRAILING_REGION_REGEX, ' ');
    cleaned = collapseWhitespace(cleaned);
  } while (cleaned !== previous);

  cleaned = collapseWhitespace(cleaned);
  return cleaned || raw;
}

function sanitizeExternalId(tvgId) {
  return collapseWhitespace(tvgId || '')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function deriveCanonicalId(normalizedName) {
  return normalizedName.replace(/\s+/g, '_');
}

function deriveRuntimeId(sourceId, tvgId, canonicalId) {
  const externalId = sanitizeExternalId(tvgId);
  if (externalId) return `${sourceId}_${externalId}`;
  return `${sourceId}_${canonicalId}`;
}

function normalizeChannel(input) {
  const rawName = collapseWhitespace(input.name || input.tvgName || 'Unknown');
  const displayName = cleanChannelDisplayName(rawName);
  const quality = input.quality || detectQuality(rawName);
  const normalizedName = normalizeChannelName(rawName);
  const isAdult = input.isAdult === true || ADULT_KEYWORD_REGEX.test(`${rawName} ${String(input.groups || '')}`);
  const groups = normalizeGroups(input.groups, isAdult ? 'Adult' : 'General');
  const canonicalId = deriveCanonicalId(normalizedName);
  const sourceId = input.sourceId || input.country || 'global';

  return enrichChannelCategory(createChannelRecord({
    id: input.id || deriveRuntimeId(sourceId, input.tvgId, canonicalId),
    sourceId,
    sourceType: input.sourceType || 'm3u',
    tvgId: input.tvgId || null,
    name: rawName,
    displayName,
    normalizedName,
    canonicalId,
    url: input.url,
    logo: input.logo || '',
    poster: input.poster || input.logo || '',
    groups,
    primaryGroup: groups[0] || (isAdult ? 'Adult' : 'General'),
    country: input.country || sourceId,
    quality,
    extraHeaders: input.extraHeaders || null,
    healthy: input.healthy,
    contentType: input.contentType,
    lastHealthAt: input.lastHealthAt,
    lastHealthError: input.lastHealthError,
    responseMs: input.responseMs,
    isAdult
  }));
}

module.exports = {
  ADULT_KEYWORD_REGEX,
  cleanChannelDisplayName,
  detectQuality,
  normalizeChannel,
  normalizeChannelName
};
