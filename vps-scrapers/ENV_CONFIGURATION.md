# VPS environment configuration

Copy `.env.example` to `.env` on the VPS. The `.env` file is ignored by Git.

| Variable | Required | Recommended | Purpose |
|---|---|---:|---|
| `LSTV_SCRAPER_KEY` | Yes | New 64-character hex value | Authenticates Plesk requests |
| `PORT` | No | `3333` | Service port |
| `HOST` | No | `0.0.0.0` | Bind address |
| `SCRAPE_CACHE_MINUTES` | No | `20` | Reuses identical source results |
| `MAX_CONCURRENT_SCRAPES` | No | `2` | Limits simultaneous browser work |
| `REQUESTS_PER_MINUTE` | No | `30` | Per-client API rate limit |
| `DEBUG` | No | `false` | Extra logging |

Create a key:

```bash
openssl rand -hex 32
```

Set the same value in the VPS `.env` and Plesk `LSTV_SCRAPER_KEY` environment variable. There is no built-in fallback key.

Restart after editing:

```bash
sudo systemctl restart vps-scrapers
sudo systemctl status vps-scrapers
```

See [`../docs/DEPLOYMENT_V2.md`](../docs/DEPLOYMENT_V2.md) for the complete upgrade.
