# Cloudflare DNS guidance for telelistings

Use these settings to make sure the telelistings web UI and the VPS scraper/deploy access both work when fronted by Cloudflare.

## Core records to create or adjust

| Hostname | Type | Value | Proxy | Purpose |
| --- | --- | --- | --- | --- |
| `telegram.defecttracker.uk` | A | `202.61.233.123` | **Proxied (orange)** | Public web/admin UI over HTTPS on your web host. This stays behind Cloudflare. |
| `deploy.defecttracker.uk` | A | `185.170.113.230` | **DNS only (gray)** | SSH/SCP/rsync deploys to the Ubuntu VPS. Cloudflare does not proxy raw SSH, so this must be DNS-only. Point your deploy tool to this host or the raw IP. |
| (optional) `api.defecttracker.uk` | A | `185.170.113.230` | **Proxied (orange)** | If you expose HTTP APIs, proxying keeps them behind Cloudflare on supported ports (80/443/2052/2082/2086/2095/8080/8443/8880/2053/2083/2087/2096/8443). |

If your DNS panel shows all orange (proxied) clouds—like in the screenshot—click the orange cloud next to `deploy.defecttracker.uk` until it turns gray. Leaving `deploy` proxied will still route SSH/Test/Deploy traffic through Cloudflare and trigger a timeout banner in the admin UI.

*If you prefer to reuse the apex or an existing record for SSH, switch just that record to **DNS only** before using it for deployments.*

## Why the DNS-only record matters

Cloudflare’s proxy will not pass SSH traffic. A proxied record used for `ssh`, `scp`, or deploy scripts will result in a 522/524 timeout. Keeping a dedicated DNS-only hostname for SSH avoids Cloudflare entirely while leaving your HTTPS endpoints proxied.

## Checklist after updating records

1. **DNS propagation**: `dig deploy.defecttracker.uk A +short` should return `185.170.113.230`. The cloud icon in Cloudflare must be gray for this record.
2. **SSH reachability**: From outside the VPS network, run `ssh <user>@deploy.defecttracker.uk -p 22` (or your custom port). If it fails, open the port in your VPS firewall/security groups and verify `sshd` is running.
3. **Web availability**: Visit `https://telegram.defecttracker.uk/` and confirm it resolves to your web host (`202.61.233.123`) through Cloudflare. The VPS (185.170.113.230) is separate and should not be tied to this proxied hostname for SSH.
4. **Deployment config**: Update any deploy scripts or `.env` values to use `deploy.defecttracker.uk` as the host for SSH-based operations.

Following the table above gives you a proxied hostname for the web UI while keeping a direct DNS-only path for deployments to `185.170.113.230`.

## Understanding Cloudflare timeout errors

**Important:** The admin UI only shows a "Cloudflare timeout error" when it receives an actual HTML error page from Cloudflare (containing "Cloudflare", error codes like 504/524/522, or "CF-Ray" identifiers). If you see this error, it means your request is genuinely being routed through Cloudflare's proxy.

### The error is REAL if you see:
- An error message specifically mentioning "Cloudflare Gateway Timeout Error Detected"
- The actual error response contains "Cloudflare" branding or "CF-Ray" IDs
- You're using a hostname instead of an IP address for your VPS host

### The error is NOT Cloudflare-related if you see:
- Generic "Connection timeout" or "SSH connection failed" messages (without Cloudflare mentioned)
- "Server returned non-JSON response" errors (these are other server issues)
- Standard SSH connection errors (ECONNREFUSED, ETIMEDOUT, etc.)

## Diagnosing "Cloudflare timeout" when you think you're not using Cloudflare

The admin UI shows a Cloudflare timeout banner **only** when it receives an HTML error page that contains Cloudflare-specific identifiers (like "Cloudflare", "CF-Ray", or specific error codes). If you see this error, your traffic IS going through Cloudflare, regardless of what you think your DNS settings are.

### "I know my SSH is running and the VPS IP is correct, but I still get the Cloudflare error!"

If you're certain the VPS is reachable and SSH is running, but you still see the Cloudflare error, here's what's actually happening:

**The Cloudflare error is NOT about SSH failing.** It means the HTTP request from your browser to the admin panel's test/deploy endpoint is being intercepted by Cloudflare before it even attempts the SSH connection.

**This happens when:**
- The admin UI itself is running on a server behind Cloudflare (e.g., on a Plesk host at `telegram.defecttracker.uk`)
- The test/deploy HTTP request times out *before* the backend can complete the SSH operation
- Cloudflare's 100-second timeout is reached while the backend is uploading files or running installation scripts

**The real issue:** The deployment is taking too long (>100 seconds), causing Cloudflare to terminate the HTTP request with a 524 error, even though the SSH connection and VPS are fine.

**Solutions:**

