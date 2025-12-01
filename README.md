# telelistings

Telegram Sports TV Bot - Auto-poster for football fixtures with TV listings.

## Features

- Posts upcoming football fixtures to Telegram channels
- Fetches fixtures from ICS calendar feeds (TheFishy, etc.)
- Optional integration with TheSportsDB API for TV channel information
- Web-based admin GUI for configuration
- Supports multiple Telegram channels with different team lists
- **Poster-style messages** with image generation support
- **Image-based posters** when a background image is uploaded

## Configuration

Main settings are stored in `config.json`:

- `botToken` - Telegram Bot API token (from BotFather)
- `timezone` - IANA timezone (e.g., "Europe/London")
- `icsUrl` - Default ICS feed URL
- `icsDaysAhead` - How many days ahead to show fixtures
- `theSportsDbApiKey` - (optional) API key from thesportsdb.com for TV listings
- `posterFooterText` - Custom footer text for poster-style messages
- `channels[]` - Array of Telegram channels to post to

## TheSportsDB Integration

To enable TV channel information in fixture listings:

1. Get an API key from https://www.thesportsdb.com/api.php
2. Add the key to Settings in the admin GUI, or set `theSportsDbApiKey` in config.json
3. TV channel info will automatically be fetched and included in fixture messages

## LiveSoccerTV Integration (Remote Scraper)

The bot can fetch detailed TV channel listings from LiveSoccerTV.com. This integration uses a **remote VPS scraper service** – **Puppeteer/Chrome is NOT used locally on Plesk**. This improves reliability and reduces server resource usage.

### Required Environment Variables (Plesk Node Settings)

The following environment variables **must** be configured in Plesk Node settings for the remote scraper to work:

| Variable | Description | Required |
|----------|-------------|----------|
| `LSTV_SCRAPER_URL` | Base URL of the remote LSTV scraper service | Yes |
| `LSTV_SCRAPER_KEY` | API key for authentication (sent as `x-api-key` header) | Yes |
| `CRON_SECRET` | Secret key for `/cron/run` endpoint authentication | Yes |
| `ADMIN_PASSWORD` | Password for admin GUI authentication | Recommended |

Example configuration:
```
LSTV_SCRAPER_URL=http://your-vps-ip:3333
LSTV_SCRAPER_KEY=your_secret_api_key_here
CRON_SECRET=your_cron_secret_here
ADMIN_PASSWORD=your_admin_password_here
```

> **Security Note**: 
> - These environment variables are REQUIRED - no default values are provided
> - Do not commit actual API keys or credentials to source control
> - The remote service typically uses HTTP (not HTTPS) as it runs on a private/internal network
> - Contact your system administrator for the correct LSTV_SCRAPER_URL and LSTV_SCRAPER_KEY values

### How It Works

1. When a fixture is being processed, the bot calls `POST ${LSTV_SCRAPER_URL}/scrape/lstv` with match details
2. The remote VPS performs all browser automation (Puppeteer/Chrome) to scrape LiveSoccerTV
3. TV channel data by region is returned and merged with other data sources
4. Results are cached for 4 hours to reduce API calls

**Note**: The `livesoccertv.js` file in the root directory is DEPRECATED and kept for reference only. All production scraping uses `scrapers/lstv.js` which calls the remote service.

### Health Check

- Visit `/health/lstv` on your bot instance to check the remote scraper status
- The health endpoint proxies to `${LSTV_SCRAPER_URL}/health` on the VPS
- Visit `/health/tsdb` to check TheSportsDB API connectivity

## Image-Based Posters

For poster-style channels, you can upload a background image to generate visually appealing image posters instead of text-only messages.

### Uploading a Background Image

1. Go to the admin GUI at `/admin/settings`
2. Scroll to the "Poster Background Image" section
3. Upload an image file (supported formats: **JPG, JPEG, PNG, GIF**, max 5MB)
4. The image will be stored as `uploads/poster-background.<ext>`

### How It Works

- When a **poster-style channel** (`posterStyle: true`) is configured and a background image exists, the autoposter will generate image-based posters
- Each fixture gets its own poster image showing:
  - "SPORTS LISTINGS ON TV" header
  - Kick-off times in UK and ET timezones
  - Match fixture (e.g., "BOLTON v LIVERPOOL")
  - Competition name
  - TV channels by region
  - Custom footer text (configurable in settings)
- The generated image is sent to Telegram using the `sendPhoto` API
- If image generation fails or no background is uploaded, it gracefully falls back to text-based posters

### Recommended Background Images

- Use a simple, solid-colored or subtle gradient background
- Avoid images with existing text (it will be covered by a dark overlay)
- Recommended dimensions: 1000x700 pixels or similar aspect ratio
- The image provides the canvas size; text is overlaid on top

## ICS Summary Formats

The autoposter parses fixture summaries from your ICS calendar to extract home and away team names. For best results, use one of these formats in your ICS event summaries:

### Recommended Formats

| Format | Example |
|--------|---------|
| `Team A v Team B` | `Bolton v Liverpool` |
| `Team A vs Team B` | `Arsenal vs Chelsea` |
| `Team A vs. Team B` | `Real Madrid vs. Barcelona` |
| `Team A - Team B` | `Man City - Spurs` |
| `Team A @ Team B` | `Liverpool @ Everton` |

### Supported Variations

