# VPS Scraper Setup Guide

This comprehensive guide walks you through setting up the VPS scrapers from scratch, assuming the `vps-scrapers` folder is already in `/opt/` on your VPS.

## Prerequisites

- A VPS running Ubuntu 20.04+ (or similar Linux distribution)
- SSH access to your VPS
- Node.js 18.x or higher
- The `vps-scrapers` folder already placed in `/opt/vps-scrapers/`

## Quick Reference

| Setting | Value |
|---------|-------|
| VPS URL | `http://185.170.113.230:3333` |
| API Key | `Q0tMx1sJ8nVh3w9L2z` |
| Installation Path | `/opt/vps-scrapers/` |
| Port | `3333` |

---

## Step-by-Step Setup Instructions

### Step 1: Connect to Your VPS

```bash
ssh user@185.170.113.230
```

Replace `user` with your VPS username.

### Step 2: Navigate to the Scrapers Directory

```bash
cd /opt/vps-scrapers
```

Verify the files are present:

```bash
ls -la
```

You should see:
- `server.js`
- `package.json`
- `scrapers/` directory
- `.env.example`

### Step 3: Install Node.js (if not already installed)

```bash
# Check if Node.js is installed
node --version

# If not installed, install Node.js 18.x
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version
npm --version
```

### Step 4: Install Chromium Dependencies for Puppeteer

Puppeteer requires Chromium. Install the required dependencies:

```bash
sudo apt-get update

# Install Chromium and all required dependencies
sudo apt-get install -y \
    chromium-browser \
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
```

### Step 5: Install npm Dependencies

```bash
cd /opt/vps-scrapers
npm install
```

This will install:
- `express` - Web server framework
- `puppeteer` - Browser automation for scraping

### Step 6: Configure Environment Variables

Create the `.env` file from the example:

```bash
cp .env.example .env
```

Edit the `.env` file:

```bash
nano .env
```

The default configuration should work out of the box:

```env
# VPS Scrapers Configuration
PORT=3333

# API Key for authentication - MUST match the Plesk app's LSTV_SCRAPER_KEY
LSTV_SCRAPER_KEY=Q0tMx1sJ8nVh3w9L2z

# Optional: Enable debug logging
DEBUG=false
```

**Important:** The `LSTV_SCRAPER_KEY` must match what's configured in your Plesk telelistings app.

Save and exit (Ctrl+X, then Y, then Enter).

### Step 7: Test the Server (Quick Start)

Test that everything works:

```bash
npm start
```

You should see output like:

```
[INIT] Loaded module: bbc
[INIT] Loaded module: livefootballontv
[INIT] Loaded module: liveonsat
[INIT] Loaded module: lstv
...
VPS Scraper microservice listening on port 3333
Registered routes: XX
Supported sources: bbc, livefootballontv, liveonsat, lstv, ...
```

Press `Ctrl+C` to stop the test.

### Step 8: Set Up for Production

Choose one of the following options for running the server in production:

#### Option A: Using PM2 (Recommended)

PM2 is a process manager that keeps your server running and restarts it automatically:

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start the server with PM2
cd /opt/vps-scrapers
pm2 start server.js --name "vps-scrapers"

# Save the PM2 process list for auto-restart on reboot
pm2 save

# Enable PM2 to start on system boot
pm2 startup
```

Follow any instructions PM2 provides (usually a command to copy/paste).

#### Option B: Using systemd

For systems where you prefer systemd service management:

```bash
# (Optional) Create a dedicated user for better security
sudo useradd -r -s /bin/false vps-scrapers
sudo chown -R vps-scrapers:vps-scrapers /opt/vps-scrapers
# Then edit the service file to change User=root to User=vps-scrapers

# Copy the service file to systemd directory
sudo cp /opt/vps-scrapers/vps-scrapers.service /etc/systemd/system/

# Reload systemd to recognize the new service
sudo systemctl daemon-reload

# Enable the service to start on boot
sudo systemctl enable vps-scrapers

# Start the service
sudo systemctl start vps-scrapers

# Check service status
sudo systemctl status vps-scrapers
```

**Managing with systemd:**
```bash
# Restart the service
sudo systemctl restart vps-scrapers

# Stop the service
sudo systemctl stop vps-scrapers

# View logs
sudo journalctl -u vps-scrapers -f
```

### Step 9: Verify the Server is Running

Test the health endpoint:

```bash
curl http://localhost:3333/health
```

Expected response:

```json
{
  "ok": true,
  "latencyMs": 1234,
  "title": "Live Soccer TV - TV Guide for Soccer & Football",
  "sources": ["bbc", "livefootballontv", "liveonsat", "lstv", ...]
}
```

Test externally (from your local machine):

```bash
curl http://185.170.113.230:3333/health
```

### Step 10: Configure Firewall (Optional but Recommended)

Allow access only from your Plesk server:

```bash
# Using UFW (Ubuntu)
sudo ufw allow from YOUR_PLESK_SERVER_IP to any port 3333
sudo ufw enable
```

---

## Useful PM2 Commands

```bash
# View running processes
pm2 status

