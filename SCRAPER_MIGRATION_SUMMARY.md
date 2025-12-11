# Scraper Migration to Puppeteer on VPS - Summary

## Overview

This document summarizes the migration of all scrapers to use Puppeteer on the VPS and the integration of the new SofaScore scraper throughout the telelistings system.

## Changes Made

### 1. SofaScore Integration

#### VPS Server (`vps-scrapers/`)
- ✅ Added `sofascore` import to `server.js`
- ✅ Added SofaScore to `SUPPORTED_SOURCES` list
- ✅ Registered `/scrape/sofascore` route
- ✅ Registered `/health/sofascore` health check route
- ✅ Added `scraper:sofascore` script to `package.json`
- ✅ Added `axios` dependency to `package.json` (required by sofascore.js)

#### Auto Tester (`lib/auto_tester.js`)
- ✅ Added `vps-sofascore` entry to `SCRAPER_REGISTRY`
- ✅ Configured with VPS endpoint `/scrape/sofascore`
- ✅ Configured with health endpoint `/health/sofascore`
- ✅ Set as VPS-based scraper (`isVps: true`)

#### Remote Scraper Client (`scrapers/lstv.js`)
- ✅ Added `fetchSofaScoreRemote()` function
- ✅ Exported `fetchSofaScoreRemote` in module exports
- ✅ Follows same pattern as other remote scraper functions

#### Aggregator (`aggregators/tv_channels.js`)
- ✅ Added `enableRemoteSofaScore` option
- ✅ Added SofaScore to remote scraper conditional check
- ✅ Added SofaScore remote scraper call with proper parameters
- ✅ Integrated with parallel scraper execution

#### Documentation
- ✅ Updated `vps-scrapers/README.md`:
  - Added sofascore to folder structure
  - Added sofascore to sources list in health endpoint example
  - Added sofascore to `/sources` endpoint example
  - Added `POST /scrape/sofascore` API documentation
  - Added `/health/sofascore` to health check endpoints
- ✅ Updated main `README.md`:
  - Added comprehensive VPS Scraper Service section
  - Listed all 12 VPS scrapers including SofaScore
  - Documented remote calling via lstv.js client

### 2. VPS Scraper Architecture

All scrapers now follow a unified architecture where:

#### Local Scrapers (`/scrapers`)
- **Purpose**: Backward compatibility and direct HTTP/API access
- **Types**:
  - API-based: `thesportsdb.js`, `footballdata.js`
  - HTTP-based: `bbc_fixtures.js`, `skysports.js`, `tnt.js`, `livefootballontv.js`
  - Metadata: `wiki_broadcasters.js`
  - Aggregator: `fixtures_scraper.js`
  - Client: `lstv.js` (calls VPS)

#### VPS Scrapers (`/vps-scrapers/scrapers`)
- **Purpose**: Puppeteer-based scraping on VPS server
- **All scrapers export**:
  - `scrape(params)` - Main scraping function
  - `healthCheck()` - Health check function
- **Available scrapers** (12 total):
  1. `bbc.js` - BBC Sport fixtures (Puppeteer)
  2. `livefootballontv.js` - Live Football On TV (Puppeteer)
  3. `liveonsat.js` - LiveOnSat UK Football (Puppeteer)
  4. `lstv.js` - LiveSoccerTV listings (Puppeteer)
  5. `oddalerts.js` - OddAlerts TV Guide (Puppeteer)
  6. `prosoccertv.js` - ProSoccer.TV (Puppeteer)
  7. `skysports.js` - Sky Sports fixtures (Puppeteer)
  8. `sofascore.js` - SofaScore fixtures + TV (API/axios) ⭐ NEW
  9. `sporteventz.js` - SportEventz (Puppeteer)
  10. `tnt.js` - TNT Sports fixtures (Puppeteer)
  11. `wheresthematch.js` - Where's The Match (Puppeteer)
  12. `worldsoccertalk.js` - World Soccer Talk (Puppeteer)

### 3. API Endpoints

All VPS scrapers are accessible via HTTP:

```
POST /scrape/{scraper-name}
GET /health/{scraper-name}
```

Authentication: `x-api-key` header with `LSTV_SCRAPER_KEY`

### 4. Integration Points

#### Auto Tester
The auto tester now includes both local and VPS versions of scrapers:
- Local versions: `lstv`, `tsdb`, `wiki`, `bbc`, `sky`, `tnt`, `lfotv`, `footballdata`
- VPS versions: `vps-bbc`, `vps-livefootballontv`, `vps-liveonsat`, `vps-lstv`, `vps-oddalerts`, `vps-prosoccertv`, `vps-skysports`, `vps-sofascore` ⭐, `vps-sporteventz`, `vps-tnt`, `vps-wheresthematch`, `vps-worldsoccertalk`

