const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCatalogPage } = require('../src/catalog/channel-catalog');

test('buildCatalogPage filters and ranks channels before paging', () => {
  const page = buildCatalogPage(
    [
      {
        id: 'weak',
        name: 'Sports Feed 9',
        primaryGroup: 'Sports',
        groups: ['Sports'],
        quality: 'SD',
        healthy: true,
        responseMs: 2500,
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
        responseMs: 650,
        poster: 'https://img.example.com/espn.png',
        logo: 'https://img.example.com/espn.png'
      },
      {
        id: 'news',
        name: 'BBC News',
        primaryGroup: 'News',
        groups: ['News'],
        quality: 'HD',
        healthy: true,
        responseMs: 800,
        poster: 'https://img.example.com/bbc.png',
        logo: 'https://img.example.com/bbc.png'
      }
    ],
    {
      genre: 'Sports',
      skip: 0,
      pageSize: 10,
      rankContext: { catalogId: 'freevie_all', genre: 'Sports' }
    }
  );

  assert.deepEqual(page.map((channel) => channel.id), ['strong', 'weak']);
});
