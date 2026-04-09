const test = require('node:test');
const assert = require('node:assert/strict');

const { parseM3USource } = require('../src/sources/m3u');

test('parseM3USource parses vlc headers and emits normalized channel records', () => {
  const playlist = `#EXTM3U
#EXTINF:-1 tvg-id="espn.us" tvg-logo="https://img.example.com/espn.png" group-title="Sports;Live Sports",ESPN 1 HD
#EXTVLCOPT:http-referrer=https://guide.example.com
#EXTVLCOPT:http-user-agent=SportsBot/1.0
https://example.com/live/espn1.m3u8
`;

  const channels = parseM3USource({
    content: playlist,
    sourceId: 'us',
    country: 'us'
  });

  assert.equal(channels.length, 1);
  assert.equal(channels[0].id, 'us_espn_us');
  assert.equal(channels[0].normalizedName, 'espn 1');
  assert.equal(channels[0].primaryGroup, 'Sports');
  assert.equal(channels[0].quality, 'HD');
  assert.equal(channels[0].extraHeaders.referer, 'https://guide.example.com');
  assert.equal(channels[0].extraHeaders['user-agent'], 'SportsBot/1.0');
});

test('parseM3USource ignores duplicate stream rows', () => {
  const playlist = `#EXTM3U
#EXTINF:-1 group-title="Movies",Cinema One
https://example.com/live/cinema.m3u8
#EXTINF:-1 group-title="Movies",Cinema One
https://example.com/live/cinema.m3u8
`;

  const channels = parseM3USource({
    content: playlist,
    sourceId: 'ca',
    country: 'ca'
  });

  assert.equal(channels.length, 1);
  assert.equal(channels[0].canonicalId, 'cinema_one');
});