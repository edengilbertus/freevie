const CATEGORY_PRIORITY = [
  'Sports',
  'Movies',
  'News',
  'Kids',
  'Entertainment',
  'Music',
  'Documentary',
  'Lifestyle',
  'Faith',
  'Adult',
  'General'
];

const CATEGORY_RULES = [
  { category: 'Sports', patterns: [
    // Generic
    'sports', 'sport', 'football', 'soccer', 'ufc', 'boxing', 'fight', 'cricket', 'tennis',
    'golf', 'motorsport', 'formula', 'f1', 'rugby', 'cycling', 'athletics',
    // US / Canada
    'nba', 'nfl', 'mlb', 'nhl',
    // UK / Europe sports brands
    'espn', 'bein', 'bein sports', 'sky sports', 'tnt sports', 'bt sport', 'bt sports',
    'premier sports', 'eurosport', 'dazn', 'eleven sports', 'eleven',
    'canal+ sport', 'canal plus sport', 'movistar+', 'movistar laliga',
    'mediaset sport', 'sport italia', 'sky sport', 'sport 1', 'sport 2',
    'la liga tv', 'laliga tv', 'serie a', 'ligue 1',
    // African / Arabic sports
    'supersport', 'super sport', 'ssc', 'osn sports', 'startimes sport',
    'azam sport', 'wazito sport', 'canal+ afrique', 'arab sport',
    // European leagues
    'champions league', 'europa league', 'conference league', 'premier league',
    'bundesliga', 'fa cup', 'eredivisie', 'primeira liga', 'segunda liga'
  ]},
  { category: 'Movies', patterns: ['movie', 'movies', 'cinema', 'film', 'films', 'hbo', 'showtime', 'cinemax', 'cinestar', 'kino'] },
  { category: 'News', patterns: ['news', 'cnn', 'bbc', 'al jazeera', 'cnbc', 'bloomberg', 'msnbc', 'fox news', 'euronews', 'france 24', 'dw', 'rai news', 'rtl', 'channel 4 news'] },
  { category: 'Kids', patterns: ['kids', 'kid', 'cartoon', 'cartoons', 'cartoon network', 'cartoonito', 'disney', 'disney junior', 'disney xd', 'nick', 'nick jr', 'nickelodeon', 'boomerang', 'baby tv', 'duck tv'] },
  { category: 'Music', patterns: ['music', 'mtv', 'vh1', 'radio'] },
  { category: 'Documentary', patterns: ['documentary', 'history', 'nature', 'science', 'discovery', 'national geographic', 'nat geo', 'docubox'] },
  { category: 'Lifestyle', patterns: ['lifestyle', 'travel', 'food', 'cooking', 'home', 'fashion'] },
  { category: 'Faith', patterns: ['faith', 'christian', 'worship', 'gospel', 'religious'] },
  { category: 'Adult', patterns: ['adult', 'xxx', 'porn', 'erotic'] },
  { category: 'Entertainment', patterns: ['entertainment', 'drama', 'series', 'shows', 'general'] }
];

const GENERIC_NAME_PATTERNS = ['feed', 'backup', 'test', 'trial', 'channel', 'tv'];
const QUALITY_SCORES = { SD: 6, '360p': 4, '240p': 2, HD: 15, FHD: 18, '4K': 20 };
const SPORTS_BRAND_PATTERNS = [
  'supersport',
  'super sport',
  'bein sports',
  'beinsports',
  'sky sports',
  'tnt sports',
  'bt sport',
  'bt sports',
  'premier sports',
  'eurosport',
  'dazn',
  'espn'
];
const KIDS_BRAND_PATTERNS = [
  'disney channel',
  'disney junior',
  'disney xd',
  'cartoon network',
  'cartoonito',
  'boomerang',
  'nickelodeon',
  'nick jr',
  'nicktoons'
];
const FOOTBALL_COMPETITION_PATTERNS = [
  'premier league',
  'fa cup',
  'champions league',
  'europa league',
  'conference league'
];

