# Telelistings 2.0 deployment

This upgrade removes secrets from the repository. Rotate the old values before bringing the new version online because previous values existed in public Git history.

Both the Plesk app and scraper VPS now require Node.js 22.12 or newer.

## 1. Rotate credentials first

Create new values for:

- Telegram bot token: revoke/regenerate it with BotFather
- Plesk `ADMIN_PASSWORD`
- Plesk `CRON_SECRET`
- Shared VPS/Plesk `LSTV_SCRAPER_KEY`

Generate random server secrets with:

```bash
openssl rand -hex 32
```

Do not reuse any key or password previously stored in the repository.

## 2. Back up the live Plesk configuration

Before pulling the update, copy the current local configuration somewhere outside the Git checkout. Version 2 stops tracking `config.json`.

```bash
cd /path/to/telelistings
cp config.json ../telelistings-config.backup.json
git restore config.json
git pull --ff-only
```

The restore is safe here because the private live configuration is preserved in the backup. It lets Git accept the release commit that removes the tracked file. Record the real Telegram channel ID from the backup. Do not copy the old bot token into the new repository.

## 3. Update the Plesk application

If you did not pull in the previous step, upload or pull the complete repository to the Plesk application directory. Then run:

```bash
node --version
npm ci
cp config.example.json config.json
```

Edit `config.json` and replace only:

```json
"id": "@replace_with_your_channel"
```

The recommended channel mode is already configured as `uk-daily`.

In Plesk **Node.js → Custom environment variables**, add:

```text
TELEGRAM_BOT_TOKEN=<new token from BotFather>
ADMIN_PASSWORD=<new strong password>
CRON_SECRET=<new random value>
LSTV_SCRAPER_URL=http://<VPS-IP>:3333
LSTV_SCRAPER_KEY=<new shared random key>
NODE_ENV=production
```

Run `npm test`, then restart the Node.js application.

## 4. Update the VPS scraper service

Upload the entire `vps-scrapers` directory to `/opt/vps-scrapers`. Preserve your new `.env` file when replacing the program files.

```bash
cd /opt/vps-scrapers
node --version
npm ci
cp .env.example .env
nano .env
```

Set:

```text
PORT=3333
HOST=0.0.0.0
LSTV_SCRAPER_KEY=<same new key configured in Plesk>
SCRAPE_CACHE_MINUTES=20
MAX_CONCURRENT_SCRAPES=2
REQUESTS_PER_MINUTE=30
DEBUG=false
```

Install/refresh the supplied service and restart it:

```bash
sudo useradd --system --home /opt/vps-scrapers --shell /usr/sbin/nologin vps-scrapers 2>/dev/null || true
sudo chown -R vps-scrapers:vps-scrapers /opt/vps-scrapers
sudo cp vps-scrapers.service /etc/systemd/system/vps-scrapers.service
sudo systemctl daemon-reload
sudo systemctl enable vps-scrapers
sudo systemctl restart vps-scrapers
sudo systemctl status vps-scrapers
```

The supplied service starts `server.js`, which is the correct entry point.

## 5. Restrict the VPS firewall

Port 3333 should accept traffic only from the Plesk server. With UFW:

```bash
sudo ufw allow from <PLESK-SERVER-IP> to any port 3333 proto tcp
sudo ufw deny 3333/tcp
```

Use an HTTPS reverse proxy or a private network when possible because the shared key must not travel over the public internet in plain HTTP.

## 6. Verify both servers

On the VPS:

```bash
curl http://127.0.0.1:3333/health
curl -X POST http://127.0.0.1:3333/scrape/skysports \
  -H "Content-Type: application/json" \
  -H "x-api-key: <new-key>" \
  -d '{"date":"2026-09-01"}'
```

In the Plesk admin panel:

1. Open **Scrapers** and verify the VPS is healthy.
2. Open **Channels** and confirm the Telegram channel details.
3. Use **Post now** once for a controlled test.
4. Check the Telegram digest, full date, kick-off time, badges and TV channels.

## 7. Schedule automatic updates

Run the cron endpoint hourly. The post-state store prevents identical fixtures from being posted twice, while a changed time or channel is published as an update.

```bash
curl --fail --silent --show-error -X POST \
  -H "x-cron-secret: <new-cron-secret>" \
  https://<your-plesk-domain>/cron/run
```

Use a Plesk scheduled **command**, not “fetch a URL”, so the secret is sent in a header and does not appear in access logs.

An hourly schedule is gentle because the Plesk and VPS caches absorb repeat requests. A 20-minute source cache and two concurrent scrapes are the recommended defaults.

## 8. Useful channel settings

| Setting | Recommended | Effect |
|---|---:|---|
| `requireTv` | `true` | Only fixtures with a listed broadcaster |
| `maxFixturesPerRun` | `80` | Safety cap for the daily digest |
| `maxPostersPerRun` | `20` | Maximum individual images per run |
| `telegramPostDelayMs` | `3200` | Delay between posts to avoid Telegram rate limits |
| `posterStyle` | `true` | Enables the branded match images |
| `postDailyDigest` | `true` | Enables the large daily fixture list independently of cards |
| `messageExpiry.enabled` | `true` | Tracks and removes expired bot-created listings |
| `messageExpiry.posterHoursAfterKickoff` | `3` | Removes each poster three hours after kick-off |
| `messageExpiry.digestExpiryHour` | `6` | Removes the previous digest at 06:00 UK time |

Set `maxPostersPerRun` to `0` if you want the daily digest without individual match images.
The Plesk Node process checks the persistent deletion queue every 15 minutes. Telegram only permits bot deletion during the first 48 hours, so Telelistings automatically caps every deletion deadline at 47 hours after posting.