# View logs
pm2 logs vps-scrapers

# Follow logs in real-time
pm2 logs vps-scrapers --follow

# Restart the server
pm2 restart vps-scrapers

# Stop the server
pm2 stop vps-scrapers

# Delete from PM2 (to re-add)
pm2 delete vps-scrapers
```

---

## Troubleshooting

### "Module not loaded" Errors

If you see errors like `[INIT] Skipping route /scrape/xxx - module not loaded`:

1. Check that all files exist in `/opt/vps-scrapers/scrapers/`
2. Run `npm install` again
3. Check for syntax errors: `node -c scrapers/xxx.js`

### "Browser Failed to Launch" Errors

Puppeteer/Chromium issues:

```bash
# Reinstall dependencies
sudo apt-get install -y chromium-browser libnss3 libnspr4 libatk1.0-0

# Set Chrome path explicitly (add to .env)
echo 'PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser' >> .env

# Restart
pm2 restart vps-scrapers
```

### Permission Denied Errors

```bash
# Fix ownership
sudo chown -R $USER:$USER /opt/vps-scrapers

# Fix permissions
chmod +x /opt/vps-scrapers/server.js
```

### Port Already in Use

```bash
# Check what's using port 3333
sudo lsof -i :3333

# Kill the process if needed
sudo kill -9 <PID>

# Or change the port in .env
echo 'PORT=3334' >> .env
```

### Memory Issues

```bash
# Increase Node.js memory limit
pm2 delete vps-scrapers
NODE_OPTIONS="--max-old-space-size=2048" pm2 start server.js --name "vps-scrapers"
pm2 save
```

---

## Updating the VPS Scrapers

When new scraper code is available:

```bash
# If using git
cd /opt/vps-scrapers
git pull origin main

# If manually uploading, copy new files then:
cd /opt/vps-scrapers
npm install  # In case dependencies changed

# Restart the server
pm2 restart vps-scrapers

# Check logs for any errors
pm2 logs vps-scrapers --lines 50
```

---

## API Endpoints Reference

### Health Check

```bash
curl http://185.170.113.230:3333/health
```

### List Sources

```bash
curl http://185.170.113.230:3333/sources
```

### Test a Scraper

```bash
# Test LiveFootballOnTV scraper
curl -X POST http://185.170.113.230:3333/scrape/livefootballontv \
  -H "Content-Type: application/json" \
  -H "x-api-key: Q0tMx1sJ8nVh3w9L2z" \
  -d '{}'

# Test BBC scraper
curl -X POST http://185.170.113.230:3333/scrape/bbc \
  -H "Content-Type: application/json" \
  -H "x-api-key: Q0tMx1sJ8nVh3w9L2z" \
  -d '{"teamName": "Arsenal"}'
```

---

## Plesk App Configuration

On your Plesk telelistings app, ensure these settings are configured:

### Environment Variables (via `/admin/environment`)

| Variable | Value |
|----------|-------|
| `LSTV_SCRAPER_URL` | `http://185.170.113.230:3333` |
| `LSTV_SCRAPER_KEY` | `Q0tMx1sJ8nVh3w9L2z` |

Or in `config.json`:

```json
{
  "envVars": {
    "LSTV_SCRAPER_URL": "http://185.170.113.230:3333",
    "LSTV_SCRAPER_KEY": "Q0tMx1sJ8nVh3w9L2z"
  }
}
```

---

## Complete Setup Checklist

- [ ] SSH to VPS
- [ ] Navigate to `/opt/vps-scrapers`
- [ ] Install Node.js 18+
- [ ] Install Chromium dependencies
- [ ] Run `npm install`
- [ ] Copy `.env.example` to `.env`
- [ ] Test with `npm start`
- [ ] **Option A: PM2**
  - [ ] Install PM2 (`sudo npm install -g pm2`)
  - [ ] Start with PM2 (`pm2 start server.js --name "vps-scrapers"`)
  - [ ] Enable auto-start (`pm2 startup` and `pm2 save`)
- [ ] **Option B: systemd**
  - [ ] Copy service file (`sudo cp vps-scrapers.service /etc/systemd/system/`)
  - [ ] Reload systemd (`sudo systemctl daemon-reload`)
  - [ ] Enable service (`sudo systemctl enable vps-scrapers`)
  - [ ] Start service (`sudo systemctl start vps-scrapers`)
- [ ] Test health endpoint externally
- [ ] Configure Plesk app with VPS URL and API key
- [ ] Test from Plesk admin panel (Auto-Test page)

---

## Support

If you encounter issues:

1. Check VPS logs: `pm2 logs vps-scrapers`
2. Test health endpoint: `curl http://185.170.113.230:3333/health`
3. Test from Plesk: `/admin/vps-debug` page
4. Check registered routes: `curl http://185.170.113.230:3333/debug/routes`
