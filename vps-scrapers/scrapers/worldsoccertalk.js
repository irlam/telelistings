// scrapers/worldsoccertalk.js
// World Soccer Talk scraper with Puppeteer support for VPS.
// This version uses Puppeteer for reliable scraping of JavaScript-rendered content.
/**
 * VPS World Soccer Talk Scraper
 *
 * Uses Puppeteer for browser automation to handle JavaScript-rendered content.
 * Can be run as a standalone service or integrated into the main VPS server.
 *
 * Exports fetchWorldSoccerTalkFixtures({ scheduleUrl }) which:
 * - Uses Puppeteer to load World Soccer Talk league schedule pages
 * - Parses table/list of fixtures with TV channels
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
 */

const puppeteer = require('puppeteer');

// ---------- Configuration ----------

const BASE_URL = 'https://worldsoccertalk.com';
const DEFAULT_SCHEDULE_URL = `${BASE_URL}/tv-schedule/`;
const DEFAULT_TIMEOUT = 30000;

// Known TV channels and streaming services (US focused)
const TV_CHANNELS = [
  'NBC',
  'NBC Sports',
  'NBCSN',
  'USA Network',
  'Peacock',
  'Telemundo',
  'Universo',
  'ESPN',
  'ESPN+',
  'ESPN2',
  'ESPN Deportes',
  'ABC',
  'FOX',
  'FS1',
  'FS2',
  'FOX Sports',
  'FOX Deportes',
  'CBS',
  'CBS Sports',
  'CBS Sports Network',
  'Paramount+',
  'beIN Sports',
  'beIN Sports en Español',
  'beIN Sports XTRA',
  'fuboTV',
  'TUDN',
  'UniMás',
  'Galavision',
  'Sky Sports',
  'TNT Sports',
  'Amazon Prime Video',
  'Amazon Prime',
  'Apple TV',
  'Apple TV+',
  'MLS Season Pass',
  'DAZN'
];

// Shared browser instance
let browser = null;

