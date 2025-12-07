# VPS Remote Deployment Feature Documentation

## Overview

This feature adds a comprehensive remote deployment system to the Telelistings admin panel, allowing one-click installation of all VPS scraper dependencies on a remote VPS server via SSH.

## What Problem Does This Solve?

Previously, users had to:
1. Manually SSH into their VPS
2. Install Node.js, Chrome/Chromium, and system dependencies
3. Copy files manually using rsync or scp
4. Configure environment variables
5. Set up systemd services

**The Puppeteer installation would often fail** because Chrome couldn't be downloaded automatically, requiring complex manual intervention.

## New Solution

With this feature, users can now:
1. Configure their VPS SSH credentials in the admin panel
2. Click "Deploy to VPS" button
3. Wait a few minutes while the system automatically:
   - Connects to the VPS via SSH
   - Transfers all scraper files
   - Installs Node.js v18+
   - Installs Chrome/Chromium with all dependencies
   - Installs npm packages
   - Configures environment
   - Sets up systemd service

## Features Added

### 1. SSH Client Library (`lib/ssh-client.js`)

A comprehensive SSH client wrapper that provides:
- SSH key and password authentication
- Remote command execution
- File and directory upload/download
- Connection testing
- Error handling

**Methods:**
- `testConnection()` - Test SSH connectivity
- `connect()` - Establish SSH connection
- `disconnect()` - Close connection
- `executeCommand(command)` - Run a command on VPS
- `executeCommands(commands[])` - Run multiple commands
- `uploadFile(local, remote)` - Upload a single file
- `uploadDirectory(local, remote)` - Upload entire directory
- `downloadFile(remote, local)` - Download a file
- `exists(remotePath)` - Check if file/directory exists

### 2. Installation Scripts

#### `vps-scrapers/scripts/install-dependencies.sh`

Comprehensive installation script that:
- Auto-detects Linux distribution (Ubuntu/Debian/CentOS/RHEL/Fedora)
- Installs Node.js v18+ from NodeSource
- Installs Chrome/Chromium with all required system libraries
- Configures Puppeteer to use the installed browser
- Installs npm packages
- Creates .env file from template
- Sets up systemd service for auto-start
- Runs health checks

**Features:**
- Colored output for better readability
- Comprehensive error handling
- Support for multiple Linux distributions
- Automatic Chrome binary detection
- Service configuration

#### `vps-scrapers/scripts/deploy.sh`

Deployment script for manual deployment:
- Tests SSH connection
- Creates remote directory
- Syncs files using rsync
- Excludes node_modules and temporary files
- Runs installation script remotely

### 3. Admin Panel Integration

#### New Page: `/admin/vps-setup`

**Configuration Form:**
- VPS Host (IP or domain)
- SSH Port (default: 22)
- Username
- Authentication method selector:
  - SSH Key (recommended) - with private key path
  - Password - with secure password storage
- VPS Directory (default: /opt/vps-scrapers)

**Actions:**
- **Test Connection** - Verifies SSH connectivity before deployment
- **Deploy to VPS** - One-click deployment with live log output
- **Save Configuration** - Stores credentials securely in config.json

**UI Features:**
- Real-time deployment log display
- Status messages (success/error/info)
- Progress indication
- Manual deployment instructions as fallback
- Security warnings for password authentication

### 4. Backend Endpoints

**POST `/admin/vps-setup/save`**
- Saves VPS configuration to config.json
- Handles both key and password authentication
- Validates required fields

**POST `/admin/vps-setup/test`**
- Tests SSH connection to configured VPS
- Returns success/failure status with message

**POST `/admin/vps-setup/deploy`**
- Executes full deployment process:
  1. Connects to VPS via SSH
  2. Creates remote directory
  3. Uploads all vps-scrapers files
  4. Makes scripts executable
  5. Runs installation script
  6. Returns deployment log and status

### 5. Updated Documentation

Enhanced `vps-scrapers/README.md` with:
- Automated deployment instructions (recommended method)
- Prerequisites for automated deployment
- Manual deployment fallback instructions
- Troubleshooting guide
- Links to admin panel features

## Security Considerations

