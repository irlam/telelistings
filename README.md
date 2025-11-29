# telelistings

Telegram Sports TV Bot - Auto-poster for football fixtures with TV listings.

## Features

- Posts upcoming football fixtures to Telegram channels
- Fetches fixtures from ICS calendar feeds (TheFishy, etc.)
- Optional integration with TheSportsDB API for TV channel information
- Web-based admin GUI for configuration
- Supports multiple Telegram channels with different team lists

## Configuration

Main settings are stored in `config.json`:

- `botToken` - Telegram Bot API token (from BotFather)
- `timezone` - IANA timezone (e.g., "Europe/London")
- `icsUrl` - Default ICS feed URL
- `icsDaysAhead` - How many days ahead to show fixtures
- `theSportsDbApiKey` - (optional) API key from thesportsdb.com for TV listings
- `channels[]` - Array of Telegram channels to post to

## TheSportsDB Integration

To enable TV channel information in fixture listings:

1. Get an API key from https://www.thesportsdb.com/api.php
2. Add the key to Settings in the admin GUI, or set `theSportsDbApiKey` in config.json
3. TV channel info will automatically be fetched and included in fixture messages

## Running

```bash
npm install
npm start
```

Admin GUI will be available at http://localhost:3000/admin/