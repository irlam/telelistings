/**
 * File: scrapers/livefootballontv.js
 * Description: LiveFootballOnTV scraper (VPS) – UK-only, current-day fixtures, with UTC + UK-local times.
 * Notes: Filters out women’s/intl comps, keeps only fixtures where at least one UK team is involved,
 *        requires UK TV channels, and limits results to today (Europe/London).
 */

const puppeteer = require('puppeteer');

// ---------- Configuration ----------

const BASE_URL = 'https://www.live-footballontv.com';
const DEFAULT_TIMEOUT = 30000;

// Women’s / exclusions (expanded)
const WOMENS_TERMS = [
  'women', 'woman', 'womens', 'women’s', "women's", 'ladies', 'girls', 'girl',
  'wsl', 'fa wsl', 'barclays wsl', 'uwcl', "women's champions league", 'uwcl',
  'wfc', '(w)', ' ladies', ' women ', " women's ", ' women’s ', 'feminine', 'féminine'
];

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

// Known UK competitions
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

// Known UK TV channels for football
const UK_CHANNELS = [
  'Sky Sports Main Event',
  'Sky Sports Premier League',
  'Sky Sports Football',
  'Sky Sports',
  'TNT Sports 1',
  'TNT Sports 2',
  'TNT Sports 3',
  'TNT Sports 4',
  'TNT Sports',
  'BBC One',
  'BBC Two',
  'ITV1',
  'ITV4',
  'Channel 4',
  'Amazon Prime Video',
  'Amazon Prime',
  'Premier Sports 1',
  'Premier Sports 2',
  'BT Sport 1',
  'BT Sport 2',
  'BT Sport 3'
];

// UK team keywords (club and national identifiers)
const UK_TEAM_KEYWORDS = [
  // National teams
  'england', 'scotland', 'wales', 'northern ireland', 'great britain', 'team gb',
  // Premier League / Championship common clubs
  'manchester united', 'man utd', 'manchester city', 'man city',
  'liverpool', 'chelsea', 'arsenal', 'tottenham', 'spurs',
  'west ham', 'newcastle', 'aston villa', 'everton', 'nottingham forest', 'nottm forest',
  'brighton', 'wolves', 'wolverhampton', 'brentford', 'fulham', 'bournemouth',
  'sheffield united', 'sheff utd', 'luton', 'burnley',
  'leeds', 'leicester', 'southampton', 'ipswich', 'norwich', 'middlesbrough',
  'sunderland', 'stoke', 'coventry', 'west brom', 'derby', 'cardiff', 'swansea',
  'bristol city', 'bristol rovers', 'portsmouth', 'plymouth', 'qpr', 'queens park rangers',
  'millwall', 'charlton', 'bolton', 'blackburn', 'blackpool', 'hull', 'preston', 'wigan',
  'reading', 'oxford', 'cambridge', 'peterborough', 'wycombe', 'mk dons', 'milton keynes',
  'exeter', 'shrewsbury', 'cheltenham', 'burton', 'barnsley', 'doncaster', 'rotherham',
  'lincoln', 'grimsby', 'colchester', 'gillingham', 'walsall', 'stockport', 'oldham',
  'carlisle',
  // Scottish clubs
  'celtic', 'rangers', 'aberdeen', 'hearts', 'heart of midlothian', 'hibernian', 'hibs',
  'dundee', 'dundee united', 'motherwell', 'st mirren', 'kilmarnock', 'livingston',
  'ross county', 'st johnstone', 'partick', 'inverness', 'ayr', 'raith', 'dunfermline'
];

// Shared browser instance
let browser = null;

