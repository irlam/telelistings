# VPS Scrapers for Telelistings

This folder contains Puppeteer-based scrapers designed to run on your VPS. These scrapers are called remotely from your Plesk telelistings app.

## 📖 Documentation

- **[ENV_CONFIGURATION.md](ENV_CONFIGURATION.md)** - Comprehensive guide for configuring the `.env` file with API keys and settings
- **[README.md](README.md)** - This file (general overview and deployment instructions)

## 🚀 Quick Start (Automated Deployment)

The easiest way to deploy the VPS scrapers is using the **automated deployment system** in the admin panel:

1. **Open the Admin Panel**: Navigate to `/admin/vps-setup` in your telelistings app
2. **Configure VPS Connection**: Enter your VPS SSH details (host, port, username, authentication)
3. **Test Connection**: Click "Test Connection" to verify SSH access
4. **Deploy**: Click "Deploy to VPS" to automatically:
   - Upload all scraper files to your VPS
   - Install Node.js and Chrome/Chromium
   - Install npm dependencies
   - Configure the systemd service
   - Run health checks

That's it! The entire deployment process is automated.

### Prerequisites for Automated Deployment

- SSH access to your VPS (key-based authentication recommended)
- Root or sudo access on the VPS
- Ubuntu/Debian or CentOS/RHEL/Fedora Linux distribution

## 📁 Default VPS Location

The default installation path on your VPS is: `/opt/vps-scrapers/`

## 📁 Folder Structure

```
/opt/vps-scrapers/
├── server.js                    # Main Express server (scraper microservice)
├── package.json                 # Dependencies and scripts
├── .env.example                 # Environment configuration template
├── .env                         # Your actual configuration (created from .env.example)
├── README.md                    # This file
├── ENV_CONFIGURATION.md         # Comprehensive .env configuration guide
├── scripts/                     # Utility scripts
│   └── health.js                # Health check script
└── scrapers/                    # Individual scrapers (all export unified scrape() function)
    ├── lstv.js                  # LiveSoccerTV scraper
    ├── bbc.js                   # BBC Sport scraper
    ├── skysports.js             # Sky Sports scraper
    ├── tnt.js                   # TNT Sports scraper
    ├── livefootballontv.js      # LiveFootballOnTV scraper
    ├── liveonsat.js             # LiveOnSat UK Football scraper (daily)
    ├── wheresthematch.js        # Where's The Match UK scraper
    ├── oddalerts.js             # OddAlerts TV Guide scraper
    ├── prosoccertv.js           # ProSoccer.TV scraper
    ├── worldsoccertalk.js       # World Soccer Talk scraper
    └── sporteventz.js           # SportEventz scraper
```

## 🚀 Quick Start

### Automated Deployment (Recommended)

See the section above for automated deployment using the admin panel.

### Manual Deployment

If you prefer manual deployment or automated deployment doesn't work for your setup:

#### 1. Transfer Files to VPS

Copy this entire `vps-scrapers` folder to your VPS at `/opt/vps-scrapers/`:

```bash
# Using SCP from your local machine
scp -r vps-scrapers/ user@your-vps-ip:/opt/vps-scrapers/

# Or using rsync
rsync -avz vps-scrapers/ user@your-vps-ip:/opt/vps-scrapers/
```

#### 2. Install Dependencies on VPS

The automated installation script handles everything:

```bash
cd /opt/vps-scrapers
chmod +x scripts/*.sh
sudo bash scripts/install-dependencies.sh
```

This script will:
- Install Node.js (v18+)
- Install Chrome/Chromium with all required dependencies
- Install npm packages
- Configure the environment (.env file)
- Set up the systemd service

**Or install manually:**

SSH into your VPS and run:

```bash
cd /opt/vps-scrapers
npm install
```

### 3. Install Chrome/Chromium (Required for Puppeteer)

**Automated (using the provided script):**

```bash
cd /opt/vps-scrapers
# The install-chrome-headless.sh is standalone, or use the full install-dependencies.sh
sudo bash scripts/install-dependencies.sh
```

**Or manually on Ubuntu/Debian:**
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
cd /opt/vps-scrapers
cp .env.example .env

# Edit .env with your preferred settings
nano .env
```

**Important:** 
- Change the `LSTV_SCRAPER_KEY` to a secure random key!
- See [ENV_CONFIGURATION.md](ENV_CONFIGURATION.md) for detailed configuration instructions

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
pm2 start server.js --name "vps-scrapers"

# Enable auto-start on system reboot
pm2 startup
pm2 save

# View logs
pm2 logs vps-scrapers
```

