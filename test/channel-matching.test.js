const test = require('node:test');
const assert = require('node:assert/strict');

const { findAlternativeChannels } = require('../src/normalize/channel-matching');

test('findAlternativeChannels prefers same canonical or normalized names', () => {
  const primary = {
    id: 'us_espn_us',
    canonicalId: 'espn_1',
    normalizedName: 'espn 1',
    quality: 'HD',
    responseMs: 900,
    healthy: true
  };
  const pool = [
    primary,
    {
      id: 'ca_espn_1_backup',
      canonicalId: 'espn_1',
      normalizedName: 'espn 1',
      quality: 'FHD',
      responseMs: 1100,
      healthy: true
    },
    {
      id: 'ug_espn_one',
      canonicalId: 'espn_one',
      normalizedName: 'espn 1',
      quality: 'HD',
      responseMs: 700,
      healthy: true
    },
    {
      id: 'us_espnews',
      canonicalId: 'espnews',
      normalizedName: 'espnews',
      quality: 'HD',
      responseMs: 500,
      healthy: true
    }
  ];

  const alternatives = findAlternativeChannels(primary, pool);

  assert.deepEqual(
    alternatives.map((channel) => channel.id),
    ['ca_espn_1_backup', 'ug_espn_one']
  );
});
