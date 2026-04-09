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

test('categorizeChannel recognizes supersport and disney-family brands', () => {
  const supersportCategory = categorizeChannel({
    name: 'SuperSport Premier League',
    groups: ['Football']
  });
  const disneyCategory = categorizeChannel({
    name: 'Disney Junior Africa',
    groups: ['Family']
  });

  assert.equal(supersportCategory, 'Sports');
  assert.equal(disneyCategory, 'Kids');
});

test('rankChannels aggressively promotes branded sports and kids channels', () => {
  const sportsRanked = rankChannels(
    [
      {
        id: 'generic-sports',
        name: 'Football Feed 5',
        displayName: 'Football Feed 5',
        normalizedName: 'football feed 5',
        primaryGroup: 'Sports',
        groups: ['Sports', 'Live Sports'],
        quality: 'FHD',
        healthy: true,
        responseMs: 450,
        poster: 'https://img.example.com/generic-sports.png',
        logo: 'https://img.example.com/generic-sports.png'
      },
      {
        id: 'supersport',
        name: 'SuperSport Premier League',
        displayName: 'SuperSport Premier League',
        normalizedName: 'supersport premier league',
        primaryGroup: 'Sports',
        groups: ['Sports', 'Football'],
        quality: 'HD',
        healthy: true,
        responseMs: 1200,
        poster: 'https://img.example.com/supersport.png',
        logo: 'https://img.example.com/supersport.png'
      }
    ],
    { catalogId: 'freevie_all', genre: 'Sports' }
  );

  const kidsRanked = rankChannels(
    [
      {
        id: 'generic-kids',
        name: 'Kids Fun Feed',
        displayName: 'Kids Fun Feed',
        normalizedName: 'kids fun feed',
        primaryGroup: 'Kids',
        groups: ['Kids', 'Family'],
        quality: 'FHD',
        healthy: true,
        responseMs: 420,
        poster: 'https://img.example.com/generic-kids.png',
        logo: 'https://img.example.com/generic-kids.png'
      },
      {
        id: 'disney-junior',
        name: 'Disney Junior',
        displayName: 'Disney Junior',
        normalizedName: 'disney junior',
        primaryGroup: 'Kids',
        groups: ['Kids', 'Family'],
        quality: 'SD',
        healthy: true,
        responseMs: 1400,
        poster: 'https://img.example.com/disney.png',
        logo: 'https://img.example.com/disney.png'
      }
    ],
    { catalogId: 'freevie_all', genre: 'Kids' }
  );

  assert.deepEqual(sportsRanked.map((channel) => channel.id), ['supersport', 'generic-sports']);
  assert.deepEqual(kidsRanked.map((channel) => channel.id), ['disney-junior', 'generic-kids']);
});