**For production (using systemd):**

A `systemd` service can be used to keep the VPS scrapers running in the background and start them automatically on boot.

#### 1. Create the service file

Create the service file in `/opt/vps-scrapers`:

```bash
cd /opt/vps-scrapers
sudo nano vps-scrapers.service
```

Add the following content:

```ini
# File: vps-scrapers.service
# Description:
#   Systemd unit file to manage the vps-scrapers service for the telelistings project.
#   This service runs the scraper process from /opt/vps-scrapers using Node.js,
#   restarting automatically if it crashes. It is intended to be enabled so
#   that it starts on boot and can be controlled with systemctl.
#
#   Name: vps-scrapers.service
#
# Notes:
#   - Assumes the project is located at /opt/vps-scrapers
#   - Assumes Node.js is available at /usr/bin/node
#   - Adjust User=, Group= and ExecStart= if your setup differs.

[Unit]
Description=Telelistings VPS Scrapers Service
After=network.target

[Service]
User=irlam
Group=irlam
WorkingDirectory=/opt/vps-scrapers

# Update ExecStart if your start command is different (for example: /usr/bin/npm start)
ExecStart=/usr/bin/node index.js

Restart=always
RestartSec=10

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

#### 2. Install and enable the service

Copy the service file into the systemd directory and reload systemd:

```bash
cd /opt/vps-scrapers
sudo cp vps-scrapers.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Enable the service so it starts on boot, then start it:

```bash
sudo systemctl enable vps-scrapers.service
sudo systemctl start vps-scrapers.service
```

Check the status:

```bash
sudo systemctl status vps-scrapers.service
```

You should see the service in the `active (running)` state, with a `node` process such as:

```text
● vps-scrapers.service - Telelistings VPS Scrapers Service
     Loaded: loaded (/etc/systemd/system/vps-scrapers.service; enabled; preset: enabled)
     Active: active (running)
   Main PID: 95291 (node)
```

To stop or restart the service:

```bash
sudo systemctl stop vps-scrapers.service
sudo systemctl restart vps-scrapers.service
```

To view logs:

