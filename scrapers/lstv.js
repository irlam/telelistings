// scrapers/lstv.js
// LiveSoccerTV scraper using Puppeteer to fetch TV channels for each fixture.
/**
 * Telegram Sports TV Bot – LiveSoccerTV Puppeteer Scraper
 *
 * Exports fetchLSTV({ home, away, date }) which:
 * - Searches LiveSoccerTV for the correct match
 * - Opens the match page
 * - Extracts region/channel rows (e.g. Australia → Stan Sport)
 *
 * Returns:
 * {
 *   url: string | null,
 *   kickoffUtc: string | null,
 *   regionChannels: [{ region, channel }, ...]
 * }
 *
 * Never throws; on failure returns { regionChannels: [] }
 * All logs use prefix [LSTV]
 */

const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------

const BASE_URL = 'https://www.livesoccertv.com';
const DEFAULT_TIMEOUT = 30000;
const NAVIGATION_TIMEOUT = 60000;

// Chrome executable paths to try
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

// ---------- Logging ----------

/**
 * Log a message with [LSTV] prefix.
 * @param {string} msg - Message to log
 */
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [LSTV] ${msg}`;
  console.log(line);
  
  // Also append to autopost.log for visibility in /admin/logs
  try {
    const logPath = path.join(__dirname, '..', 'autopost.log');
    fs.appendFileSync(logPath, line + '\n', 'utf8');
  } catch (err) {
    // Ignore file errors
  }
}

// ---------- Chrome/Puppeteer Helpers ----------

/**
 * Find a Chrome/Chromium executable on the system.
 * @returns {string|null} Path to Chrome executable
 */
function findChromePath() {
  for (const chromePath of CHROME_PATHS) {
    if (chromePath && fs.existsSync(chromePath)) {
      return chromePath;
    }
  }
  return null;
}

/**
 * Lazy-load puppeteer-core.
 * @returns {Object|null} Puppeteer module or null if not available
 */
function loadPuppeteer() {
  try {
    return require('puppeteer-core');
  } catch (err) {
    log('puppeteer-core not available');
    return null;
  }
}

// ---------- URL Building ----------

/**
 * Normalize a team name for URL building.
 * @param {string} name - Team name
 * @returns {string} URL-safe slug
 */
function normalizeTeamName(name) {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Build possible search URLs for a match on LiveSoccerTV.
 * @param {string} home - Home team name
 * @param {string} away - Away team name
 * @returns {string[]} Array of possible URLs to try
 */
function buildSearchUrls(home, away) {
  const homeSlug = normalizeTeamName(home);
  const awaySlug = normalizeTeamName(away);
  
  // Country paths to try for team pages
  const countryPaths = ['england', 'spain', 'germany', 'italy', 'france', 'scotland', 'wales', 'netherlands', 'portugal'];
  
  const urls = [];
  
  // Direct match page URLs (various formats)
  urls.push(`${BASE_URL}/match/${homeSlug}-vs-${awaySlug}/`);
  urls.push(`${BASE_URL}/match/${homeSlug}-v-${awaySlug}/`);
  
  // Team schedule pages - check home team's upcoming fixtures
  for (const country of countryPaths) {
    urls.push(`${BASE_URL}/teams/${country}/${homeSlug}/`);
  }
  
  return urls;
}

// ---------- Main Scraper Function ----------

/**
 * Fetch TV channel information for a fixture from LiveSoccerTV using Puppeteer.
 *
 * @param {Object} params - Parameters
 * @param {string} params.home - Home team name
 * @param {string} params.away - Away team name
 * @param {Date|string} params.date - Match date
 * @returns {Promise<{url: string|null, kickoffUtc: string|null, regionChannels: Array<{region: string, channel: string}>}>}
 */
async function fetchLSTV({ home, away, date }) {
  // Default empty result - never throw
  const emptyResult = {
    url: null,
    kickoffUtc: null,
    regionChannels: []
  };
  
  // Validate inputs
  if (!home || !away) {
    log(`Missing team names: home="${home}", away="${away}"`);
    return emptyResult;
  }
  
  log(`Searching for ${home} vs ${away}`);
  
  // Load Puppeteer
  const puppeteer = loadPuppeteer();
  if (!puppeteer) {
    log('Puppeteer not available, cannot scrape');
    return emptyResult;
  }
  
  // Find Chrome
  const chromePath = findChromePath();
  if (!chromePath) {
    log('Chrome/Chromium not found on system');
    return emptyResult;
  }
  
  let browser = null;
  
  try {
    log(`Launching Chrome from ${chromePath}`);
    
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    
    const page = await browser.newPage();
    
    // Set viewport
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1
    });
    
    // Set user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    
    // Set navigation timeout
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    page.setDefaultTimeout(DEFAULT_TIMEOUT);
    
    // Build search URLs
    const searchUrls = buildSearchUrls(home, away);
    
    let matchPageUrl = null;
    let regionChannels = [];
    let kickoffUtc = null;
    
    // Try each URL to find the match
    for (const url of searchUrls) {
      try {
        log(`Trying URL: ${url}`);
        
        await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: NAVIGATION_TIMEOUT
        });
        
        // Wait a bit for dynamic content
        await page.waitForTimeout(2000);
        
        // Check if this is a match page or team schedule
        const isMatchPage = url.includes('/match/');
        
        if (isMatchPage) {
          // We're on a match page, try to extract TV channels
          const result = await extractTvChannelsFromPage(page);
          if (result.regionChannels.length > 0) {
            matchPageUrl = url;
            regionChannels = result.regionChannels;
            kickoffUtc = result.kickoffUtc;
            log(`Found ${regionChannels.length} TV channels on match page`);
            break;
          }
        } else {
          // Team schedule page - look for the specific match
          const matchLink = await findMatchOnSchedule(page, home, away, date);
          if (matchLink) {
            log(`Found match link: ${matchLink}`);
            
            // Navigate to the match page
            await page.goto(matchLink, {
              waitUntil: 'networkidle2',
              timeout: NAVIGATION_TIMEOUT
            });
            
            await page.waitForTimeout(2000);
            
            const result = await extractTvChannelsFromPage(page);
            if (result.regionChannels.length > 0) {
              matchPageUrl = matchLink;
              regionChannels = result.regionChannels;
              kickoffUtc = result.kickoffUtc;
              log(`Found ${regionChannels.length} TV channels from schedule`);
              break;
            }
          }
        }
      } catch (urlErr) {
        log(`Error with URL ${url}: ${urlErr.message}`);
        continue;
      }
    }
    
    // If no match found via URLs, try search
    if (regionChannels.length === 0) {
      log('Trying site search...');
      const searchResult = await searchOnSite(page, home, away);
      if (searchResult) {
        matchPageUrl = searchResult.url;
        regionChannels = searchResult.regionChannels;
        kickoffUtc = searchResult.kickoffUtc;
      }
    }
    
    if (regionChannels.length > 0) {
      log(`Success: Found ${regionChannels.length} TV channels for ${home} vs ${away}`);
    } else {
      log(`No TV channels found for ${home} vs ${away}`);
    }
    
    return {
      url: matchPageUrl,
      kickoffUtc,
      regionChannels
    };
    
  } catch (err) {
    log(`Error: ${err.message}`);
    return emptyResult;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        // Ignore close errors
      }
    }
  }
}

/**
 * Extract TV channels from a LiveSoccerTV match page.
 * @param {Page} page - Puppeteer page object
 * @returns {Promise<{regionChannels: Array<{region: string, channel: string}>, kickoffUtc: string|null}>}
 */
async function extractTvChannelsFromPage(page) {
  try {
    const result = await page.evaluate(() => {
      const channels = [];
      let kickoffUtc = null;
      
      // Try to extract kickoff time
      const timeEl = document.querySelector('.matchdate, .match-time, [class*="match-date"], time');
      if (timeEl) {
        kickoffUtc = timeEl.getAttribute('datetime') || timeEl.textContent.trim();
      }
      
      // Method 1: Look for TV broadcast table rows
      const rows = document.querySelectorAll('table.listing tbody tr, .broadcast-list tr, .tv-channels tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 2) {
          // First cell usually has country/region
          const regionCell = cells[0];
          const channelCell = cells[1];
          
          // Get region from flag image alt or cell text
          let region = '';
          const flagImg = regionCell.querySelector('img');
          if (flagImg) {
            region = flagImg.getAttribute('alt') || flagImg.getAttribute('title') || '';
          }
          if (!region) {
            region = regionCell.textContent.trim();
          }
          
          // Get channel(s) from cell - may have multiple channels
          const channelLinks = channelCell.querySelectorAll('a');
          if (channelLinks.length > 0) {
            channelLinks.forEach(link => {
              const channel = link.textContent.trim();
              if (region && channel) {
                channels.push({ region, channel });
              }
            });
          } else {
            const channel = channelCell.textContent.trim();
            if (region && channel) {
              channels.push({ region, channel });
            }
          }
        }
      });
      
      // Method 2: Alternative structure with country flags and channel names
      if (channels.length === 0) {
        const items = document.querySelectorAll('.broadcast-item, [class*="broadcast"]');
        items.forEach(item => {
          const regionEl = item.querySelector('[class*="country"], img[alt]');
          const channelEl = item.querySelector('[class*="channel"], a');
          
          const region = regionEl ? (regionEl.getAttribute('alt') || regionEl.textContent.trim()) : '';
          const channel = channelEl ? channelEl.textContent.trim() : '';
          
          if (region && channel) {
            channels.push({ region, channel });
          }
        });
      }
      
      // Method 3: Look for any table with country flags
      if (channels.length === 0) {
        const allTables = document.querySelectorAll('table');
        allTables.forEach(table => {
          const rows = table.querySelectorAll('tr');
          rows.forEach(row => {
            const img = row.querySelector('img[alt]');
            if (img) {
              const region = img.getAttribute('alt') || '';
              const textContent = row.textContent.replace(region, '').trim();
              if (region && textContent) {
                channels.push({ region, channel: textContent });
              }
            }
          });
        });
      }
      
      return { regionChannels: channels, kickoffUtc };
    });
    
    // Deduplicate channels
    const seen = new Set();
    const unique = [];
    for (const entry of result.regionChannels) {
      const key = `${entry.region}|${entry.channel}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(entry);
      }
    }
    
    return {
      regionChannels: unique,
      kickoffUtc: result.kickoffUtc
    };
    
  } catch (err) {
    return { regionChannels: [], kickoffUtc: null };
  }
}

