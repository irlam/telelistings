# VPS Scrapers Environment Configuration Guide

This guide explains how to configure the `.env` file for the VPS scrapers service.

## Quick Start

1. **Copy the template** (if not already done by the installation script):
   ```bash
   cd /opt/vps-scrapers
   cp .env.example .env
   ```

2. **Edit the .env file**:
   ```bash
   nano .env
   ```

3. **Configure the required settings** (see below)

4. **Restart the service**:
   ```bash
   sudo systemctl restart vps-scrapers
   ```

## Configuration Options

### Required Settings

#### `LSTV_SCRAPER_KEY`
**Purpose**: API key for authenticating requests from your Plesk telelistings app

**Default**: `Q0tMx1sJ8nVh3w9L2z`

**Security**: ⚠️ **IMPORTANT** - Change this to a secure random key for production use!

**How to generate a secure key**:
```bash
# Option 1: Using OpenSSL
openssl rand -base64 24

# Option 2: Using Node.js
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"

# Option 3: Using /dev/urandom
cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1
```

**Example**:
```bash
LSTV_SCRAPER_KEY=Q0tMx1sJ8nVh3w9L2z
```

**Sync with Plesk**: This key **must match** the `LSTV_SCRAPER_KEY` environment variable set in your Plesk Node.js application settings.

#### `PORT`
**Purpose**: Port number the scraper service listens on

**Default**: `3333`

**Example**:
```bash
PORT=3333
```

**Sync with Plesk**: This port must be included in the `LSTV_SCRAPER_URL` in your Plesk settings (e.g., `http://203.0.113.45:3333`)

### Optional Settings

#### `DEBUG`
**Purpose**: Enable detailed debug logging

**Default**: `false`

**Example**:
```bash
DEBUG=true
```

**When to enable**: Use this for troubleshooting scraper issues or unexpected behavior.

#### `PUPPETEER_EXECUTABLE_PATH`
**Purpose**: Custom path to Chrome/Chromium executable

**Default**: Auto-detected by the installation script

**Example**:
```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
```

**When to set**: Usually not needed as the installation script auto-detects the browser path. Set this only if you need to use a specific browser binary.

#### `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD`
**Purpose**: Skip downloading Chromium during npm install

**Default**: Not set (Puppeteer will download Chromium)

**Example**:
```bash
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
```

**When to set**: Set to `true` if Chrome/Chromium is installed system-wide and you don't need Puppeteer to download its own copy.

## Plesk Telelistings App Configuration

After configuring the `.env` file on your VPS, you need to configure matching environment variables in your Plesk Node.js application settings.

### Required Plesk Environment Variables

In your Plesk control panel, go to **Node.js Settings** and add these environment variables:

| Variable | Example Value | Description |
|----------|---------------|-------------|
| `LSTV_SCRAPER_URL` | `http://203.0.113.45:3333` | Full URL to your VPS scraper service |
| `LSTV_SCRAPER_KEY` | `Q0tMx1sJ8nVh3w9L2z` | **Must match** the key in VPS .env |
| `CRON_SECRET` | `your_cron_secret_here` | Secret for cron endpoint authentication |
| `ADMIN_PASSWORD` | `your_admin_password_here` | Password for admin GUI |

### How to Find Your VPS IP Address

If you don't know your VPS IP address:

```bash
# Method 1: Using curl
curl -4 ifconfig.me

# Method 2: Using dig
dig +short myip.opendns.com @resolver1.opendns.com

# Method 3: Using ip command
ip addr show | grep 'inet ' | grep -v '127.0.0.1'
```

Then use this IP in the `LSTV_SCRAPER_URL` setting in Plesk:
```
LSTV_SCRAPER_URL=http://<your-vps-ip>:3333
```

## Example Complete .env File

Here's a complete example `.env` file with secure settings:

```bash
# Server Configuration
PORT=3333

# API Key (CHANGE THIS!)
LSTV_SCRAPER_KEY=Q0tMx1sJ8nVh3w9L2z

# Optional: Debug mode
DEBUG=false

# Optional: Puppeteer settings (auto-detected by install script)
# PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
# PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
```

## Testing Your Configuration

### 1. Check if the service is running

