const cacheConfig = {
  SEGMENT_CACHE_TTL: 90 * 1000,
  PREFETCH_COUNT: 10,
  PLAYLIST_CACHE_TTL: 4 * 1000,
  MAX_CONCURRENT_PREFETCHES: 6,
  HEALTH_BATCH_SIZE: 30
};

const runtimeState = {
  usChannels: [],
  caChannels: [],
  ugChannels: [],
  adultChannels: [],
  allChannels: [],
  allGenres: [],
  lastFetch: 0,
  segmentCache: new Map(),
  playlistCache: new Map(),
  activePrefetches: 0,
  healthCheckDone: false,
  healthCheckRunning: false,
  lastHealthCheckAt: 0
};

function syncRuntimeState(patch) {
  Object.assign(runtimeState, patch);
}

module.exports = {
  cacheConfig,
  runtimeState,
  syncRuntimeState
};
