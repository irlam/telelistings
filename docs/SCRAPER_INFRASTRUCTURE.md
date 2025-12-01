# Telegram Sports TV Bot - Scraper Infrastructure

This document provides comprehensive documentation for the scraper infrastructure, including auto-testing, health endpoints, and deployment instructions for VPS-based scrapers.

## Table of Contents

1. [Overview](#overview)
2. [Available Scrapers](#available-scrapers)
3. [Auto-Test System](#auto-test-system)
4. [Health Endpoints](#health-endpoints)
5. [Result Storage](#result-storage)
6. [VPS Deployment Guide](#vps-deployment-guide)
7. [Configuration](#configuration)
8. [Troubleshooting](#troubleshooting)

---

## Overview

The Telegram Sports TV Bot uses a multi-source scraper architecture to collect UK football fixture information, including:
- Match fixtures (teams, kickoff times, competitions)
- TV channel information (which UK channels are showing each match)
- League/tournament data

### Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                     Telegram Bot Application                    │
│                           (app.js)                              │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Auto-Tester  │  │ Scrape Store │  │  Fixtures Aggregator │  │
│  │ (lib/)       │  │ (lib/)       │  │  (scrapers/)         │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │              │
│  ┌──────┴─────────────────┴──────────────────────┴───────────┐ │
│  │                    SCRAPER MODULES                         │ │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐         │ │
│  │  │  LSTV   │ │  TSDB   │ │   BBC   │ │   SKY   │  ...    │ │
│  │  │  (VPS)  │ │  (API)  │ │ (HTTP)  │ │ (HTTP)  │         │ │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘         │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

---

## Available Scrapers

### HTTP-Based Scrapers (Run Directly on Plesk)

These scrapers use axios and cheerio for HTTP requests and HTML parsing. They don't require a separate VPS.

| Scraper | ID | Description | Data Provided |
|---------|-----|-------------|---------------|
| BBC Sport | `bbc` | BBC Sport fixtures page | Fixtures, kickoff times |
| Sky Sports | `sky` | Sky Sports fixtures | Fixtures, Sky channels |
| TNT Sports | `tnt` | TNT Sports schedule | Fixtures, TNT channels |
| LiveFootballOnTV | `lfotv` | UK TV listings site | Fixtures, all UK channels |
| TheSportsDB | `tsdb` | TheSportsDB API | Fixtures, venue info |
| Wikipedia | `wiki` | Wikipedia broadcasting info | League broadcasters |

### VPS-Based Scrapers (Require Headless Browser)

These scrapers require Puppeteer/Playwright and should run on a VPS with a headless browser.

| Scraper | ID | Description | Why VPS? |
|---------|-----|-------------|----------|
| LiveSoccerTV | `lstv` | TV channel info by region | JavaScript-heavy site, anti-bot protection |

---

## Auto-Test System

The auto-test system provides automated testing for all scrapers to ensure they're working correctly.

### Running Auto-Tests

#### Via Admin Interface
Navigate to `/admin/auto-test` in the web interface to:
- Run tests for all scrapers
- Run tests for individual scrapers
- View test history

#### Via Command Line

```bash
# Run all tests
npm run auto-test

# Run specific scrapers
node scripts/run_auto_test.js lstv tsdb

# Health check only
node scripts/run_auto_test.js --health
```

#### Programmatically

```javascript
const autoTester = require('./lib/auto_tester');

// Run all tests
const results = await autoTester.runAllTests();

// Run single scraper test
const result = await autoTester.runScraperTest('lstv');

// Get health status
const health = await autoTester.getHealthStatus();
```

### Test Results

Each test includes:
- **Health Check**: Verifies the scraper can connect to its source
- **Functional Test**: Runs a real scrape with sample data
- **Duration**: Time taken for each test
- **Result Storage**: Results are stored for later viewing

---

## Health Endpoints

### Unified Health Endpoint

```
GET /health
```

Returns health status for all scrapers:

```json
{
  "timestamp": "2024-12-15T10:00:00.000Z",
  "healthy": 6,
  "total": 8,
  "allHealthy": false,
  "scrapers": {
    "lstv": { "ok": false, "error": "VPS not configured" },
    "tsdb": { "ok": true, "latencyMs": 150 },
    "bbc": { "ok": true, "latencyMs": 200 },
    ...
  }
}
```

### Individual Scraper Health

```
GET /health/:scraperId
```

Example: `GET /health/tsdb`

```json
{
  "scraperId": "tsdb",
  "ok": true,
  "latencyMs": 150
}
```

### Using Health Endpoints for Monitoring

```bash
# Quick health check (quiet mode - only output on failure)
node scripts/health_check.js --quiet

# JSON output for monitoring systems
node scripts/health_check.js --json

# Check in cron job (add to crontab)
*/5 * * * * /usr/bin/node /path/to/scripts/health_check.js --quiet || /path/to/alert.sh
```

---

## Result Storage

Scrape results are automatically stored for later viewing and integration with the autoposter.

### Storage Location

```
storage/
├── scrapes/          # Historical results by scraper
│   ├── lstv/
│   │   ├── 2024-12-15_100000.json
│   │   └── 2024-12-15_120000.json
│   ├── tsdb/
│   └── ...
├── latest/           # Most recent result for each scraper
│   ├── lstv.json
│   ├── tsdb.json
│   └── ...
└── auto_tests/       # Auto-test results
    ├── lstv_2024-12-15.json
    └── tsdb_2024-12-15.json
```

### Accessing Stored Results

#### Via Admin Interface
Navigate to `/admin/results` to:
- View list of scrapers with stored results
- Browse result history
- See detailed JSON data

#### Programmatically

```javascript
const scrapeStore = require('./lib/scrape_store');

// Get latest results
const latest = scrapeStore.getLatestResults('tsdb');

// Get result history
const history = scrapeStore.getResultHistory('tsdb', 10);

// Get today's aggregated fixtures
const fixtures = scrapeStore.getTodaysFixtures();
```

### Result Format

```json
{
  "scraperId": "tsdb",
  "timestamp": "2024-12-15T10:00:00.000Z",
  "metadata": {
    "duration_ms": 1500,
    "fixtureCount": 12,
    "error": null
  },
  "results": {
    "fixtures": [
      {
        "home": "Arsenal",
        "away": "Chelsea",
        "kickoffUtc": "2024-12-15T15:00:00.000Z",
        "competition": "Premier League",
        "channels": ["Sky Sports Main Event", "Sky Sports Premier League"]
      }
    ]
  }
}
```

---

## VPS Deployment Guide

### LiveSoccerTV Scraper (LSTV)

The LSTV scraper requires a VPS with Puppeteer/Playwright due to JavaScript rendering and anti-bot protection.

#### VPS Requirements

- **OS**: Ubuntu 20.04+ or Debian 10+
- **RAM**: Minimum 2GB (4GB recommended)
- **Storage**: 10GB minimum
- **Network**: Outbound HTTP/HTTPS access
- **Software**: Node.js 18+, Chrome/Chromium

#### Installation Steps

1. **Set up the VPS**

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install Chromium and dependencies
sudo apt install -y chromium-browser
sudo apt install -y libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2
```

2. **Clone the VPS scraper service**

```bash
git clone https://github.com/irlam/telelistings-vps-scraper.git
cd telelistings-vps-scraper
npm install
```

3. **Configure the service**

Create `.env` file:
```env
PORT=3333
API_KEY=your-secure-api-key-here
CHROME_PATH=/usr/bin/chromium-browser
```

4. **Start as a system service**

Create `/etc/systemd/system/lstv-scraper.service`:
```ini
[Unit]
Description=LSTV Scraper Service
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/telelistings-vps-scraper
ExecStart=/usr/bin/node server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
sudo systemctl enable lstv-scraper
sudo systemctl start lstv-scraper
```

5. **Configure the main app**

Add to Plesk Node.js environment variables:
```
LSTV_SCRAPER_URL=http://YOUR_VPS_IP:3333
LSTV_SCRAPER_KEY=your-secure-api-key-here
```

#### VPS Service Endpoints

The VPS service exposes:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Service health check |
| `/scrape/lstv` | POST | Scrape LiveSoccerTV for a match |

Example scrape request:
```json
POST /scrape/lstv
{
  "home": "Arsenal",
  "away": "Chelsea",
  "dateUtc": "2024-12-15T15:00:00.000Z",
  "leagueHint": "Premier League"
}
```

Response:
```json
{
  "url": "https://livesoccertv.com/match/...",
  "kickoffUtc": "2024-12-15T15:00:00.000Z",
  "league": "English Premier League",
  "matchScore": 95,
  "regionChannels": [
    { "region": "UK", "channel": "Sky Sports Main Event" },
    { "region": "UK", "channel": "Sky Sports Premier League" }
  ]
}
```

---

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `LSTV_SCRAPER_URL` | URL of VPS LSTV scraper | Yes (for LSTV) |
| `LSTV_SCRAPER_KEY` | API key for VPS service | Yes (for LSTV) |
| `THESPORTSDB_API_KEY` | TheSportsDB API key | No (has default) |

### Scraper Configuration

Each scraper in `lib/auto_tester.js` has a configuration entry:

```javascript
SCRAPER_REGISTRY = {
  lstv: {
    id: 'lstv',
    name: 'LiveSoccerTV',
    module: '../scrapers/lstv',
    hasHealthCheck: true,
    testMethod: 'fetchLSTV',
    testParams: { home: 'Arsenal', away: 'Chelsea' },
    requiresVPS: true
  },
  // ... more scrapers
}
```

---

## Troubleshooting

### Common Issues

#### LSTV Scraper Not Working

```
Error: LSTV_SCRAPER_URL and LSTV_SCRAPER_KEY environment variables must be configured
```

**Solution**: Configure the VPS scraper URL and API key in your Plesk Node.js environment.

#### Health Check Fails

```
[health] FAIL: getaddrinfo ENOTFOUND www.example.com
```

**Solution**: 
1. Check network connectivity
2. Verify the source website is accessible
3. Check for IP blocking or rate limiting

#### No Fixtures Found

```
[FIX] No fixtures found for Arsenal from any source
```

**Solution**:
1. Check if fixtures exist on the source websites manually
2. Verify scraper selectors are up-to-date (websites may change HTML)
3. Check rate limiting

### Debug Mode

Enable debug logging for LSTV:
```bash
LSTV_DEBUG=1 node app.js
```

### Log Files

Check `autopost.log` for detailed scraper activity:
```bash
tail -f autopost.log | grep -E "\[LSTV\]|\[TSDB\]|\[BBC\]"
```

---

## Adding New Scrapers

To add a new scraper:

1. Create the scraper module in `scrapers/`:

```javascript
// scrapers/mynewscraper.js
async function fetchData(params) {
  // Implementation
}

async function healthCheck() {
  // Health check implementation
}

module.exports = { fetchData, healthCheck };
```

2. Register in `lib/auto_tester.js`:

```javascript
mynew: {
  id: 'mynew',
  name: 'My New Scraper',
  module: '../scrapers/mynewscraper',
  hasHealthCheck: true,
  testMethod: 'fetchData',
  testParams: { /* test params */ },
  requiresVPS: false
}
```

3. Add to fixtures aggregator if needed in `scrapers/fixtures_scraper.js`

4. Run tests to verify:
```bash
npm test
```

---

## Support

For issues or questions:
1. Check the logs at `/admin/logs`
2. Run auto-tests at `/admin/auto-test`
3. Review health status at `/health`

---

*Last updated: December 2024*
