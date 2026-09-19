# Telelistings 2.0

Free, UK-first football TV listings for Telegram.

Telelistings collects daily fixture data from several independent sources, normalises team and channel names, merges duplicate matches and produces a searchable daily digest plus branded match posters. It lists where matches are scheduled to appear; it does not host or link to streams.

## What is new in 2.0

- Complete collection of the current day's UK football TV listings
- Men's football only; women's fixtures are excluded from every source
- Full dates such as `Sunday 30 August 2026` on every poster and caption
- UK kick-off times with optional Eastern Time in individual posters
- UK broadcasters shown first, followed by other available regions
- Team badges from the free TheSportsDB source, downloaded once and cached
- A clean 1080 × 1350 branded poster even when no background image is uploaded
- Editable poster brand name and subtitle for each Telegram channel
- Daily digest messages, split safely at Telegram's message limit
- Cross-source fixture and channel deduplication
- IPTV-friendly canonical channel names and common provider aliases
- Free automatic cleanup of expired Telegram posters and daily digests
- Live/replay classification with internal cross-source confidence tracking
- Repeat protection: unchanged fixtures are not posted again by later cron runs
- Update detection: a changed time or TV channel is posted as `LISTING UPDATED`
- Cached, concurrency-limited VPS scraping with rate limiting and backoff
- No paid API is required
- No committed passwords, bot tokens, VPS addresses or scraper keys

## How it works

1. The Plesk application requests daily schedules from the VPS service.
2. The VPS runs a small number of cached source scrapes with a maximum of two active scrapes.
3. `lib/daily_listings.js` combines the source responses.
4. `lib/fixture_normalizer.js` standardises dates, teams, competitions, regions and channels.
5. Duplicate matches are merged while retaining every useful TV station.
6. The bot sends a daily digest and up to the configured number of fixture posters.
7. `storage/post-state.json` prevents duplicate Telegram posts.

## Production scraper set

- LiveOnSat and LiveSoccerTV provide broad date-aware VPS TV-listing feeds.
- Official Sky Sports and Premier Sports guides add broadcaster-specific listings.
- Live Football On TV and BBC Sport provide lightweight Plesk-side checks.
- TheSportsDB supplies fixture validation and missing team badges.
- Wikipedia supplies UK competition broadcaster information.

Broken, blocked and duplicate implementations have been removed. The dashboard,
Auto-Test and deployed VPS now describe the same eight-source production set, so
a red test identifies a source that actually needs attention.

## Responsible collection

This project intentionally uses caching, request spacing, small concurrency limits, retry backoff and per-client rate limits. Do not use it to bypass access controls, CAPTCHAs or a site's published restrictions. Disable a source if its owner disallows automated access or its terms change.

## Quick start

Node.js 22.12 or newer is required.

```bash
npm ci
cp config.example.json config.json
npm test
npm start
```

Required Plesk environment variables:

```text
TELEGRAM_BOT_TOKEN=<new BotFather token>
ADMIN_PASSWORD=<new strong admin password>
CRON_SECRET=<new random cron secret>
LSTV_SCRAPER_URL=http://<your-vps-address>:3333
LSTV_SCRAPER_KEY=<same new key used by the VPS>
```

`config.json` is deliberately ignored by Git. Start from `config.example.json`, set the Telegram channel ID and keep the local file on the server.

See [docs/DEPLOYMENT_V2.md](docs/DEPLOYMENT_V2.md) for the safe upgrade and VPS instructions.

## Useful commands

```bash
npm test
npm run health
npm start
```

Live network tests are deliberately opt-in:

```bash
RUN_NETWORK_TESTS=1 npm test
```

## Main files

| File | Purpose |
|---|---|
| `app.js` | Admin panel, cron endpoint and diagnostics |
| `autopost.js` | Telegram digest/poster creation and sending |
| `lib/daily_listings.js` | Complete daily source collection and cache |
| `lib/fixture_normalizer.js` | Fixture merging, UK filtering, confidence and TV channel ordering |
| `lib/iptv_channels.js` | IPTV alias normalisation and live/replay classification |
| `lib/image_cache.js` | Safe allowlisted badge/image cache |
| `lib/post_state.js` | Duplicate detection and persistent Telegram message-expiry queue |
| `vps-scrapers/server.js` | Authenticated, cached scraper microservice |
| `config.example.json` | Safe UK Daily configuration template |

## Tests

The default suite is offline and covers date handling, British Summer Time conversion, merging, UK relevance, daily source scheduling, captions, digests and existing modules. Network tests do not run unless explicitly enabled.