// ---------- Logging ----------

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [LFOTV-VPS] ${msg}`);
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
    .replace(/[\u2018\u2019]/g, "'")
    .trim()
    .replace(/\b(fc|afc)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, ' ')
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
  return formatter.format(date).replace(',', ''); // dd/MM/yyyy HH:mm
}

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

function resolveSeasonYear(dateLabel) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const monthMatch = dateLabel.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i);
  if (!monthMatch) return currentYear;

  const monthIndex = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ].indexOf(monthMatch[0].toLowerCase());

  if (monthIndex >= 7 && now.getMonth() <= 5) return currentYear - 1; // Aug-Dec, now Jan-Jun
  if (monthIndex <= 5 && now.getMonth() >= 7) return currentYear + 1; // Jan-Jun, now Aug-Dec
  return currentYear;
}

function parseKickoff(dateLabel, timeString) {
  if (!dateLabel || !timeString) return { kickoffUtc: null, kickoffLocal: null };

  const currentYear = resolveSeasonYear(dateLabel);
  const cleanedDate = dateLabel.replace(/(\d+)(st|nd|rd|th)/i, '$1'); // remove ordinals
  const dateString = `${cleanedDate} ${currentYear} ${timeString} GMT`;
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return { kickoffUtc: null, kickoffLocal: null };

  if (isInBST(d)) d.setHours(d.getHours() - 1); // adjust to UTC if local was BST

  const kickoffUtc = d.toISOString();
  const kickoffLocal = formatUkLocal(new Date(kickoffUtc));
  return { kickoffUtc, kickoffLocal };
}

function buildTodayLabels() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long',
    day: 'numeric',
    month: 'long'
  });
  const label = fmt.format(now); // e.g. "Tuesday, 9 December"
  const noComma = label.replace(',', ''); // "Tuesday 9 December"
  const ordinal = label.replace(/\b(\d{1,2})\b/, (_, d) => {
    const n = Number(d);
    const suf = n % 10 === 1 && n !== 11 ? 'st'
      : n % 10 === 2 && n !== 12 ? 'nd'
      : n % 10 === 3 && n !== 13 ? 'rd'
      : 'th';
    return `${d}${suf}`;
  });
  return [label, noComma, ordinal];
}

function isWomensFixture(home, away, competition) {
  const norm = (s) => (s || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const h = norm(home);
  const a = norm(away);
  const c = norm(competition);

  return WOMENS_TERMS.some(term => h.includes(term) || a.includes(term) || c.includes(term));
}

function isUkTeam(name) {
  const n = normalizeTeamName(name);
  if (!n) return false;
  return UK_TEAM_KEYWORDS.some(term => n.includes(term));
}

// ---------- Page Parsing ----------

async function extractFixtures(page, todayLabels, teamNameFilter) {
  return page.evaluate((todayLabelsInner, UK_CHANNELS, teamNameFilterInner) => {
    const dayRegex = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i;
    const timeRegex = /([0-9]{1,2}:[0-9]{2})/;
    const vsRegex = /\s+v(?:s)?\s+/i;

    const lines = document.body.innerText
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    const fixtures = [];
    let currentDate = null;

    const isToday = (label) => todayLabelsInner.some(t => label.toLowerCase().includes(t.toLowerCase()));

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (dayRegex.test(line)) {
        currentDate = line;
        continue;
      }

      // Only process blocks under today's date
      if (!currentDate || !isToday(currentDate)) continue;

      // Look for team line containing v/vs
      if (vsRegex.test(line)) {
        const teamLine = line;
        const timeLine = lines[i + 1] || '';
        const timeMatch = timeLine.match(timeRegex);
        if (!timeMatch) continue;

        const timeString = timeMatch[1];
        const vsMatch = vsRegex.exec(teamLine);
        if (!vsMatch) continue;

        const vsIndex = vsMatch.index;
        const vsSep = vsMatch[0];
        const home = teamLine.substring(0, vsIndex).trim();
        const away = teamLine.substring(vsIndex + vsSep.length).trim();

        // Competition might be on the previous line
        let competition = null;
        if (i > 0 && !dayRegex.test(lines[i - 1]) && !vsRegex.test(lines[i - 1])) {
          competition = lines[i - 1];
        }

        // Channels: collect in the next 1-3 lines
        const channels = [];
        for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
          const l = lines[j];
          const lLower = l.toLowerCase();
          UK_CHANNELS.forEach(ch => {
            if (lLower.includes(ch.toLowerCase())) channels.push(ch);
          });
        }

        // Team filter (browser side)
        if (teamNameFilterInner) {
          const norm = teamNameFilterInner.toLowerCase().replace(/\b(fc|afc)\b/gi, '').trim();
          const homeNorm = home.toLowerCase().replace(/\b(fc|afc)\b/gi, '').trim();
          const awayNorm = away.toLowerCase().replace(/\b(fc|afc)\b/gi, '').trim();
          if (
            !homeNorm.includes(norm) &&
            !awayNorm.includes(norm) &&
            !norm.includes(homeNorm) &&
            !norm.includes(awayNorm)
          ) {
            continue;
          }
        }

        fixtures.push({
          dateLabel: currentDate,
          timeString,
          home,
          away,
          competition,
          channels: Array.from(new Set(channels))
        });
      }
    }

    return fixtures;
  }, todayLabels, UK_CHANNELS, teamNameFilter);
}

// ---------- Main Function ----------

async function fetchLFOTVFixtures({ teamName, competition }) {
  const emptyResult = { fixtures: [] };
  log(`Fetching fixtures${teamName ? ` for ${teamName}` : ''}`);

  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    await page.goto(BASE_URL, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });

    await page.waitForSelector('body', { timeout: 10000 });

    const todayLabels = buildTodayLabels();
    let rawFixtures = await extractFixtures(page, todayLabels, teamName);

    await page.close();

    // Normalise and filter
    let fixtures = (rawFixtures || []).map(f => {
      const { kickoffUtc, kickoffLocal } = parseKickoff(f.dateLabel || todayLabels[0], f.timeString);
      return {
        home: f.home,
        away: f.away,
        kickoffUtc,
        kickoffLocal,
        competition: f.competition ? f.competition.trim() : null,
        channels: Array.from(new Set((f.channels || []).map(normalizeChannelName).filter(Boolean)))
      };
    });

    // Filter: women’s, international comps, require UK channel, and require UK team if comp not known UK
    const preFilter = fixtures.length;
    fixtures = fixtures.filter(f => {
      const comp = (f.competition || '').toLowerCase();
      const home = f.home || '';
      const away = f.away || '';

      if (isWomensFixture(home, away, comp)) return false;

      const isExcluded = EXCLUDE_COMPETITIONS.some(term => comp.includes(term));
      if (isExcluded) return false;

      // Require at least one UK channel
      if (!f.channels || f.channels.length === 0) return false;

      const compIsUk = f.competition
        ? KNOWN_COMPETITIONS.some(kc => comp.includes(kc.toLowerCase()))
        : false;

      // If competition is not explicitly UK, ensure at least one UK team
      if (!compIsUk) {
        const hasUkTeam = isUkTeam(home) || isUkTeam(away);
        if (!hasUkTeam) return false;
      }

      return true;
    });

    log(`Fixtures after filtering: ${fixtures.length} (filtered out ${preFilter - fixtures.length})`);

    // Competition filter (if provided)
    if (competition) {
      const compNorm = competition.toLowerCase();
      fixtures = fixtures.filter(f => (f.competition || '').toLowerCase().includes(compNorm));
    }

    log(`LiveFootballOnTV: found ${fixtures.length} fixtures`);
    return { fixtures };
  } catch (err) {
    log(`Error fetching fixtures: ${err.message}`);
    return emptyResult;
  }
}

// ---------- Health Check ----------

async function healthCheck() {
  const startTime = Date.now();

  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();

    await page.goto(BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT
    });

    const title = await page.title();
    await page.close();

    const latencyMs = Date.now() - startTime;
    log(`[health] OK in ${latencyMs}ms`);
    return { ok: true, latencyMs, title };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    log(`[health] FAIL in ${latencyMs}ms: ${err.message}`);
    return { ok: false, latencyMs, error: err.message };
  }
}

// ---------- Unified Scrape Function ----------

/**
 * Unified scrape function with consistent signature.
 * @param {Object} params - Parameters
 * @param {string} [params.teamName] - Team name to filter by
 * @param {string} [params.competition] - Competition to filter by
 * @returns {Promise<{fixtures: Array, source: string}>}
 */
async function scrape(params = {}) {
  const result = await fetchLFOTVFixtures(params);

  const fixtures = (result.fixtures || []).map(f => ({
    homeTeam: f.home || null,
    awayTeam: f.away || null,
    kickoffUtc: f.kickoffUtc || null,
    kickoffLocal: f.kickoffLocal || null, // UK dd/MM/yyyy HH:mm
    league: null,
    competition: f.competition || null,
    url: BASE_URL,
    channels: f.channels || []
  }));

  return {
    fixtures,
    source: 'livefootballontv'
  };
}

// ---------- Module Exports ----------

module.exports = {
  scrape,
  fetchLFOTVFixtures,
  healthCheck,
  normalizeTeamName,
  normalizeChannelName,
  UK_CHANNELS,
  BASE_URL
};

// Allow running as standalone
if (require.main === module) {
  (async () => {
    console.log('Running LiveFootballOnTV VPS Scraper health check...');
    const result = await healthCheck();
    console.log('Result:', result);
    process.exit(result.ok ? 0 : 1);
  })();
}
