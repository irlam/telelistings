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

## Diagnosing "Cloudflare timeout" when you think you're not using Cloudflare

The admin UI shows a Cloudflare timeout banner when it receives an HTML error page that matches Cloudflare's template instead of JSON. If you see this even though you believe Cloudflare is disabled:

1. **Double-check the DNS record**: In Cloudflare's dashboard, make sure the cloud icon for your SSH/deploy hostname is gray (DNS-only). If it is orange, traffic is still proxied.
2. **Point the VPS tools to the right host**: In the admin UI, set the VPS host to either the raw IP `185.170.113.230` or the DNS-only record `deploy.defecttracker.uk`. Do **not** use `telegram.defecttracker.uk` for SSH/test/deploy because it goes to the Cloudflare-proxied web host at `202.61.233.123`.
3. **Verify with `dig`**: `dig +short deploy.defecttracker.uk` should return the VPS IP directly with no Cloudflare anycast addresses in the chain. If you see multiple IPs or Cloudflare ranges, the record is still proxied somewhere.
4. **Look for upstream protection**: Some hosting providers or CDNs add Cloudflare in front of your service automatically. If your hostname resolves correctly but you still see Cloudflare HTML, the provider may be injecting a protection page; use the origin IP to bypass it.
5. **Retest after changing the host**: Once the admin UI points at `185.170.113.230` (or `deploy.defecttracker.uk`), re-run the Test/Deploy buttons. A Cloudflare timeout at that point usually means SSH is blocked or the VPS is offline rather than a proxy issue.

## Quick smoke test before deploying

1. Toggle the `deploy.defecttracker.uk` record to **DNS only (gray cloud)** in Cloudflare.
2. From the machine running the admin UI, run: `ssh -o ConnectTimeout=10 root@185.170.113.230` (or use your non-root user). Confirm you get an SSH fingerprint prompt; then exit.
3. In the admin UI, open **Settings → VPS Setup & Deployment**, set **VPS Host** to `185.170.113.230` (or `deploy.defecttracker.uk`), and click **Test SSH connection**. A Cloudflare timeout here usually means the DNS record is still proxied or the VPS firewall blocks SSH.
4. Only after SSH succeeds should you run **Deploy to VPS**.

These checks help confirm whether a proxied DNS record (or provider-level shielding) is still in the path when the UI reports a Cloudflare timeout.
