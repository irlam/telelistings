# VPS Scrapers for Telelistings

This folder contains Puppeteer-based scrapers designed to run on your VPS. These scrapers are called remotely from your Plesk telelistings app.

## 📁 Folder Structure

```
vps-scrapers/
├── server.js                    # Main Express server (LiveSoccerTV scraper microservice)
├── package.json                 # Dependencies and scripts
├── .env.example                 # Environment configuration template
├── README.md                    # This file
├── scripts/                     # Utility scripts
│   └── health.js                # Health check script
└── scrapers/                    # Additional scrapers
    ├── lstv.js                  # Enhanced LiveSoccerTV scraper
    ├── skysports.js             # Sky Sports scraper (Puppeteer)
    ├── bbc.js                   # BBC Sport scraper (Puppeteer)
    ├── livefootballontv.js      # LiveFootballOnTV scraper (Puppeteer)
    └── tnt.js                   # TNT Sports scraper (Puppeteer)
```

## 🚀 Quick Start

### 1. Transfer Files to VPS

Copy this entire `vps-scrapers` folder to your VPS:

```bash
# Using SCP from your local machine
scp -r vps-scrapers/ user@your-vps-ip:/home/user/

# Or using rsync
rsync -avz vps-scrapers/ user@your-vps-ip:/home/user/vps-scrapers/
```

### 2. Install Dependencies on VPS

SSH into your VPS and run:

```bash
cd /home/user/vps-scrapers
npm install
```

### 3. Install Chrome/Chromium (Required for Puppeteer)

**Ubuntu/Debian:**
```bash
# Update package list
sudo apt-get update

# Install Chrome dependencies
sudo apt-get install -y \
    gconf-service \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    fonts-liberation \
    libappindicator1 \
    libnss3 \
    lsb-release \
    xdg-utils \
    wget

# Install Chromium (lighter alternative to Chrome)
sudo apt-get install -y chromium-browser
```

**CentOS/RHEL:**
```bash
sudo yum install -y chromium
```

### 4. Configure Environment

```bash
cd /home/user/vps-scrapers
cp .env.example .env

# Edit .env with your preferred settings
nano .env
```

**Important:** Change the `LSTV_API_KEY` to a secure random key!

### 5. Start the Server

**For testing:**
```bash
npm start
```

**For production (using PM2):**
```bash
# Install PM2 globally
sudo npm install -g pm2

# Start the server
pm2 start server.js --name "lstv-scraper"

# Enable auto-start on system reboot
pm2 startup
pm2 save

# View logs
pm2 logs lstv-scraper
```

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3333` | Port the server listens on |
| `LSTV_API_KEY` | `Subaru5554346` | API key for authentication |
| `DEBUG` | `false` | Enable debug logging |

### Plesk Client Configuration

On your Plesk telelistings app, set these environment variables:

```bash
LSTV_SCRAPER_URL=http://YOUR_VPS_IP:3333
LSTV_SCRAPER_KEY=your-secure-api-key
```

## 🌐 API Endpoints

### Health Check

```bash
GET /health
```

Response:
```json
{
  "ok": true,
  "latencyMs": 1234,
  "title": "Live Soccer TV - TV Guide for Soccer & Football"
}
```

### Scrape Fixture TV Listings

```bash
POST /scrape/lstv
Headers:
  x-api-key: your-api-key
Body:
{
  "home": "Arsenal",
  "away": "Chelsea",
  "dateUtc": "2024-12-02T15:00:00Z",
  "leagueHint": "Premier League"
}
```

Response:
```json
{
  "ok": true,
  "data": {
    "url": "https://www.livesoccertv.com/match/...",
    "kickoffUtc": "2024-12-02T15:00:00Z",
    "league": "Premier League",
    "regionChannels": [
      { "region": "United Kingdom", "channel": "Sky Sports Main Event" },
      { "region": "United States", "channel": "NBC Sports" }
    ],
    "meta": {
      "title": "Arsenal vs Chelsea - Match Details",
      "latencyMs": 2341
    }
  }
}
```

## 🧪 Testing

### Test Health Check

```bash
# Using the npm script (recommended)
npm run health

# Or directly
node scripts/health.js

# Or with curl
curl http://localhost:3333/health
```

### Test Scrape Endpoint

```bash
curl -X POST http://localhost:3333/scrape/lstv \
  -H "Content-Type: application/json" \
  -H "x-api-key: Subaru5554346" \
  -d '{"home": "Arsenal", "away": "Chelsea"}'
```

### Run Individual Scrapers

```bash
# Test Sky Sports scraper
node scrapers/skysports.js

# Test BBC scraper
node scrapers/bbc.js

# Test LiveFootballOnTV scraper
node scrapers/livefootballontv.js

# Test TNT Sports scraper
node scrapers/tnt.js

# Test LSTV scraper
node scrapers/lstv.js
```

## 🔒 Security

### Firewall Configuration

Only allow access from your Plesk server IP:

```bash
# Using UFW (Ubuntu)
sudo ufw allow from YOUR_PLESK_IP to any port 3333

# Using iptables
sudo iptables -A INPUT -p tcp -s YOUR_PLESK_IP --dport 3333 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3333 -j DROP
```

### Nginx Reverse Proxy (Optional)

If you want to use HTTPS, set up Nginx as a reverse proxy:

```nginx
server {
    listen 443 ssl;
    server_name scraper.yourdomain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:3333;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 🐛 Troubleshooting

### Puppeteer Errors

**"No usable sandbox":**
The server already uses `--no-sandbox` flag, but ensure your VPS allows running headless browsers.

**"Failed to launch browser":**
```bash
# Install missing dependencies
sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2
```

**"Chromium not found":**
```bash
# Set custom Chrome path in .env
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

### Memory Issues

If the server runs out of memory:

```bash
# Increase Node.js memory limit
NODE_OPTIONS="--max-old-space-size=2048" pm2 start server.js --name "lstv-scraper"
```

### Logs

```bash
# PM2 logs
pm2 logs lstv-scraper

# Or view log file
tail -f /home/user/vps-scrapers/scraper.log
```

## 📊 Monitoring

### PM2 Monitoring

```bash
# View status
pm2 status

# View detailed info
pm2 info lstv-scraper

# Monitor in real-time
pm2 monit
```

### Health Check Script

Add this to cron for automated monitoring:

```bash
# Check every 5 minutes
*/5 * * * * curl -sf http://localhost:3333/health > /dev/null || pm2 restart lstv-scraper
```

## 🔄 Updates

To update the scrapers:

```bash
cd /home/user/vps-scrapers
git pull  # if using git
npm install
pm2 restart lstv-scraper
```

## 📝 License

MIT License - Feel free to modify and use as needed.