function normalizeHaystack(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function categorizeChannel(channel) {
  const haystack = [channel.name, ...(channel.groups || [])]
    .map(normalizeHaystack)
    .join(' ');

  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => haystack.includes(pattern))) {
      return rule.category;
    }
  }

  return 'General';
}

function uniqueOrdered(values) {
  const seen = new Set();
  const output = [];
  values.forEach((value) => {
    const label = String(value || '').trim();
    if (!label) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    output.push(label);
  });
  return output;
}

function enrichChannelCategory(channel) {
  const derivedCategory = categorizeChannel(channel);
  const category = derivedCategory === 'General' && channel.primaryGroup
    ? channel.primaryGroup
    : derivedCategory;

  return {
    ...channel,
    primaryGroup: category,
    groups: uniqueOrdered([category, ...(channel.groups || [])])
  };
}

function scoreChannel(channel, context = {}) {
  let score = 0;
  const normalizedName = normalizeHaystack(channel.normalizedName || channel.displayName || channel.name);
  const category = channel.primaryGroup || categorizeChannel(channel);
  const targetGenre = normalizeHaystack(context.genre);
  const sportsBrandMatch = SPORTS_BRAND_PATTERNS.some((pattern) => normalizedName.includes(pattern));
  const kidsBrandMatch = KIDS_BRAND_PATTERNS.some((pattern) => normalizedName.includes(pattern));
  const footballCompetitionMatch = FOOTBALL_COMPETITION_PATTERNS.some((pattern) => normalizedName.includes(pattern));

  if (channel.healthy !== false) score += 40;
  if (channel.poster || channel.logo) score += 28;
  score += QUALITY_SCORES[channel.quality] || 10;

  if (Number.isFinite(channel.responseMs)) {
    if (channel.responseMs < 900) score += 24;
    else if (channel.responseMs < 1800) score += 14;
    else if (channel.responseMs < 3000) score += 6;
  }

  if (category === 'Sports') score += 18;
  if (targetGenre && category.toLowerCase() === targetGenre) score += 26;
  if (sportsBrandMatch) score += 28;
  if (kidsBrandMatch) score += 22;
  if (footballCompetitionMatch) score += 12;
  if (targetGenre === 'sports' && sportsBrandMatch) score += 42;
  if (targetGenre === 'kids' && kidsBrandMatch) score += 34;
  if (context.catalogId === 'freevie_all' && sportsBrandMatch) score += 18;
  if (context.catalogId === 'freevie_all' && kidsBrandMatch) score += 12;

  if (GENERIC_NAME_PATTERNS.some((token) => normalizedName.includes(token))) score -= 12;
  if ((channel.groups || []).length > 1) score += 6;
  if (normalizedName.length >= 8) score += 6;

  return score;
}

function rankChannels(channels, context = {}) {
  return [...channels].sort((left, right) => {
    const scoreDiff = scoreChannel(right, context) - scoreChannel(left, context);
    if (scoreDiff !== 0) return scoreDiff;
    return String(left.name || '').localeCompare(String(right.name || ''));
  });
}

function collectCatalogGenres(channels) {
  const genres = uniqueOrdered(channels.map((channel) => channel.primaryGroup).filter(Boolean));
  return genres.sort((left, right) => {
    const leftIndex = CATEGORY_PRIORITY.indexOf(left);
    const rightIndex = CATEGORY_PRIORITY.indexOf(right);
    const normalizedLeft = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
    const normalizedRight = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
    if (normalizedLeft !== normalizedRight) return normalizedLeft - normalizedRight;
    return left.localeCompare(right);
  });
}

module.exports = {
  CATEGORY_PRIORITY,
  categorizeChannel,
  collectCatalogGenres,
  enrichChannelCategory,
  rankChannels,
  scoreChannel
};
