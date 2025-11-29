// livesoccertv.js
// Scraper for LiveSoccerTV to extract worldwide TV channel listings for football matches.
/**
 * Telegram Sports TV Bot – LiveSoccerTV Scraper
 *
 * Provides functions to scrape TV channel listings from LiveSoccerTV.com:
 * - Search for matches by team name or match page URL
 * - Extract TV channels grouped by country/region
 * - Return structured JSON for poster generation
 *
 * The scraper uses:
 * - puppeteer-core for browser automation (when available)
 * - Cloudflare bypass techniques (stealth mode, realistic headers)
 * - Caching to avoid re-scraping the same match
 *
 * Note: This module requires an external Chrome/Chromium installation
 * when using puppeteer-core. It falls back to HTTP scraping when
 * Puppeteer is not available.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------

const BASE_URL = 'https://www.livesoccertv.com';
const DEFAULT_TIMEOUT = 30000;

// Cache configuration
const CACHE_DIR = path.join(__dirname, 'cache', 'livesoccertv');
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours - matches don't change frequently

// Realistic browser headers to help bypass basic bot detection
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

// ---------- Cache Helpers ----------

/**
 * Generate a safe cache filename from a URL or key.
 * @param {string} key
 * @returns {string}
 */
function getCacheKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex') + '.json';
}

/**
 * Ensure the cache directory exists.
 */
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Read cached data if it exists and is fresh.
 * @param {string} key
 * @returns {Object | null}
 */
function readCache(key) {
  try {
    const cacheFile = path.join(CACHE_DIR, getCacheKey(key));
    if (!fs.existsSync(cacheFile)) {
      return null;
    }
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const entry = JSON.parse(raw);
    if (entry && entry.data && typeof entry.timestamp === 'number') {
      // Check if cache is still fresh
      if (Date.now() - entry.timestamp < CACHE_TTL_MS) {
        return entry.data;
      }
    }
  } catch (err) {
    // Ignore cache read errors
  }
  return null;
}

/**
 * Write data to cache.
 * @param {string} key
 * @param {Object} data
 */
function writeCache(key, data) {
  try {
    ensureCacheDir();
    const cacheFile = path.join(CACHE_DIR, getCacheKey(key));
    const entry = {
      data,
      timestamp: Date.now()
    };
    fs.writeFileSync(cacheFile, JSON.stringify(entry), 'utf8');
  } catch (err) {
    // Ignore cache write errors
  }
}

/**
 * Generate a unique cache key for a match based on teams and date.
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {Date|string} matchDate
 * @returns {string}
 */
function getMatchCacheKey(homeTeam, awayTeam, matchDate) {
  const dateStr = matchDate instanceof Date
    ? matchDate.toISOString().slice(0, 10)
    : String(matchDate).slice(0, 10);
  return `match:${homeTeam.toLowerCase()}:${awayTeam.toLowerCase()}:${dateStr}`;
}

// ---------- HTTP Scraper (fallback) ----------

/**
 * Fetch a page with realistic browser headers.
 * @param {string} url
 * @returns {Promise<string>} HTML content
 */
async function fetchPage(url) {
  const response = await axios.get(url, {
    timeout: DEFAULT_TIMEOUT,
    headers: BROWSER_HEADERS,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400
  });
  return response.data;
}

/**
 * Search for a team's upcoming matches on LiveSoccerTV.
 * @param {string} teamName - Team name to search for
 * @returns {Promise<Array<{url: string, homeTeam: string, awayTeam: string, date: string, time: string}>>}
 */