// ---------- Logging ----------

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [WST-VPS] ${msg}`);
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
    .trim()
    .replace(/\b(fc|afc|cf|sc|ac)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeChannelName(name) {
  return (name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .trim();
}

function extractChannels(text) {
  if (!text) return [];
  
  const channels = [];
  const textLower = text.toLowerCase();
  
  for (const channel of TV_CHANNELS) {
    if (textLower.includes(channel.toLowerCase())) {
      channels.push(channel);
    }
  }
  
  return [...new Set(channels)];
}

// ---------- Main Function ----------

async function fetchWorldSoccerTalkFixtures({ scheduleUrl } = {}) {
  const emptyResult = { fixtures: [] };
  
  const url = scheduleUrl || DEFAULT_SCHEDULE_URL;
  log(`Fetching fixtures from: ${url}`);
  
  let page = null;
  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });
    
    // Wait for content to load
    await page.waitForSelector('body', { timeout: 10000 });
    
    // Try to determine competition from URL
    const urlCompetition = url.match(/tv-schedule\/([^\/]+)/i);
    const defaultCompetition = urlCompetition ? 
      urlCompetition[1].replace(/-/g, ' ').replace(/tv schedule/i, '').trim() : null;
    
    // Extract fixtures using page.evaluate
    const fixtures = await page.evaluate((TV_CHANNELS, defaultCompetition) => {
      const results = [];
      
      // Try multiple selectors for fixtures on World Soccer Talk
      const fixtureSelectors = [
        '.schedule-table tbody tr',
        '.fixture-row',
        '.match-row',
        '.tv-listing',
        'table tbody tr',
        '[class*="match"]',
        '[class*="fixture"]',
        '.event-row'
      ];
      
      for (const selector of fixtureSelectors) {
        const elements = document.querySelectorAll(selector);
        
        elements.forEach(el => {
          try {
            const text = el.innerText || el.textContent || '';
            
            // Skip header rows
            if (el.querySelector('th')) return;
            
            // Extract teams
            let homeTeam = '';
            let awayTeam = '';
            
            // Try specific selectors
            const homeEl = el.querySelector('.home-team, .home, [class*="home"], td.home');
            const awayEl = el.querySelector('.away-team, .away, [class*="away"], td.away');
            
            if (homeEl) homeTeam = homeEl.innerText.trim();
            if (awayEl) awayTeam = awayEl.innerText.trim();
            
            // Try match column that may contain both teams
            const matchEl = el.querySelector('.match, .teams, .matchup, td:nth-child(2)');
            if (matchEl && (!homeTeam || !awayTeam)) {
              const matchText = matchEl.innerText.trim();
              const vsMatch = matchText.match(/([A-Za-z\s\-'\.0-9]+)\s+(?:v|vs|versus|at|@|–|-)\s+([A-Za-z\s\-'\.0-9]+)/i);
              if (vsMatch) {
                homeTeam = vsMatch[1].trim();
                awayTeam = vsMatch[2].trim();
              }
            }
            
            // Fallback: parse from full row text
            if (!homeTeam || !awayTeam) {
              const vsMatch = text.match(/([A-Za-z\s\-'\.0-9]+)\s+(?:v|vs|versus|at|@|–|-)\s+([A-Za-z\s\-'\.0-9]+)/i);
              if (vsMatch) {
                homeTeam = vsMatch[1].trim();
                awayTeam = vsMatch[2].trim();
              }
            }
            
            // Clean up team names
            homeTeam = homeTeam
              .replace(/\b(fc|afc|cf|sc|ac)\b/gi, '')
              .replace(/\s+/g, ' ')
              .trim();
            awayTeam = awayTeam
              .replace(/\b(fc|afc|cf|sc|ac)\b/gi, '')
              .replace(/\s+/g, ' ')
              .trim();
            
            if (!homeTeam || !awayTeam) return;
            
            // Extract date/time
            let kickoffUtc = null;
            const dateEl = el.querySelector('.date, time, [datetime], .time, td:first-child');
            if (dateEl) {
              kickoffUtc = dateEl.getAttribute('datetime') || dateEl.innerText.trim() || null;
            }
            
            // Try to find date/time pattern in text
            if (!kickoffUtc) {
              const dateMatch = text.match(/(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/);
              const timeMatch = text.match(/(\d{1,2}[:\.]?\d{2}\s*(am|pm|ET|PT|CT)?)/i);
              if (dateMatch || timeMatch) {
                kickoffUtc = [dateMatch?.[1], timeMatch?.[1]].filter(Boolean).join(' ');
              }
            }
            
            // Extract TV channels and streaming services
            const channels = [];
            const textLower = text.toLowerCase();
            for (const channel of TV_CHANNELS) {
              if (textLower.includes(channel.toLowerCase())) {
                channels.push(channel);
              }
            }
            
            // Look for TV/channel column
            const tvEl = el.querySelector('.tv, .channel, .broadcaster, .stream, td:last-child');
            if (tvEl) {
              const tvText = tvEl.innerText.trim();
              // Parse channels separated by comma, slash, etc.
              const tvChannels = tvText.split(/[,;\/\n]/).map(c => c.trim()).filter(c => c);
              tvChannels.forEach(ch => {
                if (!channels.includes(ch) && ch.length > 1) {
                  channels.push(ch);
                }
              });
            }
            
            results.push({
              home: homeTeam,
              away: awayTeam,
              kickoffUtc,
              competition: defaultCompetition,
              channels: [...new Set(channels.map(c => c.trim()).filter(c => c))]
            });
          } catch (e) {
            // Skip malformed fixtures
          }
        });
        
        if (results.length > 0) break;
      }
      
      return results;
    }, TV_CHANNELS, defaultCompetition);
    
    await page.close();
    page = null;
    
    log(`Found ${fixtures.length} fixtures`);
    return { fixtures };
    
  } catch (err) {
    log(`Error fetching fixtures: ${err.message}`);
    if (page) {
      try { await page.close(); } catch (e) { /* ignore */ }
    }
    return emptyResult;
  }
}

async function healthCheck() {
  const startTime = Date.now();
  let page = null;
  
  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();
    
    await page.goto(DEFAULT_SCHEDULE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT
    });
    
    const title = await page.title();
    
    // Check for expected schedule heading
    const hasExpectedContent = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('tv schedule') || 
             text.includes('soccer schedule') || 
             text.includes('football schedule') ||
             text.includes('world soccer talk');
    });
    
    await page.close();
    page = null;
    
    const latencyMs = Date.now() - startTime;
    log(`[health] ${hasExpectedContent ? 'OK' : 'WARN'} in ${latencyMs}ms`);
    return { ok: hasExpectedContent, latencyMs, title };
    
  } catch (err) {
    if (page) {
      try { await page.close(); } catch (e) { /* ignore */ }
    }
    const latencyMs = Date.now() - startTime;
    log(`[health] FAIL in ${latencyMs}ms: ${err.message}`);
    return { ok: false, latencyMs, error: err.message };
  }
}

// ---------- Unified Scrape Function ----------

/**
 * Unified scrape function with consistent signature.
 * @param {Object} params - Parameters
 * @param {string} [params.scheduleUrl] - Schedule URL to scrape
 * @returns {Promise<{fixtures: Array, source: string}>}
 */
async function scrape(params = {}) {
  const result = await fetchWorldSoccerTalkFixtures(params);
  
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
    source: 'worldsoccertalk'
  };
}

// ---------- Module Exports ----------

module.exports = {
  scrape,
  fetchWorldSoccerTalkFixtures,
  healthCheck,
  normalizeTeamName,
  normalizeChannelName,
  extractChannels,
  TV_CHANNELS,
  BASE_URL
};

// Allow running as standalone
if (require.main === module) {
  (async () => {
    console.log('Running World Soccer Talk VPS Scraper health check...');
    const result = await healthCheck();
    console.log('Result:', result);
    
    if (result.ok) {
      console.log('\nFetching fixtures...');
      const fixtures = await fetchWorldSoccerTalkFixtures();
      console.log('Fixtures:', JSON.stringify(fixtures, null, 2));
    }
    
    process.exit(result.ok ? 0 : 1);
  })();
}