#### Aggregator
The aggregator can call VPS scrapers in parallel:
- `enableRemoteBBC`
- `enableRemoteSkySports`
- `enableRemoteTNT`
- `enableRemoteLiveFootballOnTV`
- `enableRemoteOddAlerts`
- `enableRemoteProSoccerTV`
- `enableRemoteSportEventz`
- `enableRemoteWheresTheMatch`
- `enableRemoteWorldSoccerTalk`
- `enableRemoteSofaScore` ⭐ NEW

## Testing

All integration tests pass:

```
✓ fetchSofaScoreRemote exported: true
✓ vps-sofascore found in registry: true
✓ VPS sofascore.js file exists
✓ VPS sofascore.js loads successfully
✓ Exports scrape function: true
✓ Exports healthCheck function: true
✓ enableRemoteSofaScore option exists: true
✓ fetchSofaScoreRemote called in aggregator: true
```

## Deployment Notes

### VPS Deployment
1. Copy entire `vps-scrapers/` directory to VPS at `/opt/vps-scrapers/`
2. Run `npm install` on VPS
3. Configure environment variables (see `vps-scrapers/.env.example`)
4. Start service: `npm start` or use systemd service

### Main App Configuration
Set these environment variables in Plesk:
```
LSTV_SCRAPER_URL=http://your-vps-ip:3333
LSTV_SCRAPER_KEY=your_secret_api_key_here
```

## Migration Status

### ✅ Completed
- [x] SofaScore scraper added to VPS
- [x] SofaScore integrated in auto tester
- [x] SofaScore remote client added to lstv.js
- [x] SofaScore integrated in aggregator
- [x] Documentation updated
- [x] All syntax validated
- [x] Integration tests passing

### Architecture Complete
- [x] All scrapers use VPS for Puppeteer-based scraping
- [x] Local scrapers remain for backward compatibility
- [x] Unified remote scraper client pattern (lstv.js)
- [x] Parallel scraper execution in aggregator
- [x] Health checks for all scrapers
- [x] Auto testing infrastructure

## Files Modified

1. `vps-scrapers/server.js` - Added sofascore import, routes, health checks
2. `vps-scrapers/package.json` - Added sofascore script and axios dependency
3. `lib/auto_tester.js` - Added vps-sofascore to registry
4. `scrapers/lstv.js` - Added fetchSofaScoreRemote function
5. `aggregators/tv_channels.js` - Added sofascore remote scraper integration
6. `vps-scrapers/README.md` - Updated documentation
7. `README.md` - Updated VPS architecture documentation

## SofaScore Scraper Details

### API Strategy
SofaScore uses a different approach than other VPS scrapers:
- **Does NOT use Puppeteer** - uses axios for API calls
- Queries SofaScore's public API endpoints
- No browser automation needed
- Faster and more reliable than web scraping

### Endpoints Used
1. `GET /api/v1/sport/football/scheduled-events/{date}` - Get fixtures
2. `GET /api/v1/event/{id}/tvchannels` - Get TV channels for event

### Parameters
- `date` (optional): YYYY-MM-DD format, defaults to today
- `teamName` (optional): Filter fixtures by team name
- `maxEvents` (optional): Limit number of events, default 40

### Response Format
```json
{
  "fixtures": [
    {
      "homeTeam": "Arsenal",
      "awayTeam": "Chelsea",
      "kickoffUtc": "2024-12-02T15:00:00Z",
      "league": "England",
      "competition": "Premier League",
      "url": "https://www.sofascore.com/...",
      "channels": ["Sky Sports Main Event"]
    }
  ],
  "source": "sofascore"
}
```

## Next Steps for Production

1. **Deploy to VPS**: Use automated deployment from `/admin/vps-setup`
2. **Configure API Keys**: Set `LSTV_SCRAPER_URL` and `LSTV_SCRAPER_KEY`
3. **Test Health Checks**: Verify all `/health/{scraper}` endpoints
4. **Run Auto Tests**: Execute `npm run auto-test` to verify all scrapers
5. **Monitor Logs**: Check VPS logs for any scraping issues
6. **Enable Remote Scrapers**: Set `enableRemoteSofaScore: true` in aggregator options

## Benefits of This Architecture

1. **Separation of Concerns**: Heavy Puppeteer scraping on VPS, lightweight app on Plesk
2. **Scalability**: Can add more VPS instances for load balancing
3. **Reliability**: If VPS scraper fails, local scrapers provide fallback
4. **Maintainability**: Each scraper is independent and testable
5. **Performance**: Parallel scraper execution, cached results
6. **Flexibility**: Can enable/disable individual scrapers via options