1. **Use the raw IP address for the admin UI** (bypasses Cloudflare entirely):
   - Instead of accessing `https://telegram.defecttracker.uk/admin/vps-setup`
   - Access `http://202.61.233.123:3000/admin/vps-setup` (use your actual web server IP and port)
   - **Security Note:** Using HTTP instead of HTTPS removes SSL/TLS encryption. Only use this on trusted networks. For production, configure HTTPS with proper certificates on the origin server or use a VPN/SSH tunnel.
   - This removes Cloudflare's 100-second timeout from the equation
   - **If you get ERR_CONNECTION_REFUSED**, see the detailed troubleshooting section below

2. **Optimize the deployment** to complete faster:
   - Pre-install Chrome/Chromium on the VPS manually: `sudo apt-get install chromium-browser`
   - Pre-install Node.js: `curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs`
   - This reduces deployment time to under 100 seconds

3. **Use manual deployment** from command line:
   ```bash
   cd vps-scrapers
   export VPS_HOST=185.170.113.230
   export VPS_USER=root
   export VPS_PORT=22
   ./scripts/deploy.sh
   ```
   Command-line deployment isn't subject to Cloudflare timeouts

4. **Use SSH tunnel** (secure alternative when direct IP access doesn't work):
   - See the "SSH Tunnel Solution" section below for detailed instructions

If you see a genuine Cloudflare timeout error AND need to use the web UI through Cloudflare:

1. **Double-check the DNS record**: In Cloudflare's dashboard, make sure the cloud icon for your SSH/deploy hostname is gray (DNS-only). If it is orange, traffic is still proxied.
2. **Point the VPS tools to the right host**: In the admin UI, set the VPS host to either the raw IP `185.170.113.230` or the DNS-only record `deploy.defecttracker.uk`. Do **not** use `telegram.defecttracker.uk` for SSH/test/deploy because it goes to the Cloudflare-proxied web host at `202.61.233.123`.
3. **Verify with `dig`**: `dig +short deploy.defecttracker.uk` should return the VPS IP directly with no Cloudflare anycast addresses in the chain. If you see multiple IPs or Cloudflare ranges, the record is still proxied somewhere.
4. **Look for upstream protection**: Some hosting providers or CDNs add Cloudflare in front of your service automatically. If your hostname resolves correctly but you still see Cloudflare HTML, the provider may be injecting a protection page; use the origin IP to bypass it.
5. **Retest after changing the host**: Once the admin UI points at `185.170.113.230` (or `deploy.defecttracker.uk`), re-run the Test/Deploy buttons.

## Troubleshooting ERR_CONNECTION_REFUSED When Accessing Admin Panel via Raw IP

If you get `ERR_CONNECTION_REFUSED` when trying to access the admin panel via raw IP (e.g., `http://202.61.233.123:3000`), this means the Node.js application is not accessible on that IP:port combination. This is a **different issue** from Cloudflare timeouts.

### Common Causes

**1. Application is listening on localhost only (127.0.0.1)**
- In some Plesk environments, Node.js apps are configured to listen only on localhost for security
- External connections to the IP are blocked by design
- Plesk uses a reverse proxy to route traffic from port 80/443 to your app

**2. Firewall is blocking the port**
- The server firewall may not allow incoming connections to port 3000
- Plesk's firewall rules may only allow HTTP (80) and HTTPS (443)

**3. Plesk proxy configuration**
- Plesk Node.js apps typically don't expose ports directly
- Instead, Plesk proxies requests from your domain to the app
- Direct IP:port access is intentionally disabled

**4. Port is different than expected**
- The app might be running on a different port than 3000
- Check Plesk Node.js settings for the actual port

### Solutions

#### Solution 1: Use SSH Tunnel (Recommended - Secure and Always Works)

An SSH tunnel creates a secure encrypted connection that bypasses Cloudflare AND works with Plesk's localhost-only configuration:

```bash
# From your local machine, create an SSH tunnel
# This forwards your local port 3000 to the server's localhost:3000
ssh -L 3000:localhost:3000 user@202.61.233.123

# Keep this terminal window open, then in your browser access:
# http://localhost:3000/admin/vps-setup
```

**Why this works:**
- Your browser connects to `localhost:3000` on YOUR machine
- SSH forwards this to `localhost:3000` on the SERVER
- This bypasses Cloudflare completely (you're not using the domain)
- Works even when the app listens only on localhost (127.0.0.1)
- Secure - all traffic is encrypted through SSH
- No firewall changes needed

**Step-by-step:**
1. Open a terminal on your local machine (Mac/Linux) or use PuTTY on Windows
2. Run the SSH tunnel command with your server credentials:
   ```bash
   ssh -L 3000:localhost:3000 user@202.61.233.123
   ```
3. Enter your password when prompted
4. Keep this terminal window open
5. Open your browser and go to `http://localhost:3000/admin/vps-setup`
6. You're now accessing the admin panel through the SSH tunnel, bypassing Cloudflare
7. When done, close the terminal to close the tunnel

**For Windows users:**
- Use PuTTY or Windows Terminal with SSH
- In PuTTY: Connection → SSH → Tunnels → Add new forwarded port: Source port: 3000, Destination: localhost:3000

#### Solution 2: Configure App to Listen on All Interfaces

If you have shell access to modify the application:

```javascript
// In app.js, change:
app.listen(PORT, () => {
  console.log(`Admin GUI listening on port ${PORT}`);
});

// To:
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Admin GUI listening on 0.0.0.0:${PORT}`);
});
```

Then restart the Node.js application in Plesk.

**Important:** This exposes the app to the internet on that port. You should:
- Configure firewall rules to restrict access
- Or ensure the app has strong authentication
- Only use this if you understand the security implications

#### Solution 3: Configure Plesk Firewall

If you want to access via raw IP:port and Solution 2 is implemented:

1. Log into Plesk
2. Go to Tools & Settings → Firewall
3. Add a custom rule:
   - Name: "Node.js Admin Panel"
   - Action: Allow
   - Direction: Incoming
   - Port: 3000
   - Sources: Your IP address (recommended) or "Any" (less secure)
4. Apply the rule
5. Try accessing `http://202.61.233.123:3000` again

