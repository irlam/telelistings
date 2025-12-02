// scrapers/tnt.js
// TNT Sports fixtures scraper with Puppeteer support for VPS.
// This version uses Puppeteer for more reliable scraping of JavaScript-rendered content.
/**
 * VPS TNT Sports Scraper
 *
 * Uses Puppeteer for browser automation to handle JavaScript-rendered content.
 * Can be run as a standalone service or integrated into the main VPS server.
 *
 * Exports fetchTNTFixtures({ teamName }) which:
 * - Uses Puppeteer to load TNT Sports pages
 * - Handles JavaScript-rendered content
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

const BASE_URL = 'https://www.tntsports.co.uk';
const SCHEDULE_URL = `${BASE_URL}/football/calendar-results.shtml`;
const DEFAULT_TIMEOUT = 30000;

// Known TNT Sports channel names
const TNT_CHANNELS = [
  'TNT Sports 1',
  'TNT Sports 2',
  'TNT Sports 3',
  'TNT Sports 4',
  'TNT Sports Ultimate',
  'TNT Sports',
  'discovery+'
];

// Shared browser instance
let browser = null;

// ---------- Logging ----------

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [TNT-VPS] ${msg}`);
}

// ---------- Browser Management ----------

async function getBrowser() {
  if (browser && browser.process && browser.process() && !browser.isClosed) {
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

function extractChannels(text) {
  if (!text) return [];
  
  const channels = [];
  const textLower = text.toLowerCase();
  
  for (const channel of TNT_CHANNELS) {
    if (textLower.includes(channel.toLowerCase())) {
      channels.push(channel);
    }
  }
  
  // Also look for patterns like "TNT Sports 1"
  const tntMatch = text.match(/TNT Sports\s*(\d+|Ultimate)?/gi);
  if (tntMatch) {
    for (const match of tntMatch) {
      const cleaned = match.trim();
      if (!channels.includes(cleaned)) {
        channels.push(cleaned);
      }
    }
  }
  
  // Check for BT Sport (legacy name)
  if (textLower.includes('bt sport')) {
    const btMatch = text.match(/BT Sport\s*(\d+)?/gi);
    if (btMatch) {
      for (const match of btMatch) {
        const converted = match.replace(/BT Sport/i, 'TNT Sports');
        if (!channels.includes(converted)) {
          channels.push(converted);
        }
      }
    }
  }
  
  return channels;
}

function normalizeTeamName(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/\b(fc|afc)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Main Function ----------

async function fetchTNTFixtures({ teamName, competition }) {
  const emptyResult = { fixtures: [] };
  
  log(`Fetching fixtures${teamName ? ` for ${teamName}` : ''}`);
  
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.goto(SCHEDULE_URL, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });
    
    // Wait for content to load
    await page.waitForSelector('body', { timeout: 10000 });
    
    // Extract fixtures using page.evaluate
    const fixtures = await page.evaluate((teamNameFilter, TNT_CHANNELS) => {
      const results = [];
      
      // Try multiple selectors for fixtures
      const fixtureSelectors = [
        '.schedule-item',
        '.event-item',
        '[class*="fixture"]',
        '[class*="match"]',
        '.programme-item',
        '[class*="Result"]',
        '[class*="Event"]',
        '[class*="Calendar"]'
      ];
      
      for (const selector of fixtureSelectors) {
        const elements = document.querySelectorAll(selector);
        
        elements.forEach(el => {
          try {
            const text = el.innerText || el.textContent || '';
            const textLower = text.toLowerCase();
            
            // Skip non-football content
            if (!textLower.includes('football') && 
                !textLower.includes('premier league') && 
                !textLower.includes('champions league') &&
                !textLower.includes('europa league') &&
                !textLower.includes('fa cup') &&
                !textLower.includes('efl') &&
                !textLower.includes('uefa') &&
                !textLower.includes('league')) {
              if (!textLower.match(/\b(v|vs)\b/)) {
                return;
              }
            }
            
            // Extract teams
            let homeTeam = '';
            let awayTeam = '';
            
            // Try specific selectors
            const homeEl = el.querySelector('[class*="home"], .team-home');
            const awayEl = el.querySelector('[class*="away"], .team-away');
            
            if (homeEl) homeTeam = homeEl.innerText.trim();
            if (awayEl) awayTeam = awayEl.innerText.trim();
            
            // Try team name links
            if (!homeTeam || !awayTeam) {
              const teamLinks = el.querySelectorAll('a[href*="team"], .team-name, [class*="TeamName"]');
              if (teamLinks.length >= 2) {
                homeTeam = teamLinks[0].innerText.trim();
                awayTeam = teamLinks[1].innerText.trim();
              }
            }
            
            // Fallback: parse from text
            if (!homeTeam || !awayTeam) {
              const vsMatch = text.match(/([A-Za-z\s]+)\s+(?:v|vs)\s+([A-Za-z\s]+)/i);
              if (vsMatch) {
                homeTeam = vsMatch[1].trim();
                awayTeam = vsMatch[2].trim();
              }
            }
            
            if (!homeTeam || !awayTeam) return;
            
            // Filter by team if specified
            if (teamNameFilter) {
              const teamNormalized = teamNameFilter.toLowerCase().replace(/\b(fc|afc)\b/gi, '').trim();
              const homeNormalized = homeTeam.toLowerCase().replace(/\b(fc|afc)\b/gi, '').trim();
              const awayNormalized = awayTeam.toLowerCase().replace(/\b(fc|afc)\b/gi, '').trim();
              
              if (!homeNormalized.includes(teamNormalized) && 
                  !awayNormalized.includes(teamNormalized) &&
                  !teamNormalized.includes(homeNormalized) &&
                  !teamNormalized.includes(awayNormalized)) {
                return;
              }
            }
            
            // Extract kickoff time
            let kickoffUtc = null;
            const timeEl = el.querySelector('time, [datetime]');
            if (timeEl) {
              kickoffUtc = timeEl.getAttribute('datetime') || null;
            }
            
            // Extract competition
            let comp = null;
            const compEl = el.querySelector('[class*="competition"], [class*="tournament"]');
            if (compEl) {
              comp = compEl.innerText.trim();
            }
            
            // Extract TV channels
            const channels = [];
            for (const channel of TNT_CHANNELS) {
              if (textLower.includes(channel.toLowerCase())) {
                channels.push(channel);
              }
            }
            
            // Default to TNT Sports if no specific channel found
            if (channels.length === 0) {
              channels.push('TNT Sports');
            }
            
            results.push({
              home: homeTeam,
              away: awayTeam,
              kickoffUtc,
              competition: comp,
              channels: [...new Set(channels)]
            });
          } catch (e) {
            // Skip malformed fixtures
          }
        });
        
        if (results.length > 0) break;
      }
      
      return results;
    }, teamName, TNT_CHANNELS);
    
    await page.close();
    
    log(`Found ${fixtures.length} fixtures`);
    return { fixtures };
    
  } catch (err) {
    log(`Error fetching fixtures: ${err.message}`);
    return emptyResult;
  }
}

async function healthCheck() {
  const startTime = Date.now();
  
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
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

// ---------- Module Exports ----------

module.exports = {
  fetchTNTFixtures,
  healthCheck,
  extractChannels,
  normalizeTeamName,
  TNT_CHANNELS,
  BASE_URL
};

// Allow running as standalone
if (require.main === module) {
  (async () => {
    console.log('Running TNT Sports VPS Scraper health check...');
    const result = await healthCheck();
    console.log('Result:', result);
    process.exit(result.ok ? 0 : 1);
  })();
}
