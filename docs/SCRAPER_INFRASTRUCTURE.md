# Scraper infrastructure

Telelistings uses eight production sources. The dashboard and Auto-Test registry
must contain this same set; a scraper should not be left installed but hidden.

## Plesk-side sources

| ID | Purpose |
|---|---|
| `tsdb` | Fixture validation, competition data and team badges |
| `wiki` | UK competition broadcast-rights reference |
| `bbc` | UK fixture cross-check |
| `lfotv` | UK television-listing cross-check |

## VPS sources

| ID | Endpoint | Purpose |
|---|---|---|
| `vps-liveonsat` | `/scrape/liveonsat` | Broad UK and satellite listings |
| `vps-lstv` | `/scrape/lstv` | Regional broadcaster listings |
| `vps-skysports` | `/scrape/skysports` | Official Sky Sports football guide |
| `vps-premiersports` | `/scrape/premiersports` | Official Premier Sports live guide |

The VPS exposes an authenticated `POST /scrape/<source>` endpoint and an
authenticated deep `GET /health/<source>` endpoint for each source. `GET
/health` is a shallow service check and does not visit upstream sites.

## Reliability controls

- Twenty-minute response cache
- Maximum two concurrent browser scrapes
- Per-client request limiting
- Request spacing and one retry for temporary upstream failures
- IPTV channel alias normalisation
- Highlights/replay exclusion from live listings
- Internal cross-source confidence tracking after fixture merging

Do not bypass access controls, CAPTCHAs, robots rules or source terms. If an
official guide blocks or removes automated access, disable it until a compliant
replacement is available.

## Verification

Run the offline suite with `npm test`. In the admin panel, run **Auto-Test** and
expect eight registered sources. On the VPS, `GET /sources` should report four
sources and eight registered source routes.

Deployment and firewall instructions are in [DEPLOYMENT_V2.md](DEPLOYMENT_V2.md).
