const { rankChannels } = require('../normalize/channel-ranking');

function matchesGenre(channel, genre) {
  if (!genre) return true;
  const target = String(genre).toLowerCase();
  return (channel.groups || []).some((group) => String(group).toLowerCase() === target);
}

function matchesSearch(channel, search) {
  if (!search) return true;
  const query = String(search).toLowerCase();
  return [channel.displayName, channel.name]
    .some((value) => String(value || '').toLowerCase().includes(query));
}

function buildCatalogPage(channels, options = {}) {
  const filtered = channels
    .filter((channel) => matchesGenre(channel, options.genre))
    .filter((channel) => matchesSearch(channel, options.search));

  const ranked = rankChannels(filtered, options.rankContext || {});
  const skip = Number.parseInt(options.skip, 10) || 0;
  const pageSize = options.pageSize || 100;
  return ranked.slice(skip, skip + pageSize);
}

module.exports = {
  buildCatalogPage,
  matchesGenre,
  matchesSearch
};
