# Freevie — Free Live TV for Stremio

An open-source Stremio addon that streams **live USA, Canada, and Uganda TV channels** for free. Self-hostable, no accounts required.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D16-green.svg)
![Version](https://img.shields.io/badge/version-2.2.1-orange.svg)

---

## Features

- **500+ channels** — USA, Canada, and Uganda, auto-updated hourly from [iptv-org](https://github.com/iptv-org/iptv)
- **Search** — find channels by name directly in Stremio
- **Browse by genre** — News, Sports, Kids, Entertainment, and 30+ categories
- **Stream health check** — dead streams flagged automatically
- **Alternative feeds** — multiple stream sources per channel when available
- **Adult source failover** — supports multiple adult playlist URLs with merge + dedupe
- **MediaFusion-style IPTV checks** — optional strict content-type validation for live streams
- **Configurable health filtering** — hide unhealthy channels in catalogs when enabled
- **Request header forwarding** — stream-level proxy headers preserved in behavior hints
- **CORS enabled** — works from Stremio web client
- **Health endpoint** — `/health` for uptime monitoring
- **Completely free** — no API keys, no debrid, no subscriptions

---

## Quick Install

Paste this URL into Stremio's addon search bar:

```
http://YOUR_SERVER_IP:7000/manifest.json
```

> Replace `YOUR_SERVER_IP` with your server's public IP after deploying.

---

## Deploy

### Option 1: Render.com (free)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Click the button → connect GitHub → fork this repo
2. Render builds and deploys automatically
3. Use the generated URL as your install link

### Option 2: DigitalOcean ($4/month)

#### 1. Create a Droplet
- [digitalocean.com](https://digitalocean.com) → Create → Droplet
- **Ubuntu 24.04**, **Basic $4/month** (512MB RAM)
- Add SSH key, click Create

#### 2. Setup
```bash
# SSH in
ssh root@YOUR_DROPLET_IP

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and start
git clone https://github.com/YOUR_USERNAME/freevie.git
cd freevie
npm install
```

#### 3. Keep it running
```bash
npm install -g pm2
pm2 start index.js --name freevie
pm2 startup
pm2 save
```

#### 4. Open the port
```bash
ufw allow 7000
ufw enable
```

#### 5. Install in Stremio
```
http://YOUR_DROPLET_IP:7000/manifest.json
```

### Option 3: Run locally
```bash
git clone https://github.com/YOUR_USERNAME/freevie.git
cd freevie
npm install
npm start
```
Then install: `http://localhost:7000/manifest.json`

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7000` | Server port |
| `CACHE_TTL` | `3600000` | Channel refresh interval in ms (default: 1 hour) |
| `HEALTH_CHECK_INTERVAL` | `1800000` | How often to run full channel health checks in ms (default: 30 min) |
| `HEALTH_FILTER` | `true` | If `true`, hide unhealthy channels from catalogs after health checks run |
| `STRICT_IPTV_VALIDATION` | `false` | If `true`, require IPTV-like content type (`m3u8/ts/mpd`) for healthy status |
| `PROXY_HOST` | *(unset)* | **Stream relay** — set to your server's public URL (e.g. `http://1.2.3.4:7000`) to route all streams through your server for smoother playback. Only works when deployed on a public server. |
| `ENABLE_ADULT` | `true` | Enable or disable the adult catalog and adult-like channel entries |
| `US_M3U_URL` | iptv-org US | Custom M3U source for US channels |
| `CA_M3U_URL` | iptv-org CA | Custom M3U source for CA channels |
| `UG_M3U_URL` | iptv-org UG | Custom M3U source for Uganda channels |
| `ADULT_M3U_URLS` | `https://raw.githubusercontent.com/sacuar/MyIPTV/main/Play1.m3u,https://iptvmate.net/files/adult.m3u` | Comma-separated adult playlist URLs (primary + fallbacks). |
| `ADULT_M3U_URL` | *(legacy)* | Legacy single adult source, only used when `ADULT_M3U_URLS` is not set. |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Can't connect | Check firewall: `ufw allow 7000` |
| Channels not loading | Check logs: `pm2 logs freevie` |
| Stream not playing | Try an alternative feed (scroll down in stream list) |
| Addon crashes | Need Node.js 16+: `node --version` |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions and ideas.

---

## Disclaimer

This addon aggregates publicly available IPTV streams from [iptv-org/iptv](https://github.com/iptv-org/iptv). It does not host or re-stream any content. Use at your own risk and discretion.

---

## License

MIT — free to use, modify, and distribute.
