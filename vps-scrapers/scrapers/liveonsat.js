// scrapers/liveonsat.js
// LiveOnSat UK/England football TV listings scraper using Puppeteer.

/**
 * VPS LiveOnSat Scraper
 *
 * Target: https://liveonsat.com/uk-england-all-football.php
 *
 * Returns:
 * {
 *   fixtures: Array<{
 *     home: string,
 *     away: string,
 *     kickoffUtc: string | null,
 *     competition: string | null,
 *     channels: string[]
 *   }>
 * }
 *
 * Notes:
 * - Parses from page text, so it's fairly resilient to minor markup changes.
 * - Uses a regex for lines like:
 *   "English Championship - Week 19 Hull City v Middlesbrough ST: 15:00"
 * - Follows with channel lines (Sky Sports, ITV, TNT etc) until the next
 *   fixture or date header.
 */

const puppeteer = require('puppeteer');

// ---------- Configuration ----------

const BASE_URL = 'https://liveonsat.com';
const PAGE_URL = `${BASE_URL}/uk-england-all-football.php`;
const DEFAULT_TIMEOUT = 45000;

// Minimum length for valid text values (team names, channels, etc.)
const MIN_TEXT_LENGTH = 3;

// Women's football filter terms
const WOMENS_TERMS = ['women', 'ladies', 'wsl', 'womens'];

// UK competitions to include
const UK_COMPETITIONS = [
  'premier league',
  'english championship',
  'championship',
  'english league one',
  'league one',
  'english league two',
  'league two',
  'fa cup',
  'efl cup',
  'carabao cup',
  'scottish premiership',
  'scottish championship',
  'scottish league one',
  'scottish league two',
  'scottish cup',
  'welsh premier league',
  'northern ireland premiership',
  'national league'
];

// Shared browser instance
let browser = null;

