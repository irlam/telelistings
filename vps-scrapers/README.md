# Telelistings VPS scrapers 2.0

An authenticated scraper microservice used by the main Telelistings application. It keeps browser work away from Plesk and gives every source a consistent JSON response.

## Safety defaults

- No default API key
- Constant-time key comparison
- Maximum two simultaneous scrapes
- Twenty-minute cache for identical requests
- Thirty requests per client per minute
- Shallow public health check that does not visit a source website
- Authenticated deep/source health checks
- Graceful browser shutdown

These controls reduce unnecessary load. Do not use this service to bypass CAPTCHAs, blocks, robots rules or site terms.

## Install

```bash
cd /opt/vps-scrapers
npm ci
cp .env.example .env
nano .env
```

Required `.env` values:

```text
PORT=3333
HOST=0.0.0.0
LSTV_SCRAPER_KEY=<new-random-key>
SCRAPE_CACHE_MINUTES=20
MAX_CONCURRENT_SCRAPES=2
REQUESTS_PER_MINUTE=30
DEBUG=false
```

Generate the key with `openssl rand -hex 32`. Configure the identical key as `LSTV_SCRAPER_KEY` in Plesk.

Install the service:

```bash
sudo useradd --system --home /opt/vps-scrapers --shell /usr/sbin/nologin vps-scrapers 2>/dev/null || true
sudo chown -R vps-scrapers:vps-scrapers /opt/vps-scrapers
sudo cp vps-scrapers.service /etc/systemd/system/vps-scrapers.service
sudo systemctl daemon-reload
sudo systemctl enable --now vps-scrapers
sudo systemctl status vps-scrapers
```

The correct entry point is `server.js`.

## Endpoints

`GET /health` is a shallow service health check. Scrapes use authenticated `POST /scrape/<source>` requests. Source-specific health checks use authenticated `GET /health/<source>` requests.

Available sources:

- `liveonsat`
- `lstv`
- `skysports`
- `premiersports`

Example:

```bash
curl -X POST http://127.0.0.1:3333/scrape/skysports \
  -H "Content-Type: application/json" \
  -H "x-api-key: <new-random-key>" \
  -d '{"date":"2026-09-01"}'
```

Successful responses include `_meta.cacheHit` and either `_meta.fetchedAt` or `_meta.cachedAt`.

## Firewall

Allow port 3333 only from the Plesk application server. Prefer a private network or HTTPS reverse proxy when the traffic crosses the public internet.

Full instructions are in [`../docs/DEPLOYMENT_V2.md`](../docs/DEPLOYMENT_V2.md).
