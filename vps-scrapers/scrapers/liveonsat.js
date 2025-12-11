/**
 * File: scrapers/liveonsat.js
 * Description: LiveOnSat UK/England football TV listings scraper for VPS.
 * Notes: Scrapes desktop then mobile layouts, parses fixtures, normalises channels,
 *        filters non-UK and women’s games, and returns UK-formatted kick-off times.
 */

const puppeteer = require('puppeteer');

// ---------- Configuration ----------

const BASE_URL = 'https://liveonsat.com';
const PAGE_URL = `${BASE_URL}/uk-england-all-football.php`;
const MOBILE_URL = `${BASE_URL}/m/uk-england-all-football`;
const DEFAULT_TIMEOUT = 45000;
const MIN_TEXT_LENGTH = 3;

// Women’s football filter terms
const WOMENS_TERMS = ['women', 'ladies', 'wsl', 'womens'];

// International/European competitions to exclude (not UK domestic)
const EXCLUDE_COMPETITIONS = [
  'champions league',
  'europa league',
  'conference league',
  'world cup',
  'euro ',
  'uefa',
  'international',
  'la liga',
  'serie a',
  'bundesliga',
  'ligue 1',
  'eredivisie'
];

// Known UK competition names
const KNOWN_COMPETITIONS = [
  'Premier League',
  'English Premier League',
  'EPL',
  'Championship',
  'English Championship',
  'League One',
  'English League One',
  'League Two',
  'English League Two',
  'FA Cup',
  'EFL Cup',
  'Carabao Cup',
  'League Cup',
  'Scottish Premiership',
  'Scottish Championship',
  'Scottish League One',
  'Scottish League Two',
  'Scottish Cup',
  'Welsh Premier',
  'National League'
];

const KNOWN_COMPETITION_REGEXES = KNOWN_COMPETITIONS.map(name => ({
  name,
  regex: new RegExp(`^(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s+(.+)$`, 'i')
}));

// Shared browser instance
let browser = null;

