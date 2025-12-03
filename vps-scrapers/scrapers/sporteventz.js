// scrapers/sporteventz.js
// SportEventz scraper with Puppeteer support for VPS.
// This version uses Puppeteer for reliable scraping of JavaScript-rendered content.
/**
 * VPS SportEventz Scraper
 *
 * Uses Puppeteer for browser automation to handle JavaScript-rendered content.
 * Can be run as a standalone service or integrated into the main VPS server.
 *
 * Exports fetchSportEventzFixtures({ date }) which:
 * - Uses Puppeteer to load SportEventz pages
 * - Handles cookie acceptance
 * - Handles infinite scrolling to load more matches
 * - Extracts teams, date/time, broadcasters and satellite info
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

const BASE_URL = 'https://www.sporteventz.com';
const SOCCER_URL = `${BASE_URL}/soccer`;
const DEFAULT_TIMEOUT = 30000;
const SCROLL_PAUSE_TIME = 1500;
const MAX_SCROLL_ATTEMPTS = 10;

// Known TV channels for football
const TV_CHANNELS = [
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
  'Peacock',
  'fuboTV',
  'CBS Sports',
  'Eurosport',
  'Viaplay',
  'SuperSport'
];

// Shared browser instance
let browser = null;

// ---------- Logging ----------

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [SPORTEVENTZ-VPS] ${msg}`);
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

async function fetchSportEventzFixtures({ date } = {}) {
  const emptyResult = { fixtures: [] };
  
  log(`Fetching fixtures${date ? ` for ${date}` : ' for today'}`);
  
  let page = null;
  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.goto(SOCCER_URL, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });
    
    // Wait for content to load
    await page.waitForSelector('body', { timeout: 10000 });
    
    // Accept cookies if dialog appears
    try {
      const cookieButton = await page.$('button[id*="accept"], button[class*="accept"], [class*="cookie"] button, .consent-button, #accept-cookies');
      if (cookieButton) {
        await cookieButton.click();
        await new Promise(resolve => setTimeout(resolve, 1000));
        log('Accepted cookies');
      }
    } catch (e) {
      // No cookie dialog or already accepted
    }
    
    // Handle infinite scrolling - scroll until no new matches appear
    let previousHeight = 0;
    let scrollAttempts = 0;
    
    while (scrollAttempts < MAX_SCROLL_ATTEMPTS) {
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);
      
      if (currentHeight === previousHeight) {
        break;
      }
      
      previousHeight = currentHeight;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise(resolve => setTimeout(resolve, SCROLL_PAUSE_TIME));
      scrollAttempts++;
    }
    
    log(`Scrolled ${scrollAttempts} times`);
    
    // Extract fixtures using page.evaluate
    const fixtures = await page.evaluate((TV_CHANNELS) => {
      const results = [];
      
      // Try multiple selectors for match entries on SportEventz
      const fixtureSelectors = [
        '.event',
        '.match',
        '.fixture',
        '.game',
        '[class*="event"]',
        '[class*="match"]',
        '[class*="fixture"]',
        'table tbody tr',
        '.schedule-item',
        '.listing-item'
      ];
      
      for (const selector of fixtureSelectors) {
        const elements = document.querySelectorAll(selector);
        
        elements.forEach(el => {
          try {
            const text = el.innerText || el.textContent || '';
            
            // Skip non-soccer content
            const textLower = text.toLowerCase();
            if (textLower.includes('tennis') || 
                textLower.includes('basketball') || 
                textLower.includes('cricket') ||
                textLower.includes('rugby') ||
                textLower.includes('golf')) {
              return;
            }
            
            // Extract teams
            let homeTeam = '';
            let awayTeam = '';
            
            // Try specific selectors
            const homeEl = el.querySelector('.home-team, .home, [class*="home"]');
            const awayEl = el.querySelector('.away-team, .away, [class*="away"]');
            
            if (homeEl) homeTeam = homeEl.innerText.trim();
            if (awayEl) awayTeam = awayEl.innerText.trim();
            
            // Try team elements
            const teamEls = el.querySelectorAll('.team, .team-name, [class*="team"]');
            if (teamEls.length >= 2 && (!homeTeam || !awayTeam)) {
              homeTeam = teamEls[0].innerText.trim();
              awayTeam = teamEls[1].innerText.trim();
            }
            
            // Fallback: parse from text for "vs" or "v" patterns
            if (!homeTeam || !awayTeam) {
              const vsMatch = text.match(/([A-Za-z\s\-'\.0-9]+)\s+(?:v|vs|versus|–|-)\s+([A-Za-z\s\-'\.0-9]+)/i);
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
            const timeEl = el.querySelector('time, [datetime], .time, .date, .kickoff');
            if (timeEl) {
              kickoffUtc = timeEl.getAttribute('datetime') || timeEl.innerText.trim() || null;
            }
            
            // Try to find date/time pattern in text
            if (!kickoffUtc) {
              const dateMatch = text.match(/(\d{1,2}[\/\-\.]\d{1,2}(?:[\/\-\.]\d{2,4})?)/);
              const timeMatch = text.match(/(\d{1,2}[:\.]?\d{2}\s*(am|pm|GMT|BST|CET|UTC)?)/i);
              if (dateMatch || timeMatch) {
                kickoffUtc = [dateMatch?.[1], timeMatch?.[1]].filter(Boolean).join(' ');
              }
            }
            
            // Extract competition
            let competition = null;
            const compEl = el.querySelector('.competition, .league, .tournament, [class*="competition"], [class*="league"]');
            if (compEl) {
              competition = compEl.innerText.trim();
            }
            
            // Extract TV channels and broadcasters
            const channels = [];
            for (const channel of TV_CHANNELS) {
              if (textLower.includes(channel.toLowerCase())) {
                channels.push(channel);
              }
            }
            
            // Look for broadcaster/channel elements
            const channelEls = el.querySelectorAll('.channel, .broadcaster, .tv, .stream, [class*="channel"], [class*="broadcaster"], [class*="tv"]');
            channelEls.forEach(chEl => {
              const chText = chEl.innerText.trim();
              if (chText && !channels.includes(chText)) {
                // Parse channels separated by comma, etc.
                const chParts = chText.split(/[,;\/\n]/).map(c => c.trim()).filter(c => c);
                chParts.forEach(ch => {
                  if (!channels.includes(ch) && ch.length > 1) {
                    channels.push(ch);
                  }
                });
              }
            });
            
            // Look for satellite info
            const satEl = el.querySelector('.satellite, [class*="satellite"], [class*="sat"]');
            if (satEl) {
              const satText = satEl.innerText.trim();
              if (satText && !channels.includes(satText)) {
                channels.push(`Satellite: ${satText}`);
              }
            }
            
            results.push({
              home: homeTeam,
              away: awayTeam,
              kickoffUtc,
              competition,
              channels: [...new Set(channels.map(c => c.trim()).filter(c => c))]
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
    
    await page.goto(SOCCER_URL, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT
    });
    
    const title = await page.title();
    
    // Accept cookies if needed
    try {
      const cookieButton = await page.$('button[id*="accept"], button[class*="accept"], [class*="cookie"] button');
      if (cookieButton) {
        await cookieButton.click();
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (e) {
      // No cookie dialog
    }
    
    // Check for at least one match entry
    const hasMatchEntry = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      // Look for indicators of match content
      return text.includes('soccer') || 
             text.includes('football') ||
             text.includes('match') ||
             text.includes('vs') ||
             document.querySelectorAll('[class*="event"], [class*="match"], [class*="fixture"]').length > 0;
    });
    
    await page.close();
    page = null;
    
    const latencyMs = Date.now() - startTime;
    log(`[health] ${hasMatchEntry ? 'OK' : 'WARN'} in ${latencyMs}ms`);
    return { ok: hasMatchEntry, latencyMs, title };
    
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
  fetchSportEventzFixtures,
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
    console.log('Running SportEventz VPS Scraper health check...');
    const result = await healthCheck();
    console.log('Result:', result);
    
    if (result.ok) {
      console.log('\nFetching fixtures...');
      const fixtures = await fetchSportEventzFixtures();
      console.log('Fixtures:', JSON.stringify(fixtures, null, 2));
    }
    
    process.exit(result.ok ? 0 : 1);
  })();
}