```bash
sudo journalctl -u vps-scrapers -f
```

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3333` | Port the server listens on |
| `LSTV_SCRAPER_KEY` | `Q0tMx1sJ8nVh3w9L2z` | API key for authentication |
| `DEBUG` | `false` | Enable debug logging |

### Plesk Client Configuration

On your Plesk telelistings app, set these environment variables:

```bash
LSTV_SCRAPER_URL=http://185.170.113.230:3333
LSTV_SCRAPER_KEY=Q0tMx1sJ8nVh3w9L2z
```

## 🌐 API Endpoints

### Service Discovery

#### GET /health
Main health check - checks if service is running and browser works.

**Response:**
```json
{
  "ok": true,
  "latencyMs": 1234,
  "title": "Live Soccer TV - TV Guide for Soccer & Football",
  "sources": ["bbc", "livefootballontv", "liveonsat", "lstv", "oddalerts", "prosoccertv", "skysports", "sporteventz", "tnt", "wheresthematch", "worldsoccertalk"]
}
```

#### GET /sources
Returns list of all supported scraper sources with their paths.

**Response:**
```json
{
  "sources": [
    { "name": "bbc", "path": "/scrape/bbc", "description": "BBC Sport fixtures" },
    { "name": "livefootballontv", "path": "/scrape/livefootballontv", "description": "Live Football On TV" },
    { "name": "liveonsat", "path": "/scrape/liveonsat", "description": "LiveOnSat UK Football (daily)" },
    { "name": "lstv", "path": "/scrape/lstv", "description": "LiveSoccerTV listings" },
    { "name": "oddalerts", "path": "/scrape/oddalerts", "description": "OddAlerts TV Guide" },
    { "name": "prosoccertv", "path": "/scrape/prosoccertv", "description": "ProSoccer.TV" },
    { "name": "skysports", "path": "/scrape/skysports", "description": "Sky Sports fixtures" },
    { "name": "sporteventz", "path": "/scrape/sporteventz", "description": "SportEventz" },
    { "name": "tnt", "path": "/scrape/tnt", "description": "TNT Sports fixtures" },
    { "name": "wheresthematch", "path": "/scrape/wheresthematch", "description": "Where's The Match UK" },
    { "name": "worldsoccertalk", "path": "/scrape/worldsoccertalk", "description": "World Soccer Talk" }
  ]
}
```

### Scrape Endpoints

All scrape endpoints require the `x-api-key` header for authentication and accept POST requests with JSON body.

**Common Response Format:**
```json
{
  "fixtures": [
    {
      "homeTeam": "Arsenal",
      "awayTeam": "Chelsea",
      "kickoffUtc": "2024-12-02T15:00:00Z",
      "league": "Premier League",
      "competition": "Premier League",
      "url": "https://...",
      "channels": ["Sky Sports Main Event", "Sky Sports Premier League"],
      "regionChannels": [{ "region": "UK", "channel": "Sky Sports" }]
    }
  ],
  "source": "lstv"
}
```

#### POST /scrape/lstv
Scrape LiveSoccerTV for TV listings.

**Request:**
```json
{
  "home": "Arsenal",
  "away": "Chelsea",
  "dateUtc": "2024-12-02T15:00:00Z",
  "leagueHint": "Premier League"
}
```

#### POST /scrape/bbc
Scrape BBC Sport fixtures.

**Request:**
```json
{
  "teamName": "Arsenal",
  "teamSlug": "arsenal"
}
```

#### POST /scrape/skysports
Scrape Sky Sports fixtures.

**Request:**
```json
{
  "teamName": "Arsenal",
  "competition": "Premier League"
}
```

#### POST /scrape/tnt
Scrape TNT Sports fixtures.

**Request:**
```json
{
  "teamName": "Arsenal",
  "competition": "Champions League"
}
```

#### POST /scrape/livefootballontv
Scrape Live Football On TV.

**Request:**
```json
{
  "teamName": "Arsenal",
  "competition": "Premier League"
}
```

#### POST /scrape/wheresthematch
Scrape Where's The Match UK.

**Request:**
```json
{
  "date": "2024-12-02"
}
```

#### POST /scrape/liveonsat
Scrape LiveOnSat UK Football (daily fixtures).

**Request:**
```json
{
  "date": "2024-12-02"
}
```

#### POST /scrape/oddalerts
Scrape OddAlerts TV Guide.

**Request:**
```json
{
  "date": "2024-12-02"
}
```

#### POST /scrape/prosoccertv
Scrape ProSoccer.TV.

**Request:**
```json
{
  "leagueUrl": "https://prosoccer.tv/england"
}
```

#### POST /scrape/worldsoccertalk
Scrape World Soccer Talk.

**Request:**
```json
{
  "scheduleUrl": "https://worldsoccertalk.com/tv-schedule/english-premier-league-tv-schedule/"
}
```

#### POST /scrape/sporteventz
Scrape SportEventz.

**Request:**
```json
{
  "date": "2024-12-02"
}
```

### Individual Health Checks

Each scraper has its own health check endpoint:

- `GET /health/bbc`
- `GET /health/livefootballontv`
- `GET /health/liveonsat`
- `GET /health/lstv`
- `GET /health/oddalerts`
- `GET /health/prosoccertv`
- `GET /health/skysports`
- `GET /health/sporteventz`
- `GET /health/tnt`
- `GET /health/wheresthematch`
- `GET /health/worldsoccertalk`

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
  -H "x-api-key: Q0tMx1sJ8nVh3w9L2z" \
  -d '{"home": "Arsenal", "away": "Chelsea"}'
```

### Test Sources Endpoint

```bash
curl http://localhost:3333/sources
```

### Run Individual Scrapers

```bash
# Test Sky Sports scraper
node scrapers/skysports.js

# Test BBC scraper
node scrapers/bbc.js

# Test LiveFootballOnTV scraper
node scrapers/livefootballontv.js

# Test LiveOnSat scraper
node scrapers/liveonsat.js

# Test TNT Sports scraper
node scrapers/tnt.js

# Test LSTV scraper
node scrapers/lstv.js

# Test Where's The Match scraper
node scrapers/wheresthematch.js

# Test OddAlerts scraper
node scrapers/oddalerts.js

# Test ProSoccer.TV scraper
node scrapers/prosoccertv.js

# Test World Soccer Talk scraper
node scrapers/worldsoccertalk.js

# Test SportEventz scraper
node scrapers/sporteventz.js
```

Or use npm scripts:
```bash
npm run scraper:sky
npm run scraper:bbc
npm run scraper:lfotv
npm run scraper:liveonsat
npm run scraper:tnt
npm run scraper:wtm
npm run scraper:oddalerts
npm run scraper:prosoccertv
npm run scraper:wst
npm run scraper:sporteventz
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
tail -f /opt/vps-scrapers/scraper.log
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
cd /opt/vps-scrapers
git pull  # if using git
npm install
pm2 restart lstv-scraper
```

## 📝 License

MIT License - Feel free to modify and use as needed.