#### Solution 4: Use Plesk's Proxy (If Configured)

Some Plesk setups allow subdomain configuration:

1. Create a subdomain in Plesk (e.g., `direct.defecttracker.uk`)
2. Point it to your server IP with **DNS only** (gray cloud in Cloudflare)
3. Configure Plesk to proxy this subdomain to your Node.js app
4. Access via `http://direct.defecttracker.uk/admin/vps-setup`

This avoids port numbers and works with Plesk's architecture.

#### Solution 5: Optimize Deployment to Complete Under 100 Seconds

Instead of bypassing Cloudflare, make the deployment fast enough to complete within Cloudflare's timeout:

```bash
# SSH into your VPS and pre-install dependencies:
ssh user@185.170.113.230

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Chrome/Chromium (largest dependency)
sudo apt-get update
sudo apt-get install -y chromium-browser

# Exit VPS
exit
```

Now when you deploy from the admin panel, it will complete much faster since the large dependencies are already installed.

### Testing Which Solution Works for You

**Test 1: Check if app is listening and on which interface**
```bash
# SSH into your server
ssh user@202.61.233.123

# Check what the app is listening on
sudo netstat -tlnp | grep :3000

# Look for output like:
# tcp        0      0 127.0.0.1:3000          0.0.0.0:*               LISTEN      12345/node
#                    ^^^^^^^^^ (localhost only - need SSH tunnel)
# 
# OR:
# tcp        0      0 0.0.0.0:3000            0.0.0.0:*               LISTEN      12345/node
#                    ^^^^^^^ (all interfaces - need firewall rule)
```

**Test 2: Try SSH tunnel immediately**
```bash
# From your local machine
ssh -L 3000:localhost:3000 user@202.61.233.123

# Then browse to http://localhost:3000/admin/vps-setup
```

If Test 2 works, SSH tunnel is your best solution. It's secure, requires no configuration changes, and always works.

## Troubleshooting NON-Cloudflare deployment errors

If you see errors that do NOT mention Cloudflare specifically, these are standard SSH/connection issues:

**"Connection timeout after XXXms"** (without Cloudflare mentioned)
- The VPS is unreachable or not responding
- Check if the VPS is online and the IP/hostname is correct
- Verify SSH service is running: `systemctl status sshd`
- Check firewall rules allow SSH on port 22 (or your custom port)

**"SSH connection failed: ECONNREFUSED"**
- The SSH service is not running on the VPS
- Or the wrong port is configured
- Verify: `ssh -p 22 user@your-vps-ip`

**"SSH connection failed: ETIMEDOUT"** or **"EHOSTUNREACH"**
- Network routing issue or VPS is offline
- Firewall is blocking connections
- Check VPS provider's status page

**"Server returned non-JSON response"**
- This is typically an application server error, not a Cloudflare or SSH issue
- Check server logs for the actual error
- The deployment/test endpoint may have crashed

## Quick smoke test before deploying

1. Toggle the `deploy.defecttracker.uk` record to **DNS only (gray cloud)** in Cloudflare.
2. From the machine running the admin UI, run: `ssh -o ConnectTimeout=10 root@185.170.113.230` (or use your non-root user). Confirm you get an SSH fingerprint prompt; then exit.
3. In the admin UI, open **Settings → VPS Setup & Deployment**, set **VPS Host** to `185.170.113.230` (or `deploy.defecttracker.uk`), and click **Test SSH connection**. A Cloudflare timeout here usually means the DNS record is still proxied or the VPS firewall blocks SSH.
4. Only after SSH succeeds should you run **Deploy to VPS**.

These checks help confirm whether a proxied DNS record (or provider-level shielding) is still in the path when the UI reports a Cloudflare timeout.