/**
 * Find a specific match on a team's schedule page.
 * @param {Page} page - Puppeteer page object
 * @param {string} home - Home team name
 * @param {string} away - Away team name
 * @param {Date|string} date - Match date
 * @returns {Promise<string|null>} Match page URL or null
 */
async function findMatchOnSchedule(page, home, away, date) {
  try {
    const matchDate = date instanceof Date
      ? date.toISOString().slice(0, 10)
      : String(date || '').slice(0, 10);
    
    const homeLower = (home || '').toLowerCase();
    const awayLower = (away || '').toLowerCase();
    
    const matchUrl = await page.evaluate((homeLower, awayLower) => {
      // Look for match links in the schedule
      const links = document.querySelectorAll('a[href*="/match/"]');
      
      for (const link of links) {
        const text = link.textContent.toLowerCase();
        const href = link.getAttribute('href') || '';
        
        // Check if both teams appear in the link text or href
        if ((text.includes(homeLower) || href.includes(homeLower.replace(/\s+/g, '-'))) &&
            (text.includes(awayLower) || href.includes(awayLower.replace(/\s+/g, '-')))) {
          // Found a potential match
          return href.startsWith('http') ? href : 'https://www.livesoccertv.com' + href;
        }
      }
      
      return null;
    }, homeLower, awayLower);
    
    return matchUrl;
    
  } catch (err) {
    return null;
  }
}