The parser also handles:
- Extra spaces: `Everton  vs  Chelsea`
- Home/Away annotations: `Burnley (H) vs Liverpool (A)` → displays as `BURNLEY v LIVERPOOL`
- Annotations in brackets: `Team A (HOME) v Team B (AWAY)`

### Tips

- Always include both team names separated by one of the supported separators
- The "v" separator is most common in UK football calendars
- Avoid using hyphens in team names if using `-` as separator
- If only one team is detected, the poster will show just that team name

## Running

```bash
npm install
npm start
```

Admin GUI will be available at http://localhost:3000/admin/

## Channel Configuration

Each channel can be configured with:

- `posterStyle: true` - Enable poster-style layout (one message per fixture)
- `posterStyle: false` - Use compact list layout (all fixtures in one message)
- `useTheFishyMulti: true` - Fetch fixtures from multiple TheFishy team calendars
- `teams[]` - Array of teams to track
- `tvChannelOverrides` - Manual TV channel mappings by team/competition name

## Scraper Architecture

The telelistings app uses a **remote scraper service architecture** for data collection:

### Data Sources

| Module | Purpose | Location |
|--------|---------|----------|
| `scrapers/lstv.js` | LiveSoccerTV TV channels | Remote VPS (Puppeteer) |
| `scrapers/thesportsdb.js` | Fixture info, kickoff times | Direct API |
| `scrapers/wiki_broadcasters.js` | League broadcasting rights | Direct HTTP |
| `scrapers/bbc_fixtures.js` | BBC Sport fixtures | Direct HTTP |
| `scrapers/skysports.js` | Sky Sports TV channels | Direct HTTP |
| `scrapers/tnt.js` | TNT Sports TV channels | Direct HTTP |
| `scrapers/livefootballontv.js` | UK TV listings | Direct HTTP |
| `scrapers/footballdata.js` | FootballData.org API | Direct API |
| `scrapers/fixtures_scraper.js` | **Unified fixture scraper** (web scrapers instead of ICS) | Aggregator |

### Unified Fixtures Scraper (Web Scrapers Alternative to ICS)

The `scrapers/fixtures_scraper.js` module provides an alternative to ICS-based fixture discovery, using web scrapers instead:

```javascript
const fixturesScraper = require('./scrapers/fixtures_scraper');

// Get fixtures for a single team
const fixtures = await fixturesScraper.getFixturesFromScrapers({
  teamName: 'Arsenal',
  daysAhead: 7,
  useTSDB: true,      // TheSportsDB
  useBBC: true,       // BBC Sport
  useLFOTV: true,     // LiveFootballOnTV
  useSkySports: true, // Sky Sports
  useTNT: true        // TNT Sports
});

// Get fixtures for multiple teams
const allFixtures = await fixturesScraper.getFixturesForTeams({
  teams: [
    { label: 'Arsenal', slug: 'arsenal' },
    { label: 'Liverpool', slug: 'liverpool' }
  ],
  daysAhead: 7,
  maxTeams: 10
});
```

**Key Features:**
- Aggregates fixtures from multiple web sources (TSDB, BBC, LFOTV, Sky, TNT)
- **Collects ALL TV channels from ALL sources** - each scraper may find different channels
- Merges and deduplicates results automatically
- TV channels are stored in both `tvChannels[]` (flat list) and `tvByRegion[]` (with source attribution)

### TV Channel Collection

**Important:** Each scraper may find different TV stations for the same event. The system collects channels from ALL sources:

```javascript
// Example merged fixture with TV channels from multiple sources
{
  homeTeam: 'Arsenal',
  awayTeam: 'Chelsea',
  start: Date,
  competition: 'Premier League',
  tvChannels: ['Sky Sports Main Event', 'Sky Sports Ultra HD', 'NOW TV'],  // Deduplicated flat list
  tvByRegion: [
    { region: 'UK', channel: 'Sky Sports Main Event', source: 'LFOTV' },
    { region: 'UK', channel: 'Sky Sports Ultra HD', source: 'SKY' },
    { region: 'UK', channel: 'NOW TV', source: 'TNT' }
  ]
}
```

When posting to Telegram, all collected TV channels are displayed for each event.

### TV Data Aggregator

The `aggregators/tv_channels.js` module provides a unified `getTvDataForFixture()` function that:
1. Calls all available data sources
2. Merges results into a canonical format
3. Handles errors gracefully (logs warnings but continues)
4. Deduplicates TV channel data

### Remote VPS Scraper

LiveSoccerTV scraping requires browser automation (Puppeteer/Chrome) which is resource-intensive. To avoid running Chrome on the production Plesk server:

1. A dedicated VPS runs the scraper service
2. The Plesk app calls the VPS via HTTP API
3. The VPS handles all browser automation
4. Results are returned as JSON

**Note**: The `livesoccertv.js` file in the root directory is DEPRECATED – it contains reference implementations only. For production use, always use `scrapers/lstv.js`.

## Dependencies

This project does **not** require Puppeteer to be installed locally. All browser automation is handled by the remote VPS scraper service.

Core dependencies:
- `express` - Web server and admin GUI
- `axios` - HTTP client for remote API calls
- `cheerio` - HTML parsing for HTTP-based scrapers
- `node-ical` - ICS calendar parsing
- `@napi-rs/canvas` - Image generation for posters