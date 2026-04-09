const test = require('node:test');
const assert = require('node:assert/strict');

const {
  categorizeChannel,
  collectCatalogGenres,
  rankChannels
} = require('../src/normalize/channel-ranking');

test('categorizeChannel maps noisy raw groups to curated categories', () => {
  const channel = categorizeChannel({
    name: 'Cinema Central',
    groups: ['24/7 Movies', 'Cinema']
  });

  assert.equal(channel, 'Movies');
});

test('rankChannels promotes stronger branded channels for sports surfaces', () => {
  const ranked = rankChannels(
    [
      {
        id: 'weak',
        name: 'Sports Feed 9',
        primaryGroup: 'Sports',
        groups: ['Sports'],
        quality: 'SD',
        healthy: true,
        responseMs: 2800,
        poster: '',
        logo: ''
      },
      {
        id: 'strong',
        name: 'ESPN 1 HD',
        primaryGroup: 'Sports',
        groups: ['Sports', 'Live Sports'],
        quality: 'HD',
        healthy: true,
        responseMs: 700,
        poster: 'https://img.example.com/espn.png',
        logo: 'https://img.example.com/espn.png'
      }
    ],
    { catalogId: 'freevie_all', genre: 'Sports' }
  );

  assert.deepEqual(ranked.map((channel) => channel.id), ['strong', 'weak']);
});

test('collectCatalogGenres returns curated category order', () => {
  const genres = collectCatalogGenres([
    { primaryGroup: 'News' },
    { primaryGroup: 'Sports' },
    { primaryGroup: 'Movies' },
    { primaryGroup: 'Kids' }
  ]);

  assert.deepEqual(genres, ['Sports', 'Movies', 'News', 'Kids']);
});
