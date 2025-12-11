// scrapers/wheresthematch.js
// Where's The Match (UK) scraper with Puppeteer support for VPS.
//
// Uses Puppeteer to handle the JS-rendered table on
// https://www.wheresthematch.com/live-football-on-tv/
//
// Exports:
//   - fetchWheresTheMatchFixtures()
//   - scrape({ date })  // date is ignored; we scrape all fixtures on the page

const puppeteer = require('puppeteer');

const BASE_URL = 'https://www.wheresthematch.com';
const FIXTURES_URL = `${BASE_URL}/live-football-on-tv/`;
const DEFAULT_TIMEOUT = 30000;

// Known UK TV channels for football (used to sanity-check free-text)
const UK_CHANNELS = [
  'Sky Sports Main Event',
  'Sky Sports Premier League',
  'Sky Sports Football',
  'Sky Sports Arena',
  'Sky Sports Action',
  'Sky Sports Mix',
  'Sky Sports News',
  'Sky Sports+',
  'Sky Sports',
  'TNT Sports 1',
  'TNT Sports 2',
  'TNT Sports 3',
  'TNT Sports 4',
  'TNT Sports Ultimate',
  'TNT Sports Extra',
  'TNT Sports',
  'BBC One',
  'BBC Two',
  'BBC iPlayer',
  'ITV1',
  'ITV4',
  'ITVX',
  'Channel 4',
  'Amazon Prime Video',
  'Amazon Prime',
  'Premier Sports 1',
  'Premier Sports 2',
  'Premier Sports',
  'BT Sport 1',
  'BT Sport 2',
  'BT Sport 3',
  'LaLigaTV',
  'FreeSports',
  'discovery+',
  'Discovery+',
  'DAZN'
];

let browser = null;

