const test = require('node:test');
const assert = require('node:assert/strict');

const { BUILT_IN_ADULT_PLAYLIST } = require('../src/sources/built-in-adult-playlist');
const { parseM3USource } = require('../src/sources/m3u');

test('built-in adult playlist parses into channels', () => {
  const channels = parseM3USource({
    content: BUILT_IN_ADULT_PLAYLIST,
    sourceId: 'adult_builtin',
    country: 'adult'
  });

  assert.ok(channels.length >= 20);
  assert.equal(channels[0].primaryGroup, 'Adult');
  assert.ok(channels.some((channel) => channel.name === 'AdultIPTV.net MILF'));
  assert.ok(channels.some((channel) => channel.name === 'AdultIPTV.net Asian'));
});