1. **SSH Key Authentication** - Recommended over passwords
2. **Credential Storage** - Credentials stored in config.json (should be secured)
3. **Password Masking** - Passwords hidden in UI
4. **No Default Credentials** - Users must configure their own
5. **HTTPS Recommended** - For production admin panel access
6. **File Permissions** - Scripts made executable only when needed

## Usage Example

### Via Admin Panel (Recommended)

1. Navigate to `/admin/vps-setup` in the admin panel
2. Fill in the form:
   - Host: `deploy.defecttracker.uk`
   - Port: `22`
   - Username: `root`
   - Auth Type: `SSH Key`
   - Private Key Path: `/home/user/.ssh/id_rsa`
   - VPS Directory: `/opt/vps-scrapers`
3. Click "Save Configuration"
4. Click "Test Connection" to verify
5. Click "Deploy to VPS"
6. Wait for deployment to complete (3-5 minutes)
7. View logs to confirm success

### Manual Deployment

```bash
# Set environment variables
export VPS_HOST=deploy.defecttracker.uk
export VPS_USER=root
export VPS_PORT=22

# Run deployment script
cd vps-scrapers
./scripts/deploy.sh
```

## Testing

### Unit Tests
- `tests/ssh-client.test.js` - Tests for SSH client module
- Verifies all methods exist and work correctly
- Tests file operations

### Integration Tests
- App starts correctly with new endpoints
- JavaScript syntax validation
- Bash script syntax validation
- Security scans (CodeQL) - 0 alerts
- Dependency vulnerability checks - No issues

### Manual Testing Checklist
- [ ] Admin panel loads VPS Setup page
- [ ] Form accepts and saves configuration
- [ ] Test Connection button works
- [ ] Deploy button initiates deployment
- [ ] Logs are displayed in real-time
- [ ] Error handling works correctly
- [ ] Manual deployment instructions are clear

## System Requirements

### Local (Plesk Server)
- Node.js v18+
- npm with ssh2 package
- Network access to VPS

### Remote (VPS)
- Ubuntu/Debian or CentOS/RHEL/Fedora
- SSH access (port 22 or custom)
- sudo privileges
- Minimum 1GB RAM
- Internet access for downloading packages

## Troubleshooting

### SSH Connection Fails
- Verify VPS IP/hostname is correct
- Check SSH port (default: 22)
- Ensure SSH key has correct permissions (chmod 600)
- For password auth, verify password is correct
- Check firewall rules on VPS
- **For Cloudflare setups**: Ensure you're using the DNS-only (gray cloud) hostname (e.g., `deploy.defecttracker.uk`) and NOT the proxied web hostname. Cloudflare's proxy does not support SSH traffic. See `docs/CLOUDFLARE_DNS_GUIDE.md` for configuration details.

### Installation Fails
- Check deployment logs for specific errors
- Verify VPS has internet access
- Ensure sudo privileges are available
- Check disk space on VPS
- Verify Linux distribution is supported

### Chrome Installation Fails
- Check if running on supported architecture (amd64)
- Try manual Chrome installation first
- Check system package manager logs
- May need to use Chromium instead of Chrome

### Service Won't Start
- Check systemd service file permissions
- Verify Node.js is installed correctly
- Check .env file configuration
- Review service logs: `sudo journalctl -u vps-scrapers -f`

## Future Enhancements

Potential improvements for future versions:
- Support for multiple VPS servers
- Scheduled deployments
- Rollback capability
- Health monitoring dashboard
- Automated updates
- Support for Docker deployments
- CI/CD integration
- Encrypted credential storage

## Dependencies Added

```json
{
  "dependencies": {
    "ssh2": "^1.16.0"
  }
}
```

## Files Created/Modified

### New Files
- `lib/ssh-client.js` - SSH client wrapper
- `vps-scrapers/scripts/install-dependencies.sh` - Installation script
- `vps-scrapers/scripts/deploy.sh` - Deployment script
- `tests/ssh-client.test.js` - Unit tests

### Modified Files
- `app.js` - Added VPS setup endpoints and UI
- `package.json` - Added ssh2 dependency
- `vps-scrapers/README.md` - Updated documentation

## Conclusion

This feature significantly simplifies the VPS scraper deployment process, reducing it from a complex multi-step manual process to a single click in the admin panel. It solves the common Puppeteer/Chrome installation issues and provides a reliable, automated deployment system.
