# Contributing to Freevie

Thanks for wanting to help! Here's how to get started.

## Setup

1. Fork the repo and clone it
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the dev server:
   ```bash
   npm run dev
   ```
4. Open Stremio → paste `http://localhost:7000/manifest.json`

## Making Changes

1. Create a branch: `git checkout -b my-feature`
2. Make your changes
3. Test locally — make sure channels load and streams play
4. Commit and push, then open a Pull Request

## Ideas for Contributions

- **More countries** — add M3U sources for other regions
- **EPG support** — add TV guide data from `iptv-org/epg`
- **Channel status page** — a web dashboard showing live/dead streams
- **Better health checks** — periodic background stream validation
- **Favorites** — user-configurable channel list

## Code Style

- Keep it simple — this is a single-file Node.js addon
- Use `log()` for all console output (timestamped)
- Test with `curl` against the local endpoints before submitting
