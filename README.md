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

The bot can fetch detailed TV channel listings from LiveSoccerTV.com. This integration uses a **remote VPS scraper service** instead of local Puppeteer/Chrome, improving reliability and reducing server resource usage.

### Environment Variables

Configure the following environment variables (in Plesk Node settings or a `.env` file):

```
LSTV_SCRAPER_URL=http://185.170.113.230:3333
LSTV_SCRAPER_KEY=Q0tMx1sJ8nVh3w9L2z
```

| Variable | Description | Default |
|----------|-------------|---------|
| `LSTV_SCRAPER_URL` | Base URL of the remote LSTV scraper service | `http://185.170.113.230:3333` |
| `LSTV_SCRAPER_KEY` | API key for authentication (sent as `x-api-key` header) | `Q0tMx1sJ8nVh3w9L2z` |

> **Security Note**: The default values are provided for convenience. In production environments:
> - Set environment variables explicitly rather than relying on defaults
> - Do not commit actual API keys to source control
> - The remote service uses HTTP (not HTTPS) as it runs on a private/internal network

### How It Works

1. When a fixture is being processed, the bot calls `POST ${LSTV_SCRAPER_URL}/scrape/lstv` with match details
2. The remote VPS performs all browser automation (Puppeteer/Chrome) to scrape LiveSoccerTV
3. TV channel data by region is returned and merged with other data sources
4. Results are cached for 4 hours to reduce API calls

### Health Check

- Visit `/health/lstv` on your bot instance to check the remote scraper status
- The health endpoint proxies to `${LSTV_SCRAPER_URL}/health` on the VPS

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