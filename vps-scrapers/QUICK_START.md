# Quick Reference: .env Configuration

This is a quick reference guide for configuring your VPS scrapers `.env` file. For detailed instructions, see [ENV_CONFIGURATION.md](ENV_CONFIGURATION.md).

## Essential Configuration (3 Steps)

### Step 1: Create the .env file
```bash
cd /opt/vps-scrapers
cp .env.example .env
```

### Step 2: Generate a secure API key
```bash
# Run one of these commands to generate a random key:
openssl rand -base64 24
# OR
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
```

### Step 3: Edit .env and set your API key
```bash
nano .env
```

Replace the default key with your generated key:
```bash
LSTV_SCRAPER_KEY=<your-generated-key-here>
```

## Complete .env File Example

Here's what your `.env` file should look like (minimum configuration):

```bash
# Server Configuration
PORT=3333

# API Key (CHANGE THIS!)
LSTV_SCRAPER_KEY=Xk9mP2vL8qR4wN7yT5uZ3aB1cD6eF0gH

# Optional: Debug mode
DEBUG=false
```

## Sync with Plesk

After configuring the VPS `.env` file, configure these environment variables in your **Plesk Node.js Settings**:

```bash
LSTV_SCRAPER_URL=http://<your-vps-ip>:3333
LSTV_SCRAPER_KEY=Xk9mP2vL8qR4wN7yT5uZ3aB1cD6eF0gH  # Must match VPS .env
CRON_SECRET=<your_cron_secret_here>
ADMIN_PASSWORD=<your_admin_password_here>
```

**Important**: The `LSTV_SCRAPER_KEY` must be **exactly the same** in both places!

## Find Your VPS IP Address

```bash
curl -4 ifconfig.me
```

## Test Your Configuration

### 1. Restart the service
```bash
sudo systemctl restart vps-scrapers
```

### 2. Check status
```bash
sudo systemctl status vps-scrapers
```

### 3. Run health check
```bash
node /opt/vps-scrapers/scripts/health.js
# OR
curl http://localhost:3333/health
```

### 4. View logs
```bash
sudo journalctl -u vps-scrapers -f
```

## Common Issues

| Problem                          | Solution                                                     |
|----------------------------------|--------------------------------------------------------------|
| "Using default API key" warning  | Set a custom `LSTV_SCRAPER_KEY` in `.env`                   |
| 403 Forbidden errors             | Make sure API keys match in VPS `.env` and Plesk settings   |
| Connection refused               | Check service is running: `sudo systemctl status vps-scrapers` |
| Browser launch errors            | Chrome may not be installed: `which google-chrome-stable`   |

## Security Checklist

- ✅ Changed the default `LSTV_SCRAPER_KEY` to a random value
- ✅ Set proper file permissions: `chmod 600 /opt/vps-scrapers/.env`
- ✅ Configured firewall to restrict access to port 3333
- ✅ Never committed `.env` to git (it's in `.gitignore`)

## Need More Help?

See the comprehensive guide: [ENV_CONFIGURATION.md](ENV_CONFIGURATION.md)