/**
 * Search for a match on the LiveSoccerTV site.
 * @param {Page} page - Puppeteer page object
 * @param {string} home - Home team name
 * @param {string} away - Away team name
 * @returns {Promise<{url: string, regionChannels: Array, kickoffUtc: string|null}|null>}
 */
async function searchOnSite(page, home, away) {
  try {
    const searchQuery = `${home} ${away}`;
    const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(searchQuery)}`;
    
    log(`Searching: ${searchUrl}`);
    
    await page.goto(searchUrl, {
      waitUntil: 'networkidle2',
      timeout: NAVIGATION_TIMEOUT
    });
    
    await page.waitForTimeout(2000);
    
    // Look for match links in search results
    const matchLink = await page.evaluate((homeLower, awayLower) => {
      const links = document.querySelectorAll('a[href*="/match/"]');
      
      for (const link of links) {
        const text = link.textContent.toLowerCase();
        const href = link.getAttribute('href') || '';
        
        if ((text.includes(homeLower) || href.includes(homeLower.replace(/\s+/g, '-'))) &&
            (text.includes(awayLower) || href.includes(awayLower.replace(/\s+/g, '-')))) {
          return href.startsWith('http') ? href : 'https://www.livesoccertv.com' + href;
        }
      }
      
      return null;
    }, home.toLowerCase(), away.toLowerCase());
    
    if (matchLink) {
      log(`Found match in search results: ${matchLink}`);
      
      await page.goto(matchLink, {
        waitUntil: 'networkidle2',
        timeout: NAVIGATION_TIMEOUT
      });
      
      await page.waitForTimeout(2000);
      
      const result = await extractTvChannelsFromPage(page);
      if (result.regionChannels.length > 0) {
        return {
          url: matchLink,
          regionChannels: result.regionChannels,
          kickoffUtc: result.kickoffUtc
        };
      }
    }
    
    return null;
    
  } catch (err) {
    log(`Search error: ${err.message}`);
    return null;
  }
}

// ---------- Health Check ----------

/**
 * Perform a health check by loading the LiveSoccerTV homepage.
 * @returns {Promise<{ok: boolean, latencyMs: number, error?: string}>}
 */
async function healthCheck() {
  const startTime = Date.now();
  
  const puppeteer = loadPuppeteer();
  if (!puppeteer) {
    const result = { ok: false, latencyMs: 0, error: 'Puppeteer not available' };
    log(`[health] FAIL: ${result.error}`);
    return result;
  }
  
  const chromePath = findChromePath();
  if (!chromePath) {
    const result = { ok: false, latencyMs: 0, error: 'Chrome/Chromium not found' };
    log(`[health] FAIL: ${result.error}`);
    return result;
  }
  
  let browser = null;
  
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(DEFAULT_TIMEOUT);
    
    await page.goto(BASE_URL, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });
    
    const latencyMs = Date.now() - startTime;
    const result = { ok: true, latencyMs };
    
    log(`[health] OK in ${latencyMs}ms`);
    return result;
    
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const result = { ok: false, latencyMs, error: err.message };
    
    log(`[health] FAIL in ${latencyMs}ms: ${err.message}`);
    return result;
    
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        // Ignore
      }
    }
  }
}

// ---------- Module Exports ----------

module.exports = {
  fetchLSTV,
  healthCheck,
  // Export helpers for testing
  normalizeTeamName,
  buildSearchUrls,
  findChromePath,
  BASE_URL
};
