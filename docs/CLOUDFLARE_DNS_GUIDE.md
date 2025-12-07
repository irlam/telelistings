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
