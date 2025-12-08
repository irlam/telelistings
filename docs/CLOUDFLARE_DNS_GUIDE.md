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

**Important:** The admin UI only shows a "Cloudflare timeout error" when it receives an actual HTML error page from Cloudflare (containing "Cloudflare", error codes like 504/522/524, or "CF-Ray" identifiers). If you see this error, it means your request is genuinely being routed through Cloudflare's proxy.

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
   - This removes Cloudflare's 100-second timeout from the equation

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

If you see a genuine Cloudflare timeout error AND need to use the web UI through Cloudflare:

1. **Double-check the DNS record**: In Cloudflare's dashboard, make sure the cloud icon for your SSH/deploy hostname is gray (DNS-only). If it is orange, traffic is still proxied.
2. **Point the VPS tools to the right host**: In the admin UI, set the VPS host to either the raw IP `185.170.113.230` or the DNS-only record `deploy.defecttracker.uk`. Do **not** use `telegram.defecttracker.uk` for SSH/test/deploy because it goes to the Cloudflare-proxied web host at `202.61.233.123`.
3. **Verify with `dig`**: `dig +short deploy.defecttracker.uk` should return the VPS IP directly with no Cloudflare anycast addresses in the chain. If you see multiple IPs or Cloudflare ranges, the record is still proxied somewhere.
4. **Look for upstream protection**: Some hosting providers or CDNs add Cloudflare in front of your service automatically. If your hostname resolves correctly but you still see Cloudflare HTML, the provider may be injecting a protection page; use the origin IP to bypass it.
5. **Retest after changing the host**: Once the admin UI points at `185.170.113.230` (or `deploy.defecttracker.uk`), re-run the Test/Deploy buttons.

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