```bash
sudo systemctl status vps-scrapers
```

You should see: `Active: active (running)`

### 2. Test the health endpoint

```bash
# Using the health check script
node /opt/vps-scrapers/scripts/health.js

# Or using curl
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

### 3. Test authentication

```bash
# This should return 403 Forbidden (missing/invalid key)
curl -X POST http://localhost:3333/scrape/lstv

# This should work (replace with your actual key)
curl -X POST http://localhost:3333/scrape/lstv \
  -H "Content-Type: application/json" \
  -H "x-api-key: Q0tMx1sJ8nVh3w9L2z" \
  -d '{"home": "Arsenal", "away": "Chelsea"}'
```

### 4. View logs

```bash
# Real-time logs
sudo journalctl -u vps-scrapers -f

# Last 50 lines
sudo journalctl -u vps-scrapers -n 50
```

## Troubleshooting

### "Using default API key" warning

**Problem**: The service is using the default API key

**Solution**: Set a custom `LSTV_SCRAPER_KEY` in the `.env` file and restart the service

### 403 Forbidden errors from Plesk app

**Problem**: API key mismatch between VPS and Plesk

**Solution**: 
1. Check the `LSTV_SCRAPER_KEY` in `/opt/vps-scrapers/.env`
2. Check the `LSTV_SCRAPER_KEY` in Plesk Node.js settings
3. Make sure they match exactly (including capitalization and whitespace)
4. Restart both services

### Connection refused errors

**Problem**: The scraper service is not accessible from Plesk

**Possible causes**:
1. Service is not running: `sudo systemctl start vps-scrapers`
2. Firewall blocking port 3333: `sudo ufw allow from <plesk-ip> to any port 3333`
3. Wrong IP address in Plesk `LSTV_SCRAPER_URL`

**Solution**: Check each of these and restart the service

### Puppeteer/Chrome errors

**Problem**: Browser fails to launch or crashes

**Solution**: Make sure Chrome/Chromium is installed and the path is correct:

```bash
# Check if Chrome is installed
which google-chrome-stable
which chromium-browser

# If path is wrong, update .env
echo "PUPPETEER_EXECUTABLE_PATH=$(which google-chrome-stable)" >> /opt/vps-scrapers/.env

# Restart service
sudo systemctl restart vps-scrapers
```

## Security Best Practices

1. ✅ **Use a strong random API key** - Never use the default key in production
2. ✅ **Restrict firewall access** - Only allow your Plesk server IP to access port 3333
3. ✅ **Keep the .env file secure** - Set proper file permissions: `chmod 600 .env`
4. ✅ **Never commit .env to git** - It's already in `.gitignore`
5. ✅ **Use HTTPS if possible** - Set up a reverse proxy with SSL/TLS
6. ✅ **Rotate keys periodically** - Change the API key every few months

## File Permissions

The `.env` file should only be readable by the service user:

```bash
cd /opt/vps-scrapers
chmod 600 .env
chown username:groupname .env
```

Replace `username:groupname` with the appropriate user:group running the service (e.g., `www-data:www-data`, `nodeuser:nodeuser`, or your specific service user).

## Firewall Configuration

### UFW (Ubuntu)

```bash
# Allow from specific IP only
sudo ufw allow from <plesk-server-ip> to any port 3333

# Or allow from any IP (less secure)
sudo ufw allow 3333/tcp
```

### iptables

```bash
# Allow from specific IP only
sudo iptables -A INPUT -p tcp -s <plesk-server-ip> --dport 3333 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3333 -j DROP

# Save rules
sudo iptables-save > /etc/iptables/rules.v4
```

## Need Help?

If you're still having issues:

1. Check the service logs: `sudo journalctl -u vps-scrapers -f`
2. Run the health check: `node /opt/vps-scrapers/scripts/health.js`
3. Verify the configuration: `cat /opt/vps-scrapers/.env`
4. Check the Plesk environment variables in Node.js settings
5. Test the connection from Plesk: `curl http://<vps-ip>:3333/health`

## Related Documentation

- [Main README](README.md) - VPS Scrapers overview
- [Installation Script](scripts/install-dependencies.sh) - Automated installation
- [Server Code](server.js) - Main server implementation
