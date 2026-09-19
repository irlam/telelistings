# VPS quick start

```bash
cd /opt/vps-scrapers
npm ci
cp .env.example .env
openssl rand -hex 32
nano .env
sudo useradd --system --home /opt/vps-scrapers --shell /usr/sbin/nologin vps-scrapers 2>/dev/null || true
sudo chown -R vps-scrapers:vps-scrapers /opt/vps-scrapers
sudo cp vps-scrapers.service /etc/systemd/system/vps-scrapers.service
sudo systemctl daemon-reload
sudo systemctl enable --now vps-scrapers
curl http://127.0.0.1:3333/health
```

Put the newly generated key in `LSTV_SCRAPER_KEY` on both the VPS and Plesk. Never commit `.env` or put the key in documentation.
