function createChannelRecord(data) {
  return {
    id: data.id,
    sourceId: data.sourceId,
    sourceType: data.sourceType || 'm3u',
    tvgId: data.tvgId || null,
    name: data.name,
    normalizedName: data.normalizedName,
    canonicalId: data.canonicalId,
    url: data.url,
    logo: data.logo || '',
    poster: data.poster || data.logo || '',
    groups: data.groups || [],
    primaryGroup: data.primaryGroup || 'General',
    country: data.country || data.sourceId || 'global',
    quality: data.quality || null,
    extraHeaders: data.extraHeaders || null,
    healthy: data.healthy !== false,
    contentType: data.contentType || null,
    lastHealthAt: data.lastHealthAt || null,
    lastHealthError: data.lastHealthError || null,
    responseMs: data.responseMs || null,
    isAdult: Boolean(data.isAdult)
  };
}

module.exports = {
  createChannelRecord
};