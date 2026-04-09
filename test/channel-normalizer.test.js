const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeChannel } = require('../src/normalize/channel-normalizer');

test('normalizeChannel derives stable names, groups, and artwork fields', () => {
  const channel = normalizeChannel({
    id: 'us_espn_1',
    sourceId: 'us',
    sourceType: 'm3u',
    tvgId: 'espn.us',
    name: '  ESPN 1 HD  ',
    url: 'https://example.com/live/espn1.m3u8',
    logo: 'https://img.example.com/espn.png',
    groups: ['Sports', 'Live Sports', 'Sports'],
    country: 'us',
    extraHeaders: { referer: 'https://guide.example.com' }
  });

  assert.equal(channel.name, 'ESPN 1 HD');
  assert.equal(channel.normalizedName, 'espn 1');
  assert.equal(channel.canonicalId, 'espn_1');
  assert.deepEqual(channel.groups, ['Sports', 'Live Sports']);
  assert.equal(channel.primaryGroup, 'Sports');
  assert.equal(channel.poster, 'https://img.example.com/espn.png');
  assert.equal(channel.logo, 'https://img.example.com/espn.png');
  assert.equal(channel.extraHeaders.referer, 'https://guide.example.com');
  assert.equal(channel.isAdult, false);
});

test('normalizeChannel infers adult and fallback group labels', () => {
  const channel = normalizeChannel({
    id: 'adult_midnight',
    sourceId: 'adult',
    sourceType: 'm3u',
    name: 'Midnight XXX 4K',
    url: 'https://example.com/live/adult.m3u8',
    groups: [],
    country: 'adult'
  });

  assert.equal(channel.normalizedName, 'midnight');
  assert.equal(channel.primaryGroup, 'Adult');
  assert.equal(channel.isAdult, true);
});

test('normalizeChannel upgrades noisy movie groups into curated primary categories', () => {
  const channel = normalizeChannel({
    sourceId: 'us',
    sourceType: 'm3u',
    name: 'Cinema Central',
    url: 'https://example.com/live/cinema.m3u8',
    groups: ['24/7 Movies', 'Cinema'],
    country: 'us'
  });

  assert.equal(channel.primaryGroup, 'Movies');
  assert.deepEqual(channel.groups, ['Movies', '24/7 Movies', 'Cinema']);
});
