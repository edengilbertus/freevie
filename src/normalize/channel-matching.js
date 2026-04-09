function findAlternativeChannels(primary, pool) {
  return pool.filter((channel) => {
    if (!channel || channel.id === primary.id) return false;
    if (channel.canonicalId && primary.canonicalId && channel.canonicalId === primary.canonicalId) {
      return true;
    }
    return channel.normalizedName && primary.normalizedName && channel.normalizedName === primary.normalizedName;
  });
}

module.exports = {
  findAlternativeChannels
};