// ---------- Logging ----------

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [WTM-VPS] ${msg}`);
}

// ---------- Browser management ----------

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
    .trim()
    .replace(/\b(fc|afc|cf|sc|ac)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeChannelName(name) {
  return (name || '')
    .replace(/logo/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractChannelsFromText(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found = [];
  for (const ch of UK_CHANNELS) {
    if (lower.includes(ch.toLowerCase())) {
      found.push(ch);
    }
  }
  return [...new Set(found)];
}

// ---------- Core scraper ----------

/**
 * Fetch fixtures from Where's The Match.
 *
 * NOTE: we *do not* filter by date here. The page is "this week on TV" and
 * date-window filtering is done at the Telelistings aggregator layer.
 */
async function fetchWheresTheMatchFixtures() {
  const empty = { fixtures: [] };

  log("Fetching fixtures from Where's The Match (no date filter, women's fixtures excluded)");

  let page = null;
  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(FIXTURES_URL, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });

    await page.waitForSelector('body', { timeout: 10000 });

    const fixtures = await page.evaluate((UK_CHANNELS) => {
      const results = [];

      const rows = Array.from(
        document.querySelectorAll('tr[itemscope][itemtype*="BroadcastEvent"]')
      );

      rows.forEach(row => {
        try {
          const rowText = row.innerText || row.textContent || '';
          const rowLower = rowText.toLowerCase();

          // Skip women's / ladies fixtures
          if (
            rowLower.includes("women's") ||
            rowLower.includes('womens') ||
            rowLower.includes('women ') ||
            rowLower.includes('ladies')
          ) {
            return;
          }

          const fixtureCell = row.querySelector('td.fixture-details');
          const startCell = row.querySelector('td.start-details');
          const compCell = row.querySelector('td.competition-name');
          const chanCell = row.querySelector('td.channel-details');

          if (!fixtureCell || !startCell) return;

          const fixtureText = (fixtureCell.innerText || fixtureCell.textContent || '').trim();
          if (!fixtureText) return;

          // Prefer using the <a title="Team"> elements for team names
          const teamLinks = Array.from(
            fixtureCell.querySelectorAll('span.fixture a[title]')
          );
          let homeTeam = '';
          let awayTeam = '';

          if (teamLinks.length >= 2) {
            homeTeam = teamLinks[0].getAttribute('title') || teamLinks[0].innerText;
            awayTeam = teamLinks[teamLinks.length - 1].getAttribute('title') ||
                       teamLinks[teamLinks.length - 1].innerText;
          } else {
            // Fallback: parse "Team A v Team B"
            const vsMatch = fixtureText.match(
              /([A-Za-z\s\-'\.0-9]+)\s+(?:v|vs|versus|–|-)\s+([A-Za-z\s\-'\.0-9]+)/i
            );
            if (vsMatch) {
              homeTeam = vsMatch[1];
              awayTeam = vsMatch[2];
            }
          }

          homeTeam = normalizeTeamName(homeTeam);
          awayTeam = normalizeTeamName(awayTeam);
          if (!homeTeam || !awayTeam) return;

          // Kickoff – take the ISO datetime from the start-details cell if present
          let kickoffUtc = startCell.getAttribute('content') || null;
          if (!kickoffUtc) {
            const meta = row.querySelector('meta[itemprop="startDate"]');
            if (meta && meta.getAttribute('content')) {
              kickoffUtc = meta.getAttribute('content');
            }
          }
          if (!kickoffUtc) {
            const timeEl = startCell.querySelector('.time em');
            if (timeEl && timeEl.textContent.trim()) {
              kickoffUtc = timeEl.textContent.trim(); // fallback: local time string
            }
          }

          // Competition name
          let competition = null;
          if (compCell) {
            const span = compCell.querySelector('span');
            competition = (span ? span.innerText : compCell.innerText || '').trim() || null;
          }

          // Channels from logos + any text
          const channels = [];
          if (chanCell) {
            const text = (chanCell.innerText || chanCell.textContent || '').trim();
            channels.push(...extractChannelsFromText(text));

            const logos = Array.from(chanCell.querySelectorAll('img'));
            logos.forEach(img => {
              const title = img.getAttribute('title') || '';
              const alt = img.getAttribute('alt') || '';
              let name = title || alt;
              if (!name) return;

              // alt strings like "Discovery+ logo" → "Discovery+"
              name = name.replace(/logo/i, '').trim();
              channels.push(name);
            });
          }

          const normalizedChannels = Array.from(
            new Set(
              channels
                .map(ch => normalizeChannelName(ch))
                .filter(Boolean)
            )
          );

          results.push({
            home: homeTeam,
            away: awayTeam,
            kickoffUtc,
            competition,
            channels: normalizedChannels
          });
        } catch (e) {
          // skip bad row
        }
      });

      return results;
    }, UK_CHANNELS);

    await page.close();
    page = null;

    log(`Found ${fixtures.length} fixtures`);
    return { fixtures };
  } catch (err) {
    log(`Error fetching fixtures: ${err.message}`);
    if (page) {
      try { await page.close(); } catch (_) {}
    }
    return empty;
  }
}

// ---------- Health check ----------

async function healthCheck() {
  const start = Date.now();
  let page = null;

  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();

    await page.goto(FIXTURES_URL, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT
    });

    const title = await page.title();
    const ok = await page.evaluate(() => {
      const t = document.body.innerText.toLowerCase();
      return t.includes('live football') || t.includes('channels');
    });

    await page.close();
    page = null;

    const latencyMs = Date.now() - start;
    log(`[health] ${ok ? 'OK' : 'WARN'} in ${latencyMs}ms`);
    return { ok, latencyMs, title };
  } catch (err) {
    if (page) {
      try { await page.close(); } catch (_) {}
    }
    const latencyMs = Date.now() - start;
    log(`[health] FAIL in ${latencyMs}ms: ${err.message}`);
    return { ok: false, latencyMs, error: err.message };
  }
}

// ---------- Unified scrape() wrapper ----------

async function scrape(params = {}) {
  const result = await fetchWheresTheMatchFixtures(params);

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
    source: 'wheresthematch'
  };
}

module.exports = {
  scrape,
  fetchWheresTheMatchFixtures,
  healthCheck,
  normalizeTeamName,
  normalizeChannelName,
  extractChannelsFromText,
  UK_CHANNELS,
  BASE_URL
};

// Allow manual CLI run
if (require.main === module) {
  (async () => {
    console.log("Running Where's The Match VPS Scraper health check…");
    const health = await healthCheck();
    console.log('Health:', health);

    if (health.ok) {
      console.log('\nFetching fixtures…');
      const res = await fetchWheresTheMatchFixtures();
      console.log('Fixtures:', JSON.stringify(res.fixtures, null, 2));
    }

    process.exit(health.ok ? 0 : 1);
  })();
}
