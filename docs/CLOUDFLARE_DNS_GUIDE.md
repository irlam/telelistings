# Cloudflare DNS guidance for telelistings

Use these settings to make sure the telelistings web UI and the VPS scraper/deploy access both work when fronted by Cloudflare.

## Core records to create or adjust

| Hostname | Type | Value | Proxy | Purpose |
| --- | --- | --- | --- | --- |
| `telegram.defecttracker.uk` | A | `185.170.113.230` | **Proxied (orange)** | Public web/admin UI over HTTPS. Keeps the site behind Cloudflare while pointing to the correct VPS IP. |
| `deploy.defecttracker.uk` | A | `185.170.113.230` | **DNS only (gray)** | SSH/SCP/rsync deploys. Cloudflare does not proxy raw SSH, so this must be DNS-only. Point your deploy tool to this host. |
| (optional) `api.defecttracker.uk` | A | `185.170.113.230` | **Proxied (orange)** | If you expose HTTP APIs, proxying keeps them behind Cloudflare on supported ports (80/443/2052/2082/2086/2095/8080/8443/8880/2053/2083/2087/2096/8443). |

*If you prefer to reuse the apex or an existing record for SSH, switch just that record to **DNS only** before using it for deployments.*

## Why the DNS-only record matters

Cloudflare’s proxy will not pass SSH traffic. A proxied record used for `ssh`, `scp`, or deploy scripts will result in a 522/524 timeout. Keeping a dedicated DNS-only hostname for SSH avoids Cloudflare entirely while leaving your HTTPS endpoints proxied.

## Checklist after updating records

1. **DNS propagation**: `dig deploy.defecttracker.uk A +short` should return `185.170.113.230`. The cloud icon in Cloudflare must be gray for this record.
2. **SSH reachability**: From outside the VPS network, run `ssh <user>@deploy.defecttracker.uk -p 22` (or your custom port). If it fails, open the port in your VPS firewall/security groups and verify `sshd` is running.
3. **Web availability**: Visit `https://telegram.defecttracker.uk/`. If you use a reverse proxy on the VPS, ensure it listens on a Cloudflare-supported HTTP/HTTPS port.
4. **Deployment config**: Update any deploy scripts or `.env` values to use `deploy.defecttracker.uk` as the host for SSH-based operations.

Following the table above gives you a proxied hostname for the web UI while keeping a direct DNS-only path for deployments to `185.170.113.230`.

## Diagnosing "Cloudflare timeout" when you think you're not using Cloudflare

The admin UI shows a Cloudflare timeout banner when it receives an HTML error page that matches Cloudflare's template instead of JSON. If you see this even though you believe Cloudflare is disabled:

1. **Double-check the DNS record**: In Cloudflare's dashboard, make sure the cloud icon for your SSH/deploy hostname is gray (DNS-only). If it is orange, traffic is still proxied.
2. **Bypass DNS entirely**: In the admin UI, temporarily set the VPS host to the raw IP address (for example `185.170.113.230`) to eliminate any proxying. If the error disappears, the prior hostname was still going through Cloudflare.
3. **Verify with `dig`**: `dig +short deploy.defecttracker.uk` should return the VPS IP directly with no Cloudflare anycast addresses in the chain. If you see multiple IPs or Cloudflare ranges, the record is still proxied somewhere.
4. **Look for upstream protection**: Some hosting providers or CDNs add Cloudflare in front of your service automatically. If your hostname resolves correctly but you still see Cloudflare HTML, the provider may be injecting a protection page; use the origin IP to bypass it.

These checks help confirm whether a proxied DNS record (or provider-level shielding) is still in the path when the UI reports a Cloudflare timeout.