async function searchTeamMatches(teamName) {
  if (!teamName) {
    return [];
  }

  // Build search URL - LiveSoccerTV uses teams organized by league/country
  // Try multiple country paths since we don't know the team's league
  const searchSlug = teamName.toLowerCase().trim().replace(/\s+/g, '-');
  const countryPaths = ['england', 'spain', 'germany', 'italy', 'france', 'scotland', 'wales'];
  
  for (const country of countryPaths) {
    const searchUrl = `${BASE_URL}/teams/${country}/${searchSlug}/`;

    try {
      const html = await fetchPage(searchUrl);
      const $ = cheerio.load(html);

      const matches = [];

      // Parse the fixtures table
      $('table.schedules tbody tr').each((i, row) => {
        const $row = $(row);
        const matchLink = $row.find('a[href*="/match/"]').first();
        
        if (matchLink.length) {
          const url = BASE_URL + matchLink.attr('href');
          const matchText = matchLink.text().trim();
          
          // Try to parse "Team A vs Team B" format
          const vsMatch = matchText.match(/^(.+?)\s+(?:vs?\.?|–|-)\s+(.+)$/i);
          let homeTeam = '';
          let awayTeam = '';
          
          if (vsMatch) {
            homeTeam = vsMatch[1].trim();
            awayTeam = vsMatch[2].trim();
          }

          // Get date/time
          const dateCell = $row.find('td').first().text().trim();
          const timeCell = $row.find('td:nth-child(2)').text().trim();

          matches.push({
            url,
            homeTeam,
            awayTeam,
            date: dateCell,
            time: timeCell,
            raw: matchText
          });
        }
      });

      // If we found matches, return them
      if (matches.length > 0) {
        return matches;
      }
    } catch (err) {
      // Try next country path
      continue;
    }
  }

  // No matches found in any country path
  console.log(`[LiveSoccerTV] No team page found for "${teamName}" in any league`);
  return [];
}

/**
 * Parse TV channels from a match page HTML.
 * @param {string} html - Match page HTML
 * @returns {Array<{region: string, channel: string}>}
 */
function parseTvChannels(html) {
  const $ = cheerio.load(html);
  const tvByRegion = [];

  // LiveSoccerTV lists TV channels in a table with country flags and channel names
  // The structure is typically: flag/country | channel name(s)
  
  // Method 1: Parse from the "TV Stations" section
  $('table.listing tbody tr, .tv-channels tr, .broadcast-list tr').each((i, row) => {
    const $row = $(row);
    
    // Get country/region
    let region = '';
    const countryCell = $row.find('td:first-child, .country, [class*="country"]');
    const flagImg = countryCell.find('img');
    
    if (flagImg.length) {
      region = flagImg.attr('alt') || flagImg.attr('title') || '';
    }
    if (!region) {
      region = countryCell.text().trim();
    }

    // Get channel(s)
    const channelCell = $row.find('td:nth-child(2), .channels, [class*="channel"]');
    const channels = [];
    
    // Multiple channels might be listed, separated by <br> or in separate spans
    channelCell.find('a, span').each((j, el) => {
      const channelName = $(el).text().trim();
      if (channelName && !channels.includes(channelName)) {
        channels.push(channelName);
      }
    });
    
    // Fallback to raw text if no structured elements found
    if (!channels.length) {
      const rawText = channelCell.text().trim();
      if (rawText) {
        channels.push(rawText);
      }
    }

    // Add each channel as a separate entry
    if (region && channels.length) {
      for (const channel of channels) {
        tvByRegion.push({
          region: cleanRegionName(region),
          channel: channel
        });
      }
    }
  });

  // Method 2: Parse from any visible broadcast info sections
  if (tvByRegion.length === 0) {
    // Try alternative selectors
    $('.broadcast-item, .tv-listing-item, [class*="broadcast"]').each((i, item) => {
      const $item = $(item);
      const region = $item.find('.country, [class*="country"]').text().trim() ||
                     $item.find('img').attr('alt') || '';
      const channel = $item.find('.channel, [class*="channel"], a').text().trim();
      
      if (region && channel) {
        tvByRegion.push({
          region: cleanRegionName(region),
          channel
        });
      }
    });
  }

  // Deduplicate entries
  const seen = new Set();
  const unique = [];
  for (const entry of tvByRegion) {
    const key = `${entry.region}|${entry.channel}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(entry);
    }
  }

  return unique;
}

/**
 * Clean and normalize a region/country name.
 * @param {string} region
 * @returns {string}
 */
function cleanRegionName(region) {
  return (region || '')
    .trim()
    .replace(/\s+/g, ' ')
    // Common abbreviation expansions
    .replace(/^UK$/i, 'United Kingdom')
    .replace(/^USA?$/i, 'United States')
    .replace(/^CA$/i, 'Canada')
    .replace(/^AU$/i, 'Australia');
}

/**
 * Fetch TV channels for a specific match page URL.
 * @param {string} matchUrl - Full URL to the match page on LiveSoccerTV
 * @returns {Promise<{homeTeam: string, awayTeam: string, tvByRegion: Array<{region: string, channel: string}>}>}
 */
async function getMatchTvChannels(matchUrl) {
  if (!matchUrl) {
    return { homeTeam: '', awayTeam: '', tvByRegion: [] };
  }

  // Check cache first
  const cached = readCache(matchUrl);
  if (cached) {
    console.log(`[LiveSoccerTV] Using cached data for ${matchUrl}`);
    return cached;
  }

  try {
    console.log(`[LiveSoccerTV] Fetching match page: ${matchUrl}`);
    const html = await fetchPage(matchUrl);
    const $ = cheerio.load(html);

    // Extract match info
    let homeTeam = '';
    let awayTeam = '';

    // Try to get team names from title or header
    const title = $('h1, .match-title, [class*="match-header"]').first().text().trim();
    const vsMatch = title.match(/^(.+?)\s+(?:vs?\.?|–|-)\s+(.+)$/i);
    if (vsMatch) {
      homeTeam = vsMatch[1].trim();
      awayTeam = vsMatch[2].trim();
    }

    // Parse TV channels
    const tvByRegion = parseTvChannels(html);

    const result = {
      homeTeam,
      awayTeam,
      tvByRegion,
      source: 'livesoccertv',
      url: matchUrl
    };

    // Cache the result
    writeCache(matchUrl, result);

    return result;
  } catch (err) {
    console.log(`[LiveSoccerTV] Error fetching match page: ${err.message}`);
    return { homeTeam: '', awayTeam: '', tvByRegion: [] };
  }
}

// ---------- Puppeteer-based Scraper (advanced) ----------

let puppeteer = null;

/**
 * Lazy-load puppeteer-core.
 * @returns {Object|null} Puppeteer module or null if not available
 */
function loadPuppeteer() {
  if (puppeteer === null) {
    try {
      puppeteer = require('puppeteer-core');
    } catch (err) {
      puppeteer = false;
      console.log('[LiveSoccerTV] puppeteer-core not available, using HTTP fallback');
    }
  }
  return puppeteer || null;
}

/**
 * Find a Chrome/Chromium executable on the system.
 * @returns {string|null} Path to Chrome executable
 */
function findChromePath() {
  const possiblePaths = [
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];

  for (const chromePath of possiblePaths) {
    if (fs.existsSync(chromePath)) {
      return chromePath;
    }
  }

  return process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null;
}

/**
 * Fetch a page using Puppeteer with stealth mode.
 * This helps bypass Cloudflare and other bot protection.
 * @param {string} url
 * @returns {Promise<string>} HTML content
 */
async function fetchPageWithPuppeteer(url) {
  const pptr = loadPuppeteer();
  if (!pptr) {
    throw new Error('Puppeteer not available');
  }

  const chromePath = findChromePath();
  if (!chromePath) {
    throw new Error('Chrome/Chromium not found. Set CHROME_PATH environment variable.');
  }

  let browser = null;
  try {
    browser = await pptr.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080'
      ]
    });

    const page = await browser.newPage();

    // Set viewport to look like a real browser
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1
    });

    // Set realistic user agent
    await page.setUserAgent(BROWSER_HEADERS['User-Agent']);

    // Set extra headers
    await page.setExtraHTTPHeaders({
      'Accept-Language': BROWSER_HEADERS['Accept-Language']
    });

    // Navigate to the page
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });

    // Wait for Cloudflare challenge to complete (if any)
    // This waits for the challenge to finish or times out after 10 seconds
    try {
      await page.waitForFunction(
        () => !document.querySelector('#challenge-running'),
        { timeout: 10000 }
      );
    } catch (e) {
      // Challenge might not exist, continue
    }

    // Wait a bit more for dynamic content
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get the page content
    const html = await page.content();

    return html;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Fetch TV channels for a match using Puppeteer (for Cloudflare bypass).
 * Falls back to HTTP method if Puppeteer is not available.
 * @param {string} matchUrl
 * @returns {Promise<{homeTeam: string, awayTeam: string, tvByRegion: Array<{region: string, channel: string}>}>}
 */
async function getMatchTvChannelsWithPuppeteer(matchUrl) {
  if (!matchUrl) {
    return { homeTeam: '', awayTeam: '', tvByRegion: [] };
  }

  // Check cache first
  const cached = readCache(matchUrl);
  if (cached) {
    console.log(`[LiveSoccerTV] Using cached data for ${matchUrl}`);
    return cached;
  }

  try {
    console.log(`[LiveSoccerTV] Fetching match page with Puppeteer: ${matchUrl}`);
    const html = await fetchPageWithPuppeteer(matchUrl);
    const $ = cheerio.load(html);

    // Extract match info
    let homeTeam = '';
    let awayTeam = '';

    const title = $('h1, .match-title, [class*="match-header"]').first().text().trim();
    const vsMatch = title.match(/^(.+?)\s+(?:vs?\.?|–|-)\s+(.+)$/i);
    if (vsMatch) {
      homeTeam = vsMatch[1].trim();
      awayTeam = vsMatch[2].trim();
    }

    const tvByRegion = parseTvChannels(html);

    const result = {
      homeTeam,
      awayTeam,
      tvByRegion,
      source: 'livesoccertv',
      url: matchUrl
    };

    writeCache(matchUrl, result);

    return result;
  } catch (err) {
    console.log(`[LiveSoccerTV] Puppeteer error: ${err.message}, falling back to HTTP`);
    // Fall back to simple HTTP request
    return getMatchTvChannels(matchUrl);
  }
}

// ---------- Main API Functions ----------

/**
 * Find and get TV channels for a match by team names and date.
 * Searches LiveSoccerTV for the match and extracts TV channel info.
 * 
 * @param {string} homeTeam - Home team name
 * @param {string} awayTeam - Away team name
 * @param {Date|string} matchDate - Match date
 * @param {Object} options - Options
 * @param {boolean} options.usePuppeteer - Whether to try Puppeteer first (default: false)
 * @returns {Promise<{tvByRegion: Array<{region: string, channel: string}>, source: string}>}
 */
async function getTvChannelsForMatch(homeTeam, awayTeam, matchDate, options = {}) {
  if (!homeTeam || !awayTeam) {
    return { tvByRegion: [], source: 'none' };
  }

  // Check cache first using match key
  const cacheKey = getMatchCacheKey(homeTeam, awayTeam, matchDate);
  const cached = readCache(cacheKey);
  if (cached) {
    console.log(`[LiveSoccerTV] Using cached TV data for ${homeTeam} vs ${awayTeam}`);
    return cached;
  }

  // Try to search for the match
  const teamName = homeTeam; // Search by home team first
  
  try {
    // Build the search URL for LiveSoccerTV
    // Format: /match/{id}/{team1-vs-team2}/
    // We need to try to find the match page
    
    // Normalize team names for URL
    const normalizeForUrl = (name) => name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    
    const homeSlug = normalizeForUrl(homeTeam);
    const awaySlug = normalizeForUrl(awayTeam);
    
    // Country paths to try for team pages
    const countryPaths = ['england', 'spain', 'germany', 'italy', 'france', 'scotland', 'wales'];
    
    // Build possible URLs - direct match URLs first, then team pages
    const possibleUrls = [
      `${BASE_URL}/match/${homeSlug}-vs-${awaySlug}/`,
      `${BASE_URL}/match/${homeSlug}-v-${awaySlug}/`
    ];
    
    // Add team page URLs for each country
    for (const country of countryPaths) {
      possibleUrls.push(`${BASE_URL}/teams/${country}/${homeSlug}/`);
    }

    let result = { tvByRegion: [], source: 'livesoccertv' };
    
    for (const url of possibleUrls) {
      try {
        if (options.usePuppeteer) {
          result = await getMatchTvChannelsWithPuppeteer(url);
        } else {
          result = await getMatchTvChannels(url);
        }
        
        if (result.tvByRegion && result.tvByRegion.length > 0) {
          break;
        }
      } catch (err) {
        // Try next URL
        continue;
      }
    }

    // Cache the result
    if (result.tvByRegion && result.tvByRegion.length > 0) {
      writeCache(cacheKey, result);
    }

    return result;
  } catch (err) {
    console.log(`[LiveSoccerTV] Error getting TV channels: ${err.message}`);
    return { tvByRegion: [], source: 'livesoccertv', error: err.message };
  }
}

/**
 * Enrich a fixture object with TV channel information from LiveSoccerTV.
 * 
 * @param {Object} fixture - Fixture object with homeTeam, awayTeam, date/start
 * @param {Object} options - Options to pass to getTvChannelsForMatch
 * @returns {Promise<Object>} Fixture with tvByRegion populated
 */
async function enrichFixtureWithTvInfo(fixture, options = {}) {
  if (!fixture) {
    return fixture;
  }

  // Skip if already has TV info
  if (fixture.tvByRegion && fixture.tvByRegion.length > 0) {
    return fixture;
  }

  const homeTeam = fixture.homeTeam || '';
  const awayTeam = fixture.awayTeam || '';
  const matchDate = fixture.start || fixture.date || new Date();

  if (!homeTeam || !awayTeam) {
    return fixture;
  }

  try {
    const tvInfo = await getTvChannelsForMatch(homeTeam, awayTeam, matchDate, options);
    
    if (tvInfo.tvByRegion && tvInfo.tvByRegion.length > 0) {
      fixture.tvByRegion = tvInfo.tvByRegion;
      fixture.tvSource = tvInfo.source;
    }
  } catch (err) {
    // Don't fail the fixture, just log
    console.log(`[LiveSoccerTV] Warning: Could not enrich fixture: ${err.message}`);
  }

  return fixture;
}

/**
 * Batch enrich multiple fixtures with TV info.
 * Includes rate limiting to be polite to the server.
 * 
 * @param {Array<Object>} fixtures - Array of fixture objects
 * @param {Object} options - Options
 * @param {number} options.delayMs - Delay between requests (default 1000)
 * @param {boolean} options.usePuppeteer - Whether to use Puppeteer (default false)
 * @returns {Promise<Array<Object>>} Enriched fixtures
 */
async function enrichFixturesWithTvInfo(fixtures, options = {}) {
  const { delayMs = 1000, usePuppeteer = false } = options;
  
  if (!fixtures || !fixtures.length) {
    return fixtures || [];
  }

  const enriched = [];
  
  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i];
    const enrichedFixture = await enrichFixtureWithTvInfo(fixture, { usePuppeteer });
    enriched.push(enrichedFixture);
    
    // Rate limiting - wait between requests
    if (i < fixtures.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return enriched;
}

/**
 * Clear the LiveSoccerTV cache.
 */
function clearCache() {
  try {
    if (fs.existsSync(CACHE_DIR)) {
      const files = fs.readdirSync(CACHE_DIR);
      for (const file of files) {
        fs.unlinkSync(path.join(CACHE_DIR, file));
      }
    }
  } catch (err) {
    // Ignore errors
  }
}

// ---------- Module Exports ----------

module.exports = {
  // Main API
  getTvChannelsForMatch,
  enrichFixtureWithTvInfo,
  enrichFixturesWithTvInfo,
  
  // Lower-level functions
  searchTeamMatches,
  getMatchTvChannels,
  getMatchTvChannelsWithPuppeteer,
  
  // Utilities
  clearCache,
  getMatchCacheKey,
  
  // Constants
  BASE_URL,
  CACHE_TTL_MS
};
