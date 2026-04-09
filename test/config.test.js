const test = require('node:test');
const assert = require('node:assert/strict');

function loadConfigWithEnv(overrides) {
  const targetKeys = Object.keys(overrides);
  const previous = Object.fromEntries(targetKeys.map((key) => [key, process.env[key]]));

  for (const key of targetKeys) {
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');

  for (const key of targetKeys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  delete require.cache[require.resolve('../src/config')];
  return config;
}

test('config exposes configured extra m3u urls when provided', () => {
  const config = loadConfigWithEnv({
    EXTRA_M3U_URLS: 'https://one.example.com/a.m3u, https://two.example.com/b.m3u,invalid'
  });

  assert.deepEqual(config.EXTRA_M3U_URLS, [
    'https://one.example.com/a.m3u',
    'https://two.example.com/b.m3u'
  ]);
});

test('config falls back to default extra m3u urls when unset', () => {
  const config = loadConfigWithEnv({
    EXTRA_M3U_URLS: undefined
  });

  assert.ok(Array.isArray(config.EXTRA_M3U_URLS));
  assert.ok(config.EXTRA_M3U_URLS.length >= 1);
  assert.ok(config.EXTRA_M3U_URLS.some((url) => url.includes('/gb.m3u')));
  assert.ok(config.EXTRA_M3U_URLS.some((url) => url.includes('/za.m3u')));
  assert.ok(config.EXTRA_M3U_URLS.some((url) => url.includes('/qa.m3u')));
  assert.ok(config.EXTRA_M3U_URLS.some((url) => url.includes('/ae.m3u')));
});
