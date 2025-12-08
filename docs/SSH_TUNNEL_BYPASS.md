# SSH Tunnel - Bypass Cloudflare the Easy Way

This guide shows you how to use an SSH tunnel to access your admin panel and bypass Cloudflare timeouts, even when direct IP access doesn't work.

## TL;DR - Quick Start

```bash
# 1. Open terminal and create SSH tunnel
ssh -L 3000:localhost:3000 user@202.61.233.123

# 2. Open browser and go to:
http://localhost:3000/admin/vps-setup

# 3. Use the admin panel normally - no Cloudflare!
```

## What is an SSH Tunnel?

An SSH tunnel is a secure encrypted connection that forwards network traffic from your local machine to a remote server through SSH. Think of it as a private, encrypted pipe that:

- **Bypasses Cloudflare** completely (you're not using the domain at all)
- **Works when direct IP access fails** (works even if app listens only on localhost)
- **Is secure** (all traffic encrypted through SSH)
- **Requires no configuration changes** to the server or firewall
- **Is temporary** (tunnel closes when you close the terminal)

## Why You Need This

### The Problem

When accessing `https://telegram.defecttracker.uk/admin/vps-setup`:
- ❌ Cloudflare intercepts requests and has a 100-second timeout
- ❌ Long-running operations (like VPS deployment) get killed mid-operation
- ❌ You see "Cloudflare Gateway Timeout" errors

### Why Raw IP Doesn't Always Work

When trying `http://202.61.233.123:3000`:
- ❌ May get `ERR_CONNECTION_REFUSED` error
- ❌ Plesk often configures apps to listen only on localhost (127.0.0.1) for security
- ❌ Firewall may block port 3000
- ❌ Plesk uses reverse proxy, not direct port exposure

### The Solution: SSH Tunnel

SSH tunnel to `localhost:3000`:
- ✅ Bypasses Cloudflare (uses SSH, not HTTP/domain)
- ✅ Works with localhost-only apps (tunnel connects to localhost)
- ✅ No firewall issues (uses SSH port which is already open)
- ✅ Secure (encrypted SSH connection)
- ✅ No server configuration changes needed

## Step-by-Step Instructions

### For Mac/Linux Users

1. **Open Terminal**
   - Mac: Press Cmd+Space, type "Terminal", press Enter
   - Linux: Press Ctrl+Alt+T or find Terminal in applications

2. **Create the SSH Tunnel**
   ```bash
   ssh -L 3000:localhost:3000 username@202.61.233.123
   ```
   
   Replace:
   - `username` with your SSH username (e.g., `root` or your Plesk username)
   - `202.61.233.123` with your server's IP address

3. **Enter Your Password**
   - Type your SSH password when prompted
   - You'll see a normal SSH login prompt

4. **Keep Terminal Open**
   - Don't close this terminal window
   - The tunnel stays active as long as the SSH connection is open
   - You can minimize it, but don't close it

5. **Open Your Browser**
   - Go to: `http://localhost:3000/admin/vps-setup`
   - Or any other admin page: `http://localhost:3000/admin/settings`
   - **Important:** Use `localhost`, NOT your domain or server IP

6. **Use the Admin Panel Normally**
   - Everything works as usual
   - No Cloudflare timeouts
   - VPS deployment will complete successfully

7. **When Done**
   - Close the terminal window to close the tunnel
   - Or press Ctrl+D in the terminal to logout

### For Windows Users

#### Option 1: Using Windows Terminal or PowerShell (Windows 10/11)

1. **Open PowerShell or Windows Terminal**
   - Press Win+X, select "Windows Terminal" or "PowerShell"

2. **Create the SSH Tunnel**
   ```powershell
   ssh -L 3000:localhost:3000 username@202.61.233.123
   ```

3. **Follow steps 3-7 from Mac/Linux instructions above**

#### Option 2: Using PuTTY

1. **Download and Install PuTTY**
   - Get it from: https://www.putty.org/

2. **Configure the SSH Connection**
   - Open PuTTY
   - In "Host Name": Enter `202.61.233.123`
   - In "Port": Enter `22`

3. **Configure the Tunnel**
   - In the left panel, go to: Connection → SSH → Tunnels
   - In "Source port": Enter `3000`
   - In "Destination": Enter `localhost:3000`
   - Click "Add" button
   - You should see `L3000  localhost:3000` in the list

4. **Save the Session (Optional)**
   - Go back to "Session" in the left panel
   - In "Saved Sessions": Enter a name like "Telelistings Tunnel"
   - Click "Save"
   - Next time, just select this session and click "Load"

5. **Connect**
   - Click "Open" button
   - Accept the security alert (first time only)
   - Login with your username and password

6. **Keep PuTTY Open**
   - Minimize PuTTY, but don't close it
   - The tunnel is active while PuTTY is connected

7. **Open Your Browser**
   - Go to: `http://localhost:3000/admin/vps-setup`

8. **When Done**
   - Close PuTTY window to close the tunnel

## Advanced Usage

### Tunnel Multiple Ports

If you need to tunnel multiple services:

```bash
ssh -L 3000:localhost:3000 -L 3333:localhost:3333 user@202.61.233.123
```

This forwards both:
- Local 3000 → Remote localhost:3000 (admin panel)
- Local 3333 → Remote localhost:3333 (VPS scrapers, if needed)

### Keep Tunnel Running in Background

For Mac/Linux, use `-f` to background the tunnel:

```bash
ssh -f -N -L 3000:localhost:3000 user@202.61.233.123
```

- `-f` = Run in background
- `-N` = Don't execute commands (just tunnel)

To close background tunnel later:
```bash
# Find the SSH process
ps aux | grep "ssh.*3000"

# Kill it
kill <PID>
```

### Use SSH Key Instead of Password

More secure and convenient:

1. **Generate SSH key** (if you don't have one):
   ```bash
   ssh-keygen -t rsa -b 4096
   ```

2. **Copy key to server**:
   ```bash
   ssh-copy-id user@202.61.233.123
   ```

3. **Create tunnel** (no password needed):
   ```bash
   ssh -L 3000:localhost:3000 user@202.61.233.123
   ```

### Custom SSH Port

If your server uses a non-standard SSH port:

```bash
ssh -p 2222 -L 3000:localhost:3000 user@202.61.233.123
```

Replace `2222` with your SSH port.

## Troubleshooting

### "Connection refused" when creating tunnel

**Problem:** Can't connect to SSH
```
ssh: connect to host 202.61.233.123 port 22: Connection refused
```

**Solutions:**
- Verify the server IP is correct
- Check if SSH is enabled on the server
- Try a different SSH port if custom port is used: `-p PORT`
- Check if your IP is blocked by server firewall

### "Address already in use" error

**Problem:** Port 3000 is already being used on your local machine
```
bind: Address already in use
```

**Solutions:**
1. **Close other applications using port 3000** on your local machine
2. **Use a different local port:**
   ```bash
   ssh -L 8080:localhost:3000 user@202.61.233.123
   ```
   Then access: `http://localhost:8080/admin/vps-setup`

3. **Find and kill the process using port 3000:**
   ```bash
   # Mac/Linux
   lsof -ti:3000 | xargs kill -9
   
   # Windows (PowerShell)
   Get-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess | Stop-Process
   ```

### Page not loading at localhost:3000

**Checklist:**
1. ✅ Is the SSH tunnel still connected? (Check terminal window)
2. ✅ Are you accessing `http://localhost:3000` (not the server IP)?
3. ✅ Is the remote app actually running on port 3000?
4. ✅ Try restarting the SSH tunnel

**Test the tunnel:**
```bash
# In another terminal, check if port is listening locally
netstat -an | grep 3000

# Should show something like:
# tcp4  0  0  127.0.0.1.3000  *.*  LISTEN
```

### SSH keeps disconnecting

**Problem:** Tunnel closes after a few minutes of inactivity

**Solution:** Keep the connection alive

```bash
# Add to ~/.ssh/config
Host 202.61.233.123
  ServerAliveInterval 60
  ServerAliveCountMax 3

# Or use command-line option:
ssh -o ServerAliveInterval=60 -L 3000:localhost:3000 user@202.61.233.123
```

### Permission denied

**Problem:** SSH authentication fails

**Solutions:**
1. Verify username is correct
2. Verify password is correct
3. Check if SSH key is set up correctly (if using keys)
4. Try password auth explicitly: `ssh -o PreferredAuthentications=password ...`

## Why This Is The Best Solution

| Method | Bypasses Cloudflare | Works with localhost apps | Secure | No config changes | Always works |
|--------|-------------------|--------------------------|--------|------------------|--------------|
| **SSH Tunnel** | ✅ | ✅ | ✅ | ✅ | ✅ |
| Raw IP access | ✅ | ❌ | ⚠️ (HTTP) | ❌ (firewall) | ❌ |
| Optimize deployment | ❌ | N/A | ✅ | ✅ | ⚠️ (may still timeout) |
| Command line deploy | ✅ | N/A | ✅ | N/A | ✅ (but no GUI) |
| Configure listening address | ✅ | N/A | ⚠️ (exposed) | ❌ | ⚠️ (firewall needed) |

**SSH Tunnel wins because:**
- ✅ Always works regardless of server configuration
- ✅ No security risks (encrypted, no exposed ports)
- ✅ No changes needed to server, firewall, or app
- ✅ Standard SSH tool available everywhere
- ✅ Works for any long-running operation

## Common Questions

**Q: Do I need to keep the terminal open the whole time?**
A: Yes, while you're using the admin panel. You can minimize it. Once you're done, you can close it.

**Q: Is this secure?**
A: Yes! All traffic is encrypted through SSH. More secure than HTTP and similar to HTTPS.

**Q: Will this work for other services/ports?**
A: Yes! You can tunnel any port. Just change the port numbers in the command.

**Q: Can multiple people use tunnels at the same time?**
A: Yes! Each person creates their own tunnel from their own machine.

**Q: Do I need to do this every time?**
A: Yes, it's a temporary connection. But it only takes 5 seconds to set up once you know the command.

**Q: Can I make this permanent?**
A: You can keep it running in the background (see Advanced Usage), but for security it's better to create it when needed and close it when done.

**Q: What if I'm behind a corporate firewall?**
A: SSH (port 22) is usually allowed. If blocked, ask your IT department to allow SSH to your server's IP.

## Summary

**Problem:** Cloudflare timeouts + ERR_CONNECTION_REFUSED on raw IP  
**Solution:** SSH tunnel  
**Command:** `ssh -L 3000:localhost:3000 user@202.61.233.123`  
**Access:** `http://localhost:3000/admin/vps-setup`  
**Result:** Admin panel works perfectly, no timeouts! ✅

This is the most reliable, secure, and straightforward solution to bypass Cloudflare when direct IP access doesn't work.
