// scrapers/oddalerts.js
// OddAlerts TV Guide scraper with Puppeteer support for VPS.
// This version uses Puppeteer for reliable scraping of JavaScript-rendered content.
/**
 * VPS OddAlerts TV Guide Scraper
 *
 * Uses Puppeteer for browser automation to handle JavaScript-rendered content.
 * Can be run as a standalone service or integrated into the main VPS server.
 *
 * Exports fetchOddAlertsFixtures({ date }) which:
 * - Uses Puppeteer to load OddAlerts TV Guide page
 * - Waits for dynamic content to load (updates every 15 minutes)
 * - Parses fixture list with TV channels
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

const BASE_URL = 'https://oddalerts.com';
const TV_GUIDE_URL = `${BASE_URL}/tv-guide`;
const DEFAULT_TIMEOUT = 30000;

// Known TV channels and streaming providers
const TV_CHANNELS = [
  'Sky Sports Main Event',
  'Sky Sports Premier League',
  'Sky Sports Football',
  'Sky Sports Arena',
  'Sky Sports Action',
  'Sky Sports',
  'TNT Sports 1',
  'TNT Sports 2',
  'TNT Sports 3',
  'TNT Sports 4',
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
  'DAZN',
  'ESPN',
  'ESPN+',
  'beIN Sports',
  'Paramount+',
  'Peacock'
];

// Shared browser instance
let browser = null;

// ---------- Logging ----------

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [ODDALERTS-VPS] ${msg}`);
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

async function fetchOddAlertsFixtures({ date } = {}) {
  const emptyResult = { fixtures: [] };
  
  log(`Fetching fixtures${date ? ` for ${date}` : ' for today'}`);
  
  let page = null;
  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.goto(TV_GUIDE_URL, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });
    
    // Wait for content to load - OddAlerts dynamically updates every 15 minutes
    await page.waitForSelector('body', { timeout: 10000 });
    
    // Give extra time for dynamic content
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Extract fixtures using page.evaluate
    const fixtures = await page.evaluate((TV_CHANNELS) => {
      const results = [];
      
      // Try multiple selectors for match cards/rows on OddAlerts
      const fixtureSelectors = [
        '.match-card',
        '.match-row',
        '.fixture',
        '.event-row',
        '[class*="match"]',
        '[class*="fixture"]',
        '[class*="event"]',
        'table tbody tr',
        '.tv-listing',
        '.game'
      ];
      
      for (const selector of fixtureSelectors) {
        const elements = document.querySelectorAll(selector);
        
        elements.forEach(el => {
          try {
            const text = el.innerText || el.textContent || '';
            
            // Extract teams
            let homeTeam = '';
            let awayTeam = '';
            
            // Try specific selectors
            const homeEl = el.querySelector('.home-team, .home, [class*="home"]');
            const awayEl = el.querySelector('.away-team, .away, [class*="away"]');
            
            if (homeEl) homeTeam = homeEl.innerText.trim();
            if (awayEl) awayTeam = awayEl.innerText.trim();
            
            // Try team name elements
            const teamEls = el.querySelectorAll('.team, .team-name, [class*="team"]');
            if (teamEls.length >= 2 && (!homeTeam || !awayTeam)) {
              homeTeam = teamEls[0].innerText.trim();
              awayTeam = teamEls[1].innerText.trim();
            }
            
            // Fallback: parse from text for "vs" or "v" patterns
            if (!homeTeam || !awayTeam) {
              const vsMatch = text.match(/([A-Za-z\s\-'\.]+)\s+(?:v|vs|versus|–|-)\s+([A-Za-z\s\-'\.]+)/i);
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
            
            // Extract kickoff time
            let kickoffUtc = null;
            const timeEl = el.querySelector('time, [datetime], .time, .kickoff, .ko');
            if (timeEl) {
              kickoffUtc = timeEl.getAttribute('datetime') || timeEl.innerText.trim() || null;
            }
            
            // Try to find time pattern in text
            if (!kickoffUtc) {
              const timeMatch = text.match(/(\d{1,2}[:\.]?\d{2}\s*(am|pm)?)/i);
              if (timeMatch) {
                kickoffUtc = timeMatch[1];
              }
            }
            
            // Extract competition/league
            let competition = null;
            const compEl = el.querySelector('.competition, .league, .tournament, [class*="competition"], [class*="league"]');
            if (compEl) {
              competition = compEl.innerText.trim();
            }
            
            // Extract TV channels and streaming providers
            const channels = [];
            const textLower = text.toLowerCase();
            for (const channel of TV_CHANNELS) {
              if (textLower.includes(channel.toLowerCase())) {
                channels.push(channel);
              }
            }
            
            // Also look for channel-specific elements
            const channelEls = el.querySelectorAll('.channel, .broadcaster, .tv, .stream, [class*="channel"], [class*="broadcaster"], [class*="stream"]');
            channelEls.forEach(chEl => {
              const chText = chEl.innerText.trim();
              if (chText && !channels.includes(chText)) {
                channels.push(chText);
              }
            });
            
            results.push({
              home: homeTeam,
              away: awayTeam,
              kickoffUtc,
              competition,
              channels: [...new Set(channels)]
            });
          } catch (e) {
            // Skip malformed fixtures
          }
        });
        
        if (results.length > 0) break;
      }
      
      return results;
    }, TV_CHANNELS);
    
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
    
    await page.goto(TV_GUIDE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT
    });
    
    const title = await page.title();
    
    // Check for expected heading "Live Football TV Guide"
    const hasExpectedContent = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('live football tv guide') || 
             text.includes('tv guide') || 
             text.includes('football on tv');
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

// ---------- Module Exports ----------

module.exports = {
  fetchOddAlertsFixtures,
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
    console.log('Running OddAlerts TV Guide VPS Scraper health check...');
    const result = await healthCheck();
    console.log('Result:', result);
    
    if (result.ok) {
      console.log('\nFetching fixtures...');
      const fixtures = await fetchOddAlertsFixtures();
      console.log('Fixtures:', JSON.stringify(fixtures, null, 2));
    }
    
    process.exit(result.ok ? 0 : 1);
  })();
}
