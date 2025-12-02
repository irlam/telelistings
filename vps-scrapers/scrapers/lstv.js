// scrapers/lstv.js
// Enhanced LiveSoccerTV scraper with Puppeteer support for VPS.
// This version performs actual scraping of TV listings from LiveSoccerTV.
/**
 * VPS LiveSoccerTV Scraper
 *
 * Uses Puppeteer for browser automation to handle JavaScript-rendered content.
 * Can be run as a standalone service or integrated into the main VPS server.
 *
 * Exports scrapeLSTV({ home, away, dateUtc, leagueHint }) which:
 * - Uses Puppeteer to load LiveSoccerTV pages
 * - Searches for the specific fixture
 * - Scrapes TV listings table
 *
 * Returns:
 * {
 *   url: string,
 *   kickoffUtc: string | null,
 *   league: string | null,
 *   regionChannels: Array<{ region: string, channel: string }>,
 *   matchScore: number | null,
 *   meta: { title: string, latencyMs: number }
 * }
 */

const puppeteer = require('puppeteer');

// ---------- Configuration ----------

const BASE_URL = 'https://www.livesoccertv.com';
const DEFAULT_TIMEOUT = 30000;

// Shared browser instance
let browser = null;

// ---------- Logging ----------

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [LSTV-VPS] ${msg}`);
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

/**
 * Normalize a team name for comparison.
 */
function normalizeTeamName(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/\b(fc|afc|cf|sc|ac|as|ss|rc|rfc)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Create URL-safe slug from team name.
 */
function createSlug(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Calculate similarity score between two team names.
 */
function teamNameSimilarity(name1, name2) {
  const norm1 = normalizeTeamName(name1);
  const norm2 = normalizeTeamName(name2);
  
  if (!norm1 || !norm2) return 0;
  
  // Exact match
  if (norm1 === norm2) return 100;
  
  // One contains the other
  if (norm1.includes(norm2) || norm2.includes(norm1)) {
    const longer = Math.max(norm1.length, norm2.length);
    const shorter = Math.min(norm1.length, norm2.length);
    return Math.round((shorter / longer) * 90);
  }
  
  // Word-level matching
  const words1 = norm1.split(' ').filter(w => w.length > 2);
  const words2 = norm2.split(' ').filter(w => w.length > 2);
  
  if (words1.length === 0 || words2.length === 0) return 0;
  
  let matchingWords = 0;
  for (const w1 of words1) {
    for (const w2 of words2) {
      if (w1 === w2 || w1.includes(w2) || w2.includes(w1)) {
        matchingWords++;
        break;
      }
    }
  }
  
  const totalWords = Math.max(words1.length, words2.length);
  return Math.round((matchingWords / totalWords) * 80);
}

// ---------- Main Scraper Function ----------

/**
 * Scrape LiveSoccerTV for fixture TV listings.
 */
async function scrapeLSTV({ home, away, dateUtc, leagueHint }) {
  const started = Date.now();
  let matchUrl = BASE_URL;
  
  log(`Scraping for ${home} vs ${away}`);
  
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // First, try to find the match on the homepage/schedule
    await page.goto(BASE_URL, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });
    
    // Try to find a match link for this fixture
    const homeSlug = createSlug(home);
    const awaySlug = createSlug(away);
    
    // Try direct match URL patterns
    const urlPatterns = [
      `${BASE_URL}/match/${homeSlug}-vs-${awaySlug}/`,
      `${BASE_URL}/match/${homeSlug}-v-${awaySlug}/`,
      `${BASE_URL}/match/${awaySlug}-vs-${homeSlug}/`,
      `${BASE_URL}/match/${awaySlug}-v-${homeSlug}/`
    ];
    
    let foundMatchPage = false;
    let regionChannels = [];
    let title = await page.title();
    let matchScore = null;
    let league = leagueHint || null;
    
    // Try each URL pattern
    for (const patternUrl of urlPatterns) {
      try {
        const response = await page.goto(patternUrl, {
          waitUntil: 'networkidle2',
          timeout: DEFAULT_TIMEOUT
        });
        
        if (response && response.ok()) {
          title = await page.title();
          matchUrl = patternUrl;
          
          // Check if this looks like a match page
          const hasMatchContent = await page.evaluate(() => {
            return document.body.innerText.toLowerCase().includes('tv channels') ||
                   document.body.innerText.toLowerCase().includes('tv listings') ||
                   document.querySelector('table');
          });
          
          if (hasMatchContent) {
            foundMatchPage = true;
            break;
          }
        }
      } catch (err) {
        // URL didn't work, try next pattern
        continue;
      }
    }
    
    // If found a match page, try to scrape the TV listings
    if (foundMatchPage) {
      regionChannels = await page.evaluate(() => {
        const channels = [];
        
        // Try to find TV listings table
        const tables = document.querySelectorAll('table');
        
        for (const table of tables) {
          const rows = table.querySelectorAll('tr');
          
          for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
              const region = cells[0].innerText.trim();
              const channel = cells[1].innerText.trim();
              
              // Skip header-like rows
              if (region && channel && 
                  !region.toLowerCase().includes('country') &&
                  !region.toLowerCase().includes('region')) {
                channels.push({ region, channel });
              }
            }
          }
        }
        
        // Also try alternative selectors
        if (channels.length === 0) {
          const listItems = document.querySelectorAll('[class*="tv"], [class*="channel"], [class*="broadcast"]');
          listItems.forEach(item => {
            const text = item.innerText.trim();
            if (text) {
              channels.push({ region: 'Unknown', channel: text });
            }
          });
        }
        
        return channels;
      });
      
      // Calculate match score based on URL match
      matchScore = 80;
    } else {
      // Try to find the match by searching the homepage
      const matchLinks = await page.evaluate((homeSearch, awaySearch) => {
        const links = Array.from(document.querySelectorAll('a[href*="/match/"]'));
        const normalizeText = (t) => t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
        
        const homeNorm = normalizeText(homeSearch);
        const awayNorm = normalizeText(awaySearch);
        
        return links
          .filter(link => {
            const text = normalizeText(link.innerText);
            return text.includes(homeNorm) || text.includes(awayNorm);
          })
          .map(link => ({
            href: link.href,
            text: link.innerText.trim()
          }))
          .slice(0, 5);
      }, home, away);
      
      // Try the first matching link
      if (matchLinks.length > 0) {
        try {
          await page.goto(matchLinks[0].href, {
            waitUntil: 'networkidle2',
            timeout: DEFAULT_TIMEOUT
          });
          
          matchUrl = matchLinks[0].href;
          title = await page.title();
          
          regionChannels = await page.evaluate(() => {
            const channels = [];
            const tables = document.querySelectorAll('table');
            
            for (const table of tables) {
              const rows = table.querySelectorAll('tr');
              
              for (const row of rows) {
                const cells = row.querySelectorAll('td');
                if (cells.length >= 2) {
                  const region = cells[0].innerText.trim();
                  const channel = cells[1].innerText.trim();
                  
                  if (region && channel && 
                      !region.toLowerCase().includes('country') &&
                      !region.toLowerCase().includes('region')) {
                    channels.push({ region, channel });
                  }
                }
              }
            }
            
            return channels;
          });
          
          // Calculate match score based on text similarity
          const homeSim = teamNameSimilarity(matchLinks[0].text, home);
          const awaySim = teamNameSimilarity(matchLinks[0].text, away);
          matchScore = Math.round((homeSim + awaySim) / 2);
        } catch (err) {
          log(`Error following match link: ${err.message}`);
        }
      }
    }
    
    await page.close();
    
    const latency = Date.now() - started;
    
    log(`Found ${regionChannels.length} channels in ${latency}ms`);
    
    return {
      url: matchUrl,
      kickoffUtc: dateUtc || null,
      league,
      regionChannels,
      matchScore,
      meta: {
        title,
        latencyMs: latency
      }
    };
    
  } catch (err) {
    const latency = Date.now() - started;
    log(`Error: ${err.message}`);
    
    return {
      url: matchUrl,
      kickoffUtc: dateUtc || null,
      league: leagueHint || null,
      regionChannels: [],
      matchScore: null,
      meta: {
        title: 'Error',
        latencyMs: latency,
        error: err.message
      }
    };
  }
}

/**
 * Fetch all fixtures for a given region and date.
 */
async function scrapeLSTVFixtures({ region = 'UK', dateUtc } = {}) {
  const started = Date.now();
  
  log(`Scraping fixtures for region: ${region}`);
  
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.goto(BASE_URL, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });
    
    // Extract fixtures from homepage
    const fixtures = await page.evaluate(() => {
      const results = [];
      
      // Find match links
      const matchLinks = document.querySelectorAll('a[href*="/match/"]');
      
      matchLinks.forEach(link => {
        try {
          const text = link.innerText.trim();
          
          // Try to parse team names
          const vsMatch = text.match(/([A-Za-z\s\-]+)\s+(?:v|vs|–)\s+([A-Za-z\s\-]+)/i);
          if (vsMatch) {
            const home = vsMatch[1].trim();
            const away = vsMatch[2].trim();
            
            // Find sibling elements with time/league info
            const parent = link.closest('tr, li, div, article');
            let kickoffUtc = null;
            let league = null;
            
            if (parent) {
              const timeEl = parent.querySelector('time, [datetime]');
              if (timeEl) {
                kickoffUtc = timeEl.getAttribute('datetime') || timeEl.innerText.trim();
              }
              
              const leagueEl = parent.querySelector('[class*="competition"], [class*="league"]');
              if (leagueEl) {
                league = leagueEl.innerText.trim();
              }
            }
            
            results.push({
              home,
              away,
              kickoffUtc,
              league,
              url: link.href,
              regionChannels: [] // Would need to visit each page to get channels
            });
          }
        } catch (e) {
          // Skip malformed entries
        }
      });
      
      return results;
    });
    
    await page.close();
    
    const latency = Date.now() - started;
    log(`Found ${fixtures.length} fixtures in ${latency}ms`);
    
    return {
      fixtures,
      meta: {
        latencyMs: latency
      }
    };
    
  } catch (err) {
    const latency = Date.now() - started;
    log(`Error: ${err.message}`);
    
    return {
      fixtures: [],
      meta: {
        latencyMs: latency,
        error: err.message
      }
    };
  }
}

/**
 * Health check.
 */
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
  scrapeLSTV,
  scrapeLSTVFixtures,
  healthCheck,
  normalizeTeamName,
  teamNameSimilarity,
  createSlug,
  BASE_URL
};

// Allow running as standalone
if (require.main === module) {
  (async () => {
    console.log('Running LiveSoccerTV VPS Scraper health check...');
    const result = await healthCheck();
    console.log('Result:', result);
    
    if (result.ok) {
      console.log('\nTesting sample scrape...');
      const scrapeResult = await scrapeLSTV({
        home: 'Arsenal',
        away: 'Chelsea',
        dateUtc: new Date().toISOString()
      });
      console.log('Scrape result:', JSON.stringify(scrapeResult, null, 2));
    }
    
    process.exit(result.ok ? 0 : 1);
  })();
}
