# Quick Fix: Bypass Cloudflare Errors

## Problem
- ❌ Cloudflare timeout errors when accessing admin panel
- ❌ `ERR_CONNECTION_REFUSED` when trying http://202.61.233.123:3000
- ❌ VPS deployment fails mid-operation

## Solution (Takes 30 seconds)

### Step 1: Open Terminal
- **Mac:** Cmd+Space → type "Terminal" → Enter
- **Windows:** Win+X → "PowerShell" or "Windows Terminal"
- **Linux:** Ctrl+Alt+T

### Step 2: Create SSH Tunnel
```bash
ssh -L 3000:localhost:3000 user@202.61.233.123
```
Replace `user` and `202.61.233.123` with your SSH credentials.

### Step 3: Access Admin Panel
Open browser and go to:
```
http://localhost:3000/admin/vps-setup
```

### Step 4: Keep Terminal Open
Don't close the terminal window while using the admin panel.

## Why This Works
- ✅ Bypasses Cloudflare completely (uses SSH, not HTTP)
- ✅ Works even when app listens only on localhost
- ✅ No firewall issues (SSH port is open)
- ✅ Secure (all traffic encrypted)
- ✅ No server configuration changes needed

## Detailed Guides
- Full SSH tunnel guide: `docs/SSH_TUNNEL_BYPASS.md`
- Cloudflare troubleshooting: `docs/CLOUDFLARE_DNS_GUIDE.md`

## Need Help?
If SSH tunnel doesn't work:
1. Verify SSH is enabled on your server
2. Check your SSH username/password/port
3. Try: `ssh user@your-server-ip` first to test SSH connection
4. See full troubleshooting in `SSH_TUNNEL_BYPASS.md`
