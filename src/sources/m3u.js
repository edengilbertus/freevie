const { normalizeChannel, detectQuality } = require('../normalize/channel-normalizer');

function parseM3USource({ content, sourceId, country }) {
  const channels = [];
  const lines = String(content || '').split(/\r?\n/);
  const seen = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('#EXTINF')) continue;

    let url = '';
    const extraHeaders = {};

    for (let cursor = index + 1; cursor < Math.min(index + 6, lines.length); cursor += 1) {
      const nextLine = lines[cursor].trim();
      if (nextLine.startsWith('#EXTVLCOPT:http-referrer=')) {
        extraHeaders.referer = nextLine.replace('#EXTVLCOPT:http-referrer=', '');
        continue;
      }
      if (nextLine.startsWith('#EXTVLCOPT:http-user-agent=')) {
        extraHeaders['user-agent'] = nextLine.replace('#EXTVLCOPT:http-user-agent=', '');
        continue;
      }
      if (/^https?:\/\//i.test(nextLine)) {
        url = nextLine;
        break;
      }
      if (nextLine && !nextLine.startsWith('#')) break;
    }

    if (!url) continue;

    const nameMatch = line.match(/,(.+)$/);
    const name = nameMatch ? nameMatch[1].trim() : 'Unknown';
    const tvgIdMatch = line.match(/tvg-id="([^"]+)"/);
    const logoMatch = line.match(/tvg-logo="([^"]+)"/);
    const groupMatch = line.match(/group-title="([^"]+)"/);

    const channel = normalizeChannel({
      sourceId,
      sourceType: 'm3u',
      country,
      tvgId: tvgIdMatch ? tvgIdMatch[1] : null,
      name,
      url,
      logo: logoMatch ? logoMatch[1] : '',
      groups: groupMatch ? groupMatch[1].split(/[,;|]/) : [],
      quality: detectQuality(name),
      extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : null
    });

    const dedupeKey = `${channel.id}:${url}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    channels.push(channel);
  }

  return channels;
}

module.exports = {
  parseM3USource
};