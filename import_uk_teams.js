// import_uk_teams.js
// Fetch ALL UK teams from TheFishy and stuff them into config.json,
// including league names (e.g. "Premier League").
//
// Usage (from httpdocs):
//   node import_uk_teams.js
//
// or via the /admin/import-uk-teams button.
/**
 * Telegram Sports TV Bot – UK Teams Importer (TheFishy)
 *
 * Scrapes https://thefishy.co.uk/teams.php to build a UK clubs list.
 * - Finds league pages under England / Scotland / Wales / Ireland sections.
 * - For each league page, extracts team names (links to team.php?team=...).
 * - Writes teams into config.json under channels[0].teams.
 * - Each team object:
 *    { label, country, slug, league }
 *   e.g. league "Premier League", "Championship", etc.
 *
 * Called either via:
 *   - CLI: node import_uk_teams.js
 *   - GUI: /admin/import-uk-teams endpoint in app.js
 *
 * Constraints:
 * - Respect TheFishy: avoid crazy concurrency; handle network errors gracefully.
 * - Keep config.json structure stable for autopost.js and admin GUI.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

// --- paths -------------------------------------------------------------

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');

// --- small helpers -----------------------------------------------------

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error('config.json not found at ' + CONFIG_PATH);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Map section heading -> country code in config
function regionToCountrySlug(regionHeading) {
  const t = regionHeading.toLowerCase();
  if (t.includes('england')) return 'england';
  if (t.includes('scotland')) return 'scotland';
  if (t.includes('wales')) return 'wales';
  if (t.includes('ireland')) return 'ireland';
  return 'uk';
}

// --- scraping thefishy -------------------------------------------------

const BASE = 'https://thefishy.co.uk/';
const TEAMS_INDEX_URL = BASE + 'teams.php';

// headings on the page we treat as "UK regions"
const UK_REGION_HEADINGS = [
  'england football teams',
  'scotland football teams',
  'wales football teams',
  'ireland football teams'
];

async function fetchHtml(url) {
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'TelegramSportsBot/1.0 (personal, non-commercial)',
      'Accept': 'text/html,application/xhtml+xml'
    },
    timeout: 15000
  });
  return res.data;
}

/**
 * From https://thefishy.co.uk/teams.php extract all league links for
 * England / Scotland / Wales / Ireland.
 *
 * Returns an array like:
 * [
 *   {
 *     regionHeading: "England Football Teams",
 *     countrySlug: "england",
 *     url: "https://thefishy.co.uk/teams.php?table=10",
 *     text: "Premier League Football Teams",
 *     leagueName: "Premier League"
 *   },
 *   ...
 * ]
 */
async function getUkLeaguePages() {
  console.log('Loading UK leagues index from:', TEAMS_INDEX_URL);
  const html = await fetchHtml(TEAMS_INDEX_URL);
  const $ = cheerio.load(html);

  const leagues = [];

  $('h1, h2, h3').each((_, el) => {
    const headingText = $(el).text().trim();
    const headingLower = headingText.toLowerCase();

    // Is this one of our UK region headings?
    const region = UK_REGION_HEADINGS.find((r) =>
      headingLower.includes(r)
    );
    if (!region) {
      return;
    }

    const countrySlug = regionToCountrySlug(region);
    console.log(`Found region heading: "${headingText}" (country=${countrySlug})`);

    // IMPORTANT:
    // Only stop at the next h1 or h2 (next region),
    // but NOT at h3 (sub-headings like EPL / EFL etc.).
    const section = $(el).nextUntil('h1, h2');

    section.find('a[href*="teams.php?table="]').each((__, link) => {
      const href = $(link).attr('href') || '';
      const text = $(link).text().trim();

      if (!href) return;
      if (!text.toLowerCase().includes('football teams')) return;

      const fullUrl = new URL(href, BASE).href;

      // Derive a clean league name from link text:
      // "Premier League Football Teams" -> "Premier League"
      let leagueName = text.replace(/Football Teams/i, '').trim();
      if (!leagueName) {
        leagueName = text.trim();
      }

      leagues.push({
        regionHeading: headingText,
        countrySlug,
        url: fullUrl,
        text,
        leagueName
      });
    });
  });

  console.log(
    `Found ${leagues.length} league pages across UK regions:`,
    leagues.map((l) => `${l.leagueName} (${l.countrySlug})`).join(' | ')
  );

  return leagues;
}

/**
 * Given a league teams page like https://thefishy.co.uk/teams.php?table=1
 * return an array of team names.
 */
async function getTeamsFromLeaguePage(leagueUrl) {
  console.log('  Fetching league teams from:', leagueUrl);
  const html = await fetchHtml(leagueUrl);
  const $ = cheerio.load(html);

  const names = new Set();

  // Each team appears as a link to team.php?team=XYZ
  $('a[href*="team.php?team="]').each((_, el) => {
    const name = $(el).text().trim();
    if (name) names.add(name);
  });

  console.log(`  → found ${names.size} teams on this page`);
  return Array.from(names);
}

// --- main import logic -------------------------------------------------

async function main() {
  console.log('Loading config from:', CONFIG_PATH);
  const cfg = loadConfig();

  cfg.channels = cfg.channels || [];
  if (!cfg.channels.length) {
    cfg.channels.push({
      id: '@FootballOnTvUK',
      label: 'UK Football',
      teams: []
    });
  }

  // use first channel as the "UK football" bucket
  const channelIndex = 0;
  const channel = cfg.channels[channelIndex];

  console.log(
    `Importing UK teams into channel: ${channel.label} (index=${channelIndex})`
  );

  const leagues = await getUkLeaguePages();

  const allTeams = [];
  for (const league of leagues) {
    try {
      const names = await getTeamsFromLeaguePage(league.url);

      for (const name of names) {
        allTeams.push({
          label: name,
          country: league.countrySlug,
          slug: slugify(name),
          league: league.leagueName || league.text || ''
        });
      }
    } catch (err) {
      console.error(
        `  !! Error fetching league ${league.text} (${league.url}):`,
        err.message || String(err)
      );
    }
  }

  // de-dupe by label (case-insensitive)
  const seen = new Set();
  const deduped = [];
  for (const t of allTeams) {
    const key = t.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }

  console.log(
    `Found ${allTeams.length} raw team entries, ${deduped.length} unique UK teams`
  );

  channel.teams = deduped;

  saveConfig(cfg);

  console.log(
    `Updated config.json – channel "${channel.label}" now has ${deduped.length} teams`
  );
}

main().catch((err) => {
  console.error('ERROR in import_uk_teams.js:', err);
  process.exit(1);
});