// ---------- Logging ----------

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [LIVEONSAT-VPS] ${msg}`);
}

// ---------- Browser Management ----------

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

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
    .replace(/📺/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatUkLocal(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  // Remove the comma produced by en-GB default format
  return formatter.format(date).replace(',', '');
}

/**
 * Parse kickoff time to UTC ISO string and UK-formatted local string.
 * @param {string} dateLabel e.g. "Friday, 5th December"
 * @param {string} timeString e.g. "15:00" (UK local time)
 * @returns {{ kickoffUtc: string|null, kickoffLocal: string|null }}
 */
function parseKickoff(dateLabel, timeString) {
  if (!dateLabel || !timeString) return { kickoffUtc: null, kickoffLocal: null };

  const currentYear = resolveSeasonYear(dateLabel);

  // Remove ordinal suffixes
  const cleanedDate = dateLabel.replace(/(\d+)(st|nd|rd|th)/i, '$1');

  // Parse as GMT then adjust for BST manually
  const dateString = `${cleanedDate} ${currentYear} ${timeString} GMT`;
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return { kickoffUtc: null, kickoffLocal: null };

  // If local time was BST, subtract one hour to convert to UTC
  if (isInBST(d)) {
    d.setHours(d.getHours() - 1);
  }

  const kickoffUtc = d.toISOString();
  const kickoffLocal = formatUkLocal(new Date(kickoffUtc));
  return { kickoffUtc, kickoffLocal };
}

/**
 * Resolve season year: keep fixtures in the same season across year boundary.
 */
function resolveSeasonYear(dateLabel) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const monthMatch = dateLabel.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i);
  if (!monthMatch) return currentYear;

  const monthIndex = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ].indexOf(monthMatch[0].toLowerCase());

  if (monthIndex >= 7 && now.getMonth() <= 5) return currentYear - 1; // Aug-Dec while now is Jan-Jun
  if (monthIndex <= 5 && now.getMonth() >= 7) return currentYear + 1; // Jan-Jun while now is Aug-Dec
  return currentYear;
}

/**
 * Check if a given date falls within British Summer Time (BST).
 * BST runs from 01:00 UTC on the last Sunday of March to
 * 01:00 UTC on the last Sunday of October.
 */
function isInBST(date) {
  const year = date.getFullYear();

  const marchEnd = new Date(year, 2, 31);
  const lastSundayMarch = new Date(marchEnd);
  lastSundayMarch.setDate(31 - ((marchEnd.getDay() + 7) % 7));
  lastSundayMarch.setHours(1, 0, 0, 0);

  const octEnd = new Date(year, 9, 31);
  const lastSundayOct = new Date(octEnd);
  lastSundayOct.setDate(31 - ((octEnd.getDay() + 7) % 7));
  lastSundayOct.setHours(1, 0, 0, 0);

  return date >= lastSundayMarch && date < lastSundayOct;
}

// ---------- Page Parsing ----------

/**
 * Extract fixtures using desktop/mobile DOM and text fallback.
 * Returns { fixtures, debug }
 */
async function extractFixtures(page) {
  // DOM-first extraction (handles current table/div layouts)
  const domResult = await page.evaluate(() => {
    const fixtures = [];
    const debug = [];

    const dayHeaderRegex = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i;
    const timeLineRegex = /^ST:\s*([0-9]{1,2}:[0-9]{2})\s*$/i;
    const vsSeparatorRegex = /\s+v(?:s)?\s+/i;

    // Flatten leaf nodes for order-preserving scan
    const blocks = [];
    const allNodes = Array.from(document.querySelectorAll('body *')).filter(el => el.childElementCount === 0);
    allNodes.forEach(node => {
      const text = (node.innerText || '').trim();
      if (!text) return;
      blocks.push({ text, tag: node.tagName, className: node.className });
    });

    let currentDate = null;
    for (let i = 0; i < blocks.length; i++) {
      const line = blocks[i].text;

      if (dayHeaderRegex.test(line)) {
        currentDate = line;
        debug.push(`DATE: ${line}`);
        continue;
      }

      const timeMatch = line.match(timeLineRegex);
      if (timeMatch) {
        const timeString = timeMatch[1].trim();
        if (i < 1) {
          debug.push(`SKIP time idx ${i} no team line`);
          continue;
        }

        const teamLine = blocks[i - 1].text;
        const vsMatch = vsSeparatorRegex.exec(teamLine);
        if (!vsMatch) {
          debug.push(`SKIP team line "${teamLine}" lacks vs`);
          continue;
        }

        const vsIndex = vsMatch.index;
        const vsSeparator = vsMatch[0];
        const home = teamLine.substring(0, vsIndex).trim();
        const away = teamLine.substring(vsIndex + vsSeparator.length).trim();

        // competition line if present 2 lines above
        let competition = '';
        if (i >= 2 && !dayHeaderRegex.test(blocks[i - 2].text)) {
          competition = blocks[i - 2].text.trim();
        }

        // collect channels forward until next date/team/time
        const channels = [];
        for (let j = i + 1; j < blocks.length; j++) {
          const next = blocks[j].text;

          if (dayHeaderRegex.test(next)) break;
          if (timeLineRegex.test(next)) break;
          if (vsSeparatorRegex.test(next)) break;
          if (/^Please Note:/i.test(next)) continue;
          if (/^Members LOGIN/i.test(next) || /^Members LOGOUT/i.test(next)) continue;
          if (/\s+-\s+(Week|Round|Matchday|Match Day|MD|GW|Proper)\s+/i.test(next)) continue;
          if (/^(English|Scottish|Welsh|Irish|European|UEFA)\s+(Premier League|Championship|League|FA Cup|EFL|WSL)/i.test(next)) continue;

          const cleaned = next.replace(/📺/g, '').trim();
          if (cleaned.length) channels.push(cleaned);
        }

        fixtures.push({
          dateLabel: currentDate,
          competitionRaw: competition,
          home,
          away,
          timeString,
          channels
        });
      }
    }

    return { fixtures, debug };
  });

  if (domResult.fixtures.length > 0) return domResult;

  // Fallback: plain text scan (legacy)
  const textResult = await page.evaluate(() => {
    const fixtures = [];
    const debug = [];
    const lines = document.body.innerText
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    const dayNameRegex = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i;
    const timeLineRegex = /^ST:\s*([0-9]{1,2}:[0-9]{2})\s*$/i;
    const vsSeparatorRegex = /\s+v(?:s)?\s+/i;

    let currentDateLabel = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (dayNameRegex.test(line)) {
        currentDateLabel = line;
        debug.push(`DATE: ${line}`);
        continue;
      }

      const timeMatch = line.match(timeLineRegex);
      if (timeMatch) {
        const timeString = timeMatch[1].trim();
        if (i < 1) {
          debug.push(`SKIP time idx ${i} no previous line`);
          continue;
        }

        const teamLine = lines[i - 1];
        const vsMatch = vsSeparatorRegex.exec(teamLine);
        if (!vsMatch) {
          debug.push(`SKIP: "${teamLine}" no vs`);
          continue;
        }

        const vsIndex = vsMatch.index;
        const vsSeparator = vsMatch[0];
        const home = teamLine.substring(0, vsIndex).trim();
        const away = teamLine.substring(vsIndex + vsSeparator.length).trim();

        let competition = '';
        if (i >= 2) {
          const competitionLine = lines[i - 2];
          if (!dayNameRegex.test(competitionLine)) competition = competitionLine;
        }

        const channels = [];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];

          if (dayNameRegex.test(next)) break;
          if (timeLineRegex.test(next)) break;
          if (vsSeparatorRegex.test(next)) break;
          if (/^Please Note:/i.test(next)) continue;
          if (/^Members LOGIN/i.test(next) || /^Members LOGOUT/i.test(next)) continue;
          if (/\s+-\s+(Week|Round|Matchday|Match Day|MD|GW|Proper)\s+/i.test(next)) continue;
          if (/^(English|Scottish|Welsh|Irish|European|UEFA)\s+(Premier League|Championship|League|FA Cup|EFL|WSL)/i.test(next)) continue;

          const cleanedChan = next.replace(/📺/g, '').trim();
          if (cleanedChan.length > 0) channels.push(cleanedChan);
        }

        fixtures.push({
          dateLabel: currentDateLabel,
          competitionRaw: competition,
          home,
          away,
          timeString,
          channels
        });
      } else if (line.includes(' v ') || line.includes(' vs ')) {
        debug.push(`POTENTIAL TEAMS: ${line}`);
      }
    }

    return { fixtures, debug };
  });

  return textResult;
}

// ---------- Main Scrape ----------

async function fetchLiveOnSatFixtures({ teamName } = {}) {
  const emptyResult = { fixtures: [] };
  log(`Fetching LiveOnSat fixtures${teamName ? ` for ${teamName}` : ''}`);

  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/122.0.0.0 Safari/537.36'
    );

    // Try desktop first, then mobile if empty
    let usedUrl = PAGE_URL;
    await page.goto(PAGE_URL, { waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT });
    await page.waitForSelector('body', { timeout: 15000 });

    let rawFixtures = await extractFixtures(page);

    if (!rawFixtures.fixtures.length) {
      log('Desktop parse empty, retrying mobile layout');
      usedUrl = MOBILE_URL;
      await page.goto(MOBILE_URL, { waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT });
      await page.waitForSelector('body', { timeout: 15000 });
      rawFixtures = await extractFixtures(page);
    }

    await page.close();

    if (rawFixtures.debug?.length) {
      log('--- Debug Info (first 50 lines) ---');
      rawFixtures.debug.slice(0, 50).forEach(line => log(line));
      log('--- End Debug Info ---');
    }

    let fixtures = (rawFixtures.fixtures || []).map(f => {
      const { kickoffUtc, kickoffLocal } = parseKickoff(f.dateLabel, f.timeString);
      let competition = f.competitionRaw || null;
      if (competition) competition = competition.replace(/\s+/g, ' ').trim();

      return {
        home: f.home,
        away: f.away,
        kickoffUtc,
        kickoffLocal, // UK-format dd/MM/yyyy HH:mm (Europe/London)
        competition,
        channels: Array.from(new Set(f.channels.map(normalizeChannelName).filter(Boolean)))
      };
    });

    // Filter out unwanted fixtures
    const preFilterCount = fixtures.length;
    fixtures = fixtures.filter(f => {
      const comp = (f.competition || '').toLowerCase();
      const home = (f.home || '').toLowerCase();
      const away = (f.away || '').toLowerCase();

      const isWomens = WOMENS_TERMS.some(term =>
        comp.includes(term) || home.includes(term) || away.includes(term)
      );
      if (isWomens) {
        log(`Filtered out women's match: ${f.home} v ${f.away} (${f.competition})`);
        return false;
      }

      const isExcluded = EXCLUDE_COMPETITIONS.some(excludeComp => comp.includes(excludeComp));
      if (isExcluded) {
        log(`Filtered out international/European: ${f.home} v ${f.away} (${f.competition})`);
        return false;
      }

      return true;
    });

    log(`Fixtures after filtering: ${fixtures.length} (filtered out ${preFilterCount - fixtures.length})`);

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

    const debugInfo = {
      rawFixturesFound: rawFixtures.fixtures?.length || 0,
      afterFiltering: fixtures.length,
      filteredOut: preFilterCount - fixtures.length,
      debugLinesCount: rawFixtures.debug?.length || 0,
      debugLinesSample: rawFixtures.debug?.slice(0, 20) || []
    };

    return { fixtures, debugInfo, usedUrl };
  } catch (err) {
    log(`Error fetching LiveOnSat fixtures: ${err.message}`);
    return {
      ...emptyResult,
      debugInfo: {
        error: err.message,
        stack: err.stack
      }
    };
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

async function scrape(params = {}) {
  const result = await fetchLiveOnSatFixtures(params);

  const fixtures = (result.fixtures || []).map(f => ({
    homeTeam: f.home || null,
    awayTeam: f.away || null,
    kickoffUtc: f.kickoffUtc || null,
    kickoffLocal: f.kickoffLocal || null, // UK dd/MM/yyyy HH:mm (Europe/London)
    league: null,
    competition: f.competition || null,
    url: result.usedUrl || PAGE_URL,
    channels: f.channels || []
  }));

  const response = {
    fixtures,
    source: 'liveonsat'
  };

  if (params.debug || fixtures.length === 0) {
    response.debug = {
      url: result.usedUrl || PAGE_URL,
      fixturesFound: fixtures.length,
      debugInfo: result.debugInfo || 'No debug info available',
      message: fixtures.length === 0
        ? 'No fixtures found. Possible reasons: no matches on LiveOnSat, page format changed, or parsing error. Check debug info.'
        : 'Fixtures found successfully'
    };
  }

  return response;
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
