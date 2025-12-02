// scrapers/bbc.js
// BBC Sport fixtures scraper with Puppeteer support for VPS.
// This version uses Puppeteer for more reliable scraping of JavaScript-rendered content.
/**
 * VPS BBC Sport Scraper
 *
 * Uses Puppeteer for browser automation to handle JavaScript-rendered content.
 * Can be run as a standalone service or integrated into the main VPS server.
 *
 * Exports fetchBBCFixtures({ teamName, teamSlug }) which:
 * - Uses Puppeteer to load BBC Sport pages
 * - Handles JavaScript-rendered content
 * - Parses fixture list
 *
 * Returns:
 * {
 *   matches: Array<{
 *     home: string,
 *     away: string,
 *     kickoffUtc: string | null,
 *     competition: string | null
 *   }>
 * }
 */

const puppeteer = require('puppeteer');

// ---------- Configuration ----------

const BASE_URL = 'https://www.bbc.co.uk/sport/football/teams';
const DEFAULT_TIMEOUT = 30000;

// Team name to BBC slug mapping
const TEAM_SLUGS = {
  'arsenal': 'arsenal',
  'aston villa': 'aston-villa',
  'bournemouth': 'bournemouth',
  'brentford': 'brentford',
  'brighton': 'brighton-and-hove-albion',
  'burnley': 'burnley',
  'chelsea': 'chelsea',
  'crystal palace': 'crystal-palace',
  'everton': 'everton',
  'fulham': 'fulham',
  'ipswich': 'ipswich-town',
  'leicester': 'leicester-city',
  'liverpool': 'liverpool',
  'man city': 'manchester-city',
  'manchester city': 'manchester-city',
  'man utd': 'manchester-united',
  'manchester united': 'manchester-united',
  'newcastle': 'newcastle-united',
  'nottingham forest': 'nottingham-forest',
  'southampton': 'southampton',
  'tottenham': 'tottenham-hotspur',
  'west ham': 'west-ham-united',
  'wolves': 'wolverhampton-wanderers',
  'wolverhampton': 'wolverhampton-wanderers',
  // Championship
  'blackburn': 'blackburn-rovers',
  'bristol city': 'bristol-city',
  'cardiff': 'cardiff-city',
  'coventry': 'coventry-city',
  'derby': 'derby-county',
  'hull': 'hull-city',
  'leeds': 'leeds-united',
  'luton': 'luton-town',
  'middlesbrough': 'middlesbrough',
  'millwall': 'millwall',
  'norwich': 'norwich-city',
  'plymouth': 'plymouth-argyle',
  'portsmouth': 'portsmouth',
  'preston': 'preston-north-end',
  'qpr': 'queens-park-rangers',
  'sheffield utd': 'sheffield-united',
  'sheffield united': 'sheffield-united',
  'stoke': 'stoke-city',
  'sunderland': 'sunderland',
  'swansea': 'swansea-city',
  'watford': 'watford',
  'west brom': 'west-bromwich-albion',
  // Scottish
  'celtic': 'celtic',
  'rangers': 'rangers',
  'aberdeen': 'aberdeen',
  'hearts': 'heart-of-midlothian',
  'hibernian': 'hibernian'
};

// Shared browser instance
let browser = null;

// ---------- Logging ----------

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [BBC-VPS] ${msg}`);
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

function getTeamSlug(teamName) {
  if (!teamName) return null;
  
  const normalized = teamName.toLowerCase().trim();
  
  // Direct lookup
  if (TEAM_SLUGS[normalized]) {
    return TEAM_SLUGS[normalized];
  }
  
  // Partial match
  for (const [key, slug] of Object.entries(TEAM_SLUGS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return slug;
    }
  }
  
  // Fallback: convert to slug format
  return normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------- Main Function ----------

async function fetchBBCFixtures({ teamName, teamSlug } = {}) {
  const emptyResult = { matches: [] };
  
  // Build URL
  let url;
  if (teamSlug || teamName) {
    const slug = teamSlug || getTeamSlug(teamName);
    if (!slug) {
      log(`Could not determine BBC slug for: ${teamName}`);
      return emptyResult;
    }
    url = `${BASE_URL}/${slug}/scores-fixtures`;
  } else {
    url = 'https://www.bbc.co.uk/sport/football/scores-fixtures';
  }
  
  log(`Fetching fixtures from: ${url}`);
  
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });
    
    // Wait for content to load
    await page.waitForSelector('body', { timeout: 10000 });
    
    // Extract fixtures using page.evaluate
    const matches = await page.evaluate(() => {
      const results = [];
      
      // Try multiple selectors for fixtures
      const fixtureSelectors = [
        '.sp-c-fixture',
        '[class*="fixture"]',
        '.qa-match-block',
        'article[class*="fixture"]',
        '[data-event-type="match"]',
        '[class*="MatchWrapper"]',
        '[class*="EventCard"]',
        '.fixture-item'
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
            const homeEl = el.querySelector('[class*="home-team"], .sp-c-fixture__team--home, .sp-c-fixture__team-name--home');
            const awayEl = el.querySelector('[class*="away-team"], .sp-c-fixture__team--away, .sp-c-fixture__team-name--away');
            
            if (homeEl) homeTeam = homeEl.innerText.trim();
            if (awayEl) awayTeam = awayEl.innerText.trim();
            
            // Try team name spans with abbr
            if (!homeTeam || !awayTeam) {
              const teamNames = el.querySelectorAll('[class*="TeamName"], [class*="teamName"], abbr[title]');
              if (teamNames.length >= 2) {
                homeTeam = teamNames[0].getAttribute('title') || teamNames[0].innerText.trim();
                awayTeam = teamNames[1].getAttribute('title') || teamNames[1].innerText.trim();
              }
            }
            
            // Fallback: parse from text
            if (!homeTeam || !awayTeam) {
              const vsMatch = text.match(/([A-Za-z\s]+)\s+(?:v|vs|versus)\s+([A-Za-z\s]+)/i);
              if (vsMatch) {
                homeTeam = vsMatch[1].trim();
                awayTeam = vsMatch[2].trim();
              }
            }
            
            if (!homeTeam || !awayTeam) return;
            
            // Extract kickoff time
            let kickoffUtc = null;
            const timeEl = el.querySelector('time, [datetime]');
            if (timeEl) {
              kickoffUtc = timeEl.getAttribute('datetime') || null;
            }
            
            // Extract competition
            let competition = null;
            const compEl = el.querySelector('[class*="competition"], [class*="tournament"]');
            if (compEl) {
              competition = compEl.innerText.trim();
            }
            
            results.push({
              home: homeTeam,
              away: awayTeam,
              kickoffUtc,
              competition
            });
          } catch (e) {
            // Skip malformed fixtures
          }
        });
        
        if (results.length > 0) break;
      }
      
      return results;
    });
    
    await page.close();
    
    log(`Found ${matches.length} fixtures`);
    return { matches };
    
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
    
    await page.goto(`${BASE_URL}/arsenal`, {
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
  fetchBBCFixtures,
  healthCheck,
  getTeamSlug,
  TEAM_SLUGS,
  BASE_URL
};

// Allow running as standalone
if (require.main === module) {
  (async () => {
    console.log('Running BBC Sport VPS Scraper health check...');
    const result = await healthCheck();
    console.log('Result:', result);
    process.exit(result.ok ? 0 : 1);
  })();
}
