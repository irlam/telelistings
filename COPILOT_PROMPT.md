# GitHub Copilot – Project Instructions

You are helping to develop a **Telegram sports TV bot** that runs on a Plesk-hosted Node.js app.

The project currently lives at `telegram.defecttracker.uk` and has:

- A Node.js/Express **admin GUI** (`app.js`) with:
  - `/admin/channels` – manage Telegram channels (label, `@username`, teams list)
  - `/admin/teams` – manage team list per channel
  - `/admin/settings` – Telegram bot token, timezone, manual “Post now” button
  - `/admin/logs` – tail of `autopost.log`
  - `/admin/help` – setup instructions (BotFather, adding bot as channel admin, cron URL)
  - `/admin/import-uk-teams` – runs the UK teams importer

- An **autoposter** (`autopost.js`) that:
  - Reads `config.json`
  - For each channel, builds a text summary of upcoming fixtures and posts to Telegram via Bot API
  - Supports two modes per channel:
    1. **TheFishy multi-ICS mode** (`useTheFishyMulti: true`):
       - Each team has a TheFishy ICS feed at `https://thefishy.co.uk/calendar/<Team+Name>`
       - We fetch a **limited number** of team ICS feeds per run (`multiMaxTeams`, default 10)
       - We add a delay between requests (`multiIcsDelayMs`, default 1500ms) to avoid 429 rate-limits
       - We merge fixtures across teams, dedupe, sort by date/time, and post one combined message
    2. **Single ICS mode** (default):
       - Uses a single `icsUrl` (global or per channel)
       - Optionally filters fixtures by team names from `channel.teams`

- An **ICS parser** (`ics_source.js`) that:
  - Fetches an ICS URL
  - Parses events
  - Applies a “next N days” window (`cfg.icsDaysAhead` or default)
  - Optionally filters events based on team name matches in the summary

- A **UK teams importer** (`import_uk_teams.js`) that:
  - Scrapes `https://thefishy.co.uk/teams.php`
  - Finds league pages for England / Scotland / Wales / Ireland
  - For each league page it finds team names and writes them into `config.json`
  - Each team entry in `config.json` looks like:
    ```json
    {
      "label": "Arsenal",
      "country": "england",
      "slug": "arsenal",
      "league": "Premier League"
    }
    ```
  - All teams are attached to the first channel (typically “UK Football”)

- A **public cron endpoint** in `app.js`:
  - `GET /cron/run?key=SECRET` calls `runOnce()` from `autopost.js`
  - Protected by a `CRON_SECRET` environment variable
  - Plesk scheduled task hits this URL on a schedule

---

## General goals

Help evolve this into a neat, maintainable tool for:

- Auto-posting “what’s on” fixture summaries into one or more Telegram channels
- Letting me manage everything via the web GUI (no SSH needed for normal use)
- Keeping network usage polite (no hammering TheFishy or third-party sites)
- Making it easy to:
  - Change leagues / teams per channel
  - Limit which fixtures are included
  - Extend to other sources later (e.g. different ICS providers)

---

## Current conventions and constraints

- **Runtime**: Plain Node.js + CommonJS (`require`/`module.exports`), no TypeScript.
- **Frameworks**: Express for HTTP, `express-basic-auth` for simple admin auth.
- **Data store**: `config.json` file on disk (no database).
- **Secrets**:
  - Telegram bot token stored in `config.json` for now.
  - Cron secret via `CRON_SECRET` env var in Node settings.
- **Style**:
  - Keep dependencies minimal.
  - Use simple logging via `autopost.log` with timestamps.
  - Use plain text Telegram messages (no Markdown formatting).
- **Scraping**:
  - We use **TheFishy** (`thefishy.co.uk`) ICS and teams pages.
  - We **do not** use LiveSoccerTV anymore (Cloudflare/403 issues).
  - Be respectful: add delays, cap number of requests, handle 429 gracefully.

---

## How `config.json` is structured

Example:

```json
{
  "botToken": "123456789:XXXX",
  "timezone": "Europe/London",
  "icsUrl": "",
  "icsDaysAhead": 7,
  "channels": [
    {
      "id": "@FootballOnTvUK",
      "label": "UK Football",
      "useTheFishyMulti": true,
      "multiMaxTeams": 8,
      "multiIcsDelayMs": 2000,
      "teams": [
        {
          "label": "Arsenal",
          "country": "england",
          "slug": "arsenal",
          "league": "Premier League"
        }
      ]
    }
  ]
}