// ---------- Logging ----------

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [LIVEONSAT-VPS] ${msg}`);
}

// ---------- Browser Management ----------

async function getBrowser() {
  if (browser && browser.isConnected()) {
    return browser;
  }
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
  return browser;
}

// ---------- Helpers ----------

function normalizeTeamName(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/\b(fc|afc)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeChannelName(name) {
  return (name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse kickoff time to UTC ISO string.
 * Input: dateLabel like "Friday, 5th December"
 * timeString: "15:00" (local UK time - GMT or BST)
 *
 * We assume current season/year and convert to ISO UTC string.
 * Accounts for British Summer Time (BST) which runs from last Sunday
 * in March to last Sunday in October.
 * If parsing fails, returns null.
 */
function parseKickoffUtc(dateLabel, timeString) {
  if (!dateLabel || !timeString) return null;

  try {
    const currentYear = new Date().getFullYear();

    // Remove ordinal suffixes (1st/2nd/3rd/4th etc.)
    const cleanedDate = dateLabel.replace(
      /(\d+)(st|nd|rd|th)/i,
      '$1'
    );

    // Parse as GMT first, then adjust for BST if applicable
    // Format: "Friday, 5 December 2025 15:00 GMT"
    const dateString = `${cleanedDate} ${currentYear} ${timeString} GMT`;

    const d = new Date(dateString);
    if (isNaN(d.getTime())) return null;

    // Check if date is in BST period (last Sunday March to last Sunday October)
    // If so, the time shown is BST, so we need to subtract 1 hour for UTC
    if (isInBST(d)) {
      d.setHours(d.getHours() - 1);
    }

    return d.toISOString();
  } catch (e) {
    return null;
  }
}

/**
 * Check if a given date falls within British Summer Time (BST).
 * BST runs from 01:00 UTC on the last Sunday of March to
 * 01:00 UTC on the last Sunday of October.
 * @param {Date} date - Date to check
 * @returns {boolean} - True if date is in BST period
 */
function isInBST(date) {
  const year = date.getFullYear();
  
  // Find last Sunday of March
  const marchEnd = new Date(year, 2, 31); // March 31
  const lastSundayMarch = new Date(marchEnd);
  lastSundayMarch.setDate(31 - ((marchEnd.getDay() + 7) % 7));
  lastSundayMarch.setHours(1, 0, 0, 0); // BST starts at 01:00 UTC
  
  // Find last Sunday of October
  const octEnd = new Date(year, 9, 31); // October 31
  const lastSundayOct = new Date(octEnd);
  lastSundayOct.setDate(31 - ((octEnd.getDay() + 7) % 7));
  lastSundayOct.setHours(1, 0, 0, 0); // BST ends at 01:00 UTC
  
  return date >= lastSundayMarch && date < lastSundayOct;
}

// ---------- Main Scrape ----------

/**
 * Scrape LiveOnSat UK/England all-football page.
 *
 * @param {Object} opts
 * @param {string} [opts.teamName] - Optional team filter.
 */
async function fetchLiveOnSatFixtures({ teamName } = {}) {
  const emptyResult = { fixtures: [] };
  log(`Fetching LiveOnSat fixtures${teamName ? ` for ${teamName}` : ''}`);

  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(PAGE_URL, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });

    await page.waitForSelector('body', { timeout: 15000 });

    // Extract raw fixture data in the browser context
    const rawFixtures = await page.evaluate(() => {
      const lines = document.body.innerText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0);

      const fixtures = [];

      // Matches day headers like "Friday, 5th December"
      const dayNameRegex = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i;

      /**
       * Fixture line regex - matches lines like:
       * "English Championship - Week 19 Hull City v Middlesbrough ST: 15:00"
       * 
       * Capture groups:
       * $1 = Competition + Round info (e.g., "English Championship - Week 19")
       * $2 = Home team name (e.g., "Hull City")
       * $3 = Away team name (e.g., "Middlesbrough")
       * $4 = Kickoff time in HH:MM format (e.g., "15:00")
       * 
       * Pattern breakdown:
       * ^(.*?-\s*.*?)   - Competition with round (non-greedy, must contain "-")
       * \s+(.+?)        - Home team (non-greedy)
       * \s+v\s+         - "v" separator with spaces
       * (.+?)           - Away team (non-greedy)
       * \s+ST:\s*       - "ST:" marker (Start Time)
       * ([0-9]{1,2}:[0-9]{2}) - Time in H:MM or HH:MM format
       * \s*$            - Optional trailing whitespace
       */
      const fixtureRegex = /^(.*?-\s*.*?)\s+(.+?)\s+v\s+(.+?)\s+ST:\s*([0-9]{1,2}:[0-9]{2})\s*$/i;

      let currentDateLabel = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Date header
        if (dayNameRegex.test(line)) {
          currentDateLabel = line;
          continue;
        }

        const m = line.match(fixtureRegex);
        if (!m) continue;

        const competitionRaw = m[1].trim(); // includes round info
        const home = m[2].trim();
        const away = m[3].trim();
        const timeString = m[4].trim();

        // Collect channels in following lines until we hit next fixture/date
        const channels = [];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];

          if (dayNameRegex.test(next)) break;
          if (fixtureRegex.test(next)) break;

          // Skip generic notes
          if (/^Please Note:/i.test(next)) continue;
          if (/^Members LOGIN/i.test(next)) continue;
          if (/^Members LOGOUT/i.test(next)) continue;

          const cleanedChan = next.replace(/📺/g, '').trim();
          if (cleanedChan.length > 0) {
            channels.push(cleanedChan);
          }
        }

        fixtures.push({
          dateLabel: currentDateLabel,
          competitionRaw,
          home,
          away,
          timeString,
          channels
        });
      }

      return fixtures;
    });

    await page.close();

    let fixtures = rawFixtures.map(f => {
      const kickoffUtc = parseKickoffUtc(f.dateLabel, f.timeString);
      let competition = f.competitionRaw || null;

      // Normalise competition a little bit (optional)
      if (competition) {
        competition = competition.replace(/\s+/g, ' ').trim();
      }

      return {
        home: f.home,
        away: f.away,
        kickoffUtc,
        competition,
        channels: Array.from(new Set(f.channels))
      };
    });

    // Filter out women's football and keep only UK teams
    fixtures = fixtures.filter(f => {
      const comp = (f.competition || '').toLowerCase();
      const home = (f.home || '').toLowerCase();
      const away = (f.away || '').toLowerCase();
      
      // Exclude women's football matches
      const isWomens = WOMENS_TERMS.some(term => 
        comp.includes(term) || home.includes(term) || away.includes(term)
      );
      
      // Check if competition matches any UK competition
      const isUkCompetition = UK_COMPETITIONS.some(ukComp => comp.includes(ukComp));
      
      // Keep only UK competitions that are not women's football
      return !isWomens && isUkCompetition;
    });

    // Optional team filter
    if (teamName) {
      const filterNorm = normalizeTeamName(teamName);
      fixtures = fixtures.filter(f => {
        const homeNorm = normalizeTeamName(f.home);
        const awayNorm = normalizeTeamName(f.away);

        return (
          homeNorm.includes(filterNorm) ||
          awayNorm.includes(filterNorm) ||
          filterNorm.includes(homeNorm) ||
          filterNorm.includes(awayNorm)
        );
      });
    }

    log(`LiveOnSat: found ${fixtures.length} fixtures`);
    return { fixtures };
  } catch (err) {
    log(`Error fetching LiveOnSat fixtures: ${err.message}`);
    return emptyResult;
  }
}

// ---------- Health Check ----------

async function healthCheck() {
  const start = Date.now();

  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();

    await page.goto(BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT
    });

    const title = await page.title();
    await page.close();

    const latencyMs = Date.now() - start;
    log(`[health] OK in ${latencyMs}ms`);
    return { ok: true, latencyMs, title };
  } catch (err) {
    const latencyMs = Date.now() - start;
    log(`[health] FAIL in ${latencyMs}ms: ${err.message}`);
    return { ok: false, latencyMs, error: err.message };
  }
}

// ---------- Unified Scrape Function ----------

/**
 * Unified scrape function with consistent signature.
 * @param {Object} params - Parameters
 * @param {string} [params.teamName] - Team name to filter by
 * @param {string} [params.date] - Date to scrape fixtures for (daily)
 * @returns {Promise<{fixtures: Array, source: string}>}
 */
async function scrape(params = {}) {
  const result = await fetchLiveOnSatFixtures(params);
  
  // Normalize to consistent format
  const fixtures = (result.fixtures || []).map(f => ({
    homeTeam: f.home || null,
    awayTeam: f.away || null,
    kickoffUtc: f.kickoffUtc || null,
    league: null,
    competition: f.competition || null,
    url: null,
    channels: f.channels || []
  }));
  
  return {
    fixtures,
    source: 'liveonsat'
  };
}

// ---------- Exports ----------

module.exports = {
  scrape,
  fetchLiveOnSatFixtures,
  healthCheck,
  normalizeTeamName,
  normalizeChannelName,
  BASE_URL
};

// Allow running as standalone for quick testing
if (require.main === module) {
  (async () => {
    console.log('Running LiveOnSat VPS Scraper health check...');
    const result = await healthCheck();
    console.log('Result:', result);

    console.log('Fetching sample fixtures...');
    const data = await fetchLiveOnSatFixtures({});
    console.log(`Got ${data.fixtures.length} fixtures`);
    if (data.fixtures.length > 0) {
      console.log('Sample fixtures:', JSON.stringify(data.fixtures.slice(0, 3), null, 2));
    }
    process.exit(result.ok ? 0 : 1);
  })();
}
