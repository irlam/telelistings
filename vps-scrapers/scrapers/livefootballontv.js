// scrapers/livefootballontv.js
// LiveFootballOnTV scraper with Puppeteer support for VPS.
// This version uses Puppeteer for more reliable scraping of JavaScript-rendered content.
/**
 * VPS LiveFootballOnTV Scraper
 *
 * Uses Puppeteer for browser automation to handle JavaScript-rendered content.
 * Can be run as a standalone service or integrated into the main VPS server.
 *
 * Exports fetchLFOTVFixtures({ teamName }) which:
 * - Uses Puppeteer to load LiveFootballOnTV pages
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

const BASE_URL = 'https://www.live-footballontv.com';
const DEFAULT_TIMEOUT = 30000;

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

// Shared browser instance
let browser = null;

// ---------- Logging ----------

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [LFOTV-VPS] ${msg}`);
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
  
  for (const channel of UK_CHANNELS) {
    if (textLower.includes(channel.toLowerCase())) {
      channels.push(channel);
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

async function fetchLFOTVFixtures({ teamName, competition }) {
  const emptyResult = { fixtures: [] };
  
  log(`Fetching fixtures${teamName ? ` for ${teamName}` : ''}`);
  
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.goto(BASE_URL, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });
    
    // Wait for content to load
    await page.waitForSelector('body', { timeout: 10000 });
    
    // Extract fixtures using page.evaluate
    const fixtures = await page.evaluate((teamNameFilter, UK_CHANNELS) => {
      const results = [];
      
      // Try multiple selectors for fixtures
      const rowSelectors = [
        'table tr',
        '.fixture-row',
        '.match-row',
        '[class*="fixture"]',
        '[class*="match"]'
      ];
      
      for (const selector of rowSelectors) {
        const elements = document.querySelectorAll(selector);
        
        elements.forEach(el => {
          try {
            const text = el.innerText || el.textContent || '';
            
            // Skip header rows
            if (el.querySelector('th')) return;
            
            // Look for match pattern
            const vsMatch = text.match(/([A-Za-z\s\-'\.]+)\s+(?:v|vs|versus)\s+([A-Za-z\s\-'\.]+)/i);
            if (!vsMatch) return;
            
            let homeTeam = vsMatch[1].trim();
            let awayTeam = vsMatch[2].trim();
            
            // Clean up team names
            const cleanTeamText = (t) => t
              .replace(/\d{1,2}[:\.]?\d{0,2}\s*(am|pm)?/gi, '')
              .replace(/Sky Sports|TNT Sports|BBC|ITV|Amazon/gi, '')
              .trim();
            
            homeTeam = cleanTeamText(homeTeam);
            awayTeam = cleanTeamText(awayTeam);
            
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
            const compEl = el.querySelector('[class*="competition"], [class*="league"]');
            if (compEl) {
              comp = compEl.innerText.trim();
            }
            
            // Extract TV channels
            const channels = [];
            const textLower = text.toLowerCase();
            for (const channel of UK_CHANNELS) {
              if (textLower.includes(channel.toLowerCase())) {
                channels.push(channel);
              }
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
    }, teamName, UK_CHANNELS);
    
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
  fetchLFOTVFixtures,
  healthCheck,
  extractChannels,
  normalizeTeamName,
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
