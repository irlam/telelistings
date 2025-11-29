// scrapers/lstv.js
// LiveSoccerTV scraper using Puppeteer to fetch TV channels for each fixture.
/**
 * Telegram Sports TV Bot – LiveSoccerTV Puppeteer Scraper
 *
 * Exports fetchLSTV({ home, away, date, kickoffUtc, league }) which:
 * - Searches LiveSoccerTV for the correct match
 * - Uses match scoring to select the best candidate
 * - Opens the match page
 * - Extracts region/channel rows (e.g. Australia → Stan Sport)
 *
 * Returns:
 * {
 *   url: string | null,
 *   kickoffUtc: string | null,
 *   regionChannels: [{ region, channel }, ...],
 *   matchScore: number | null  // score of the selected match (0-100)
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
const PAGE_LOAD_DELAY_MS = 2000; // Delay after page load for dynamic content

// Match scoring configuration
const SCORE_THRESHOLD = 50;          // Minimum score to accept a match (0-100)
const TIME_WINDOW_HOURS = 3;         // Accept matches within this many hours of kickoff

// Debug flag - set via environment variable LSTV_DEBUG=1 or modify this constant
const DEBUG = process.env.LSTV_DEBUG === '1' || process.env.LSTV_DEBUG === 'true';

// User agent string - generic format to avoid detection issues
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Chrome executable paths to try (environment variables take precedence)
// This covers common installation paths across Linux, macOS, and Windows
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

/**
 * Log debug message (only when DEBUG is enabled).
 * @param {string} msg - Debug message to log
 */
function debugLog(msg) {
  if (DEBUG) {
    log(`[DEBUG] ${msg}`);
  }
}

// ---------- Team Name Normalization for Matching ----------

/**
 * Normalize a team name for comparison purposes.
 * Only strips common prefixes/suffixes that are typically redundant (FC, AFC).
 * Keeps important distinguishing words like City, United, Town that differentiate teams.
 * @param {string} name - Team name
 * @returns {string} Normalized name for comparison
 */
function normalizeForComparison(name) {
  if (!name) return '';
  
  return name
    .toLowerCase()
    .trim()
    // Only remove truly redundant prefixes/suffixes (FC, AFC, SC, etc.)
    // Keep words like United, City, Town as they distinguish teams
    .replace(/\b(fc|afc|cf|sc|ac|as|ss|rc|rfc)\b/gi, '')
    // Remove punctuation and extra whitespace
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate similarity score between two team names.
 * Returns a score from 0 (no match) to 100 (exact match).
 * @param {string} name1 - First team name
 * @param {string} name2 - Second team name
 * @returns {number} Similarity score 0-100
 */
function teamNameSimilarity(name1, name2) {
  const norm1 = normalizeForComparison(name1);
  const norm2 = normalizeForComparison(name2);
  
  if (!norm1 || !norm2) return 0;
  
  // Exact match after normalization
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

// ---------- Match Scoring System ----------

/**
 * Score a candidate fixture against the requested match criteria.
 * @param {Object} candidate - Candidate fixture from LSTV
 * @param {string} candidate.homeTeam - Home team name from candidate
 * @param {string} candidate.awayTeam - Away team name from candidate
 * @param {string|Date} candidate.dateTime - Candidate match datetime
 * @param {string} candidate.league - League/competition name (optional)
 * @param {Object} requested - Requested match criteria
 * @param {string} requested.home - Requested home team
 * @param {string} requested.away - Requested away team
 * @param {Date} requested.date - Requested match date
 * @param {Date} requested.kickoffUtc - Known kickoff time (optional, more precise)
 * @param {string} requested.league - Expected league (optional)
 * @returns {number} Score from 0-100
 */
function scoreCandidate(candidate, requested) {
  let score = 0;
  
  // Team name matching (50% of total score)
  const homeScore = teamNameSimilarity(candidate.homeTeam, requested.home);
  const awayScore = teamNameSimilarity(candidate.awayTeam, requested.away);
  const teamScore = (homeScore + awayScore) / 2;
  score += teamScore * 0.5;
  
  // Also check if teams are swapped (home/away reversed)
  const swappedHomeScore = teamNameSimilarity(candidate.homeTeam, requested.away);
  const swappedAwayScore = teamNameSimilarity(candidate.awayTeam, requested.home);
  const swappedTeamScore = (swappedHomeScore + swappedAwayScore) / 2;
  
  // Use better of normal or swapped (but penalize swapped slightly)
  if (swappedTeamScore * 0.9 > teamScore) {
    score = swappedTeamScore * 0.9 * 0.5;
  }
  
  // Date/time matching (40% of total score)
  if (candidate.dateTime && requested.date) {
    const candidateDate = candidate.dateTime instanceof Date 
      ? candidate.dateTime 
      : new Date(candidate.dateTime);
    const requestedDate = requested.kickoffUtc instanceof Date 
      ? requested.kickoffUtc 
      : (requested.date instanceof Date ? requested.date : new Date(requested.date));
    
    if (!isNaN(candidateDate.getTime()) && !isNaN(requestedDate.getTime())) {
      const diffMs = Math.abs(candidateDate.getTime() - requestedDate.getTime());
      const diffHours = diffMs / (1000 * 60 * 60);
      
      if (diffHours <= 0.5) {
        // Within 30 minutes - excellent match
        score += 40;
      } else if (diffHours <= TIME_WINDOW_HOURS) {
        // Within time window - good match, score decreases with distance
        score += 40 * (1 - diffHours / TIME_WINDOW_HOURS);
      } else if (candidateDate.toDateString() === requestedDate.toDateString()) {
        // Same day but outside time window
        score += 20;
      }
      // Different day = 0 points for time
    }
  }
  
  // League matching (10% of total score) - bonus if we know the league
  if (requested.league && candidate.league) {
    const leagueSim = teamNameSimilarity(candidate.league, requested.league);
    score += leagueSim * 0.1;
  }
  
  return Math.round(score);
}

// ---------- Chrome/Puppeteer Helpers ----------

// Cache for puppeteer module
let _puppeteerModule = null;
let _puppeteerLoaded = false;

/**
 * Lazy-load puppeteer (or puppeteer-core as fallback).
 * @returns {Object|null} Puppeteer module or null if not available
 */
function loadPuppeteer() {
  if (_puppeteerLoaded) {
    return _puppeteerModule;
  }
  
  _puppeteerLoaded = true;
  
  // Try full puppeteer first (bundles Chromium)
  try {
    _puppeteerModule = require('puppeteer');
    debugLog('Loaded full puppeteer package');
    return _puppeteerModule;
  } catch (err) {
    debugLog(`Full puppeteer not available: ${err.code || err.message}`);
    // Fall back to puppeteer-core
    try {
      _puppeteerModule = require('puppeteer-core');
      debugLog('Loaded puppeteer-core package');
      return _puppeteerModule;
    } catch (err2) {
      log(`Neither puppeteer nor puppeteer-core available: puppeteer: ${err.code || err.message}, puppeteer-core: ${err2.code || err2.message}`);
      _puppeteerModule = null;
      return null;
    }
  }
}

/**
 * Find a Chrome/Chromium executable on the system.
 * First checks for puppeteer's bundled Chromium, then environment variables,
 * then common system installation paths.
 * @returns {string|null} Path to Chrome executable or null if not found
 */
function findChromePath() {
  // Check for puppeteer's bundled Chromium first (highest priority when available)
  const puppeteer = loadPuppeteer();
  if (puppeteer) {
    try {
      // Both puppeteer and puppeteer-core have executablePath() but only full puppeteer
      // bundles Chromium and returns a path that exists. puppeteer-core returns a path
      // that may not exist unless manually installed.
      const bundledPath = puppeteer.executablePath();
      if (bundledPath && fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    } catch (err) {
      // executablePath() may throw if no bundled Chromium (puppeteer-core case)
      debugLog(`Bundled Chromium not available: ${err.message}`);
    }
  }
  
  // Check environment variables
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  
  // Search common installation paths
  for (const chromePath of CHROME_PATHS) {
    if (chromePath && fs.existsSync(chromePath)) {
      return chromePath;
    }
  }
  
  return null;
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
 * @param {Date|string} params.kickoffUtc - Known kickoff time (optional, for better matching)
 * @param {string} params.league - League/competition name (optional, for better matching)
 * @returns {Promise<{url: string|null, kickoffUtc: string|null, regionChannels: Array<{region: string, channel: string}>, matchScore: number|null}>}
 */
async function fetchLSTV({ home, away, date, kickoffUtc = null, league = null }) {
  // Default empty result - never throw
  const emptyResult = {
    url: null,
    kickoffUtc: null,
    regionChannels: [],
    matchScore: null
  };
  
  // Validate inputs
  if (!home || !away) {
    log(`Missing team names: home="${home}", away="${away}"`);
    return emptyResult;
  }
  
  const requestedMatch = {
    home,
    away,
    date: date instanceof Date ? date : new Date(date || Date.now()),
    kickoffUtc: kickoffUtc ? (kickoffUtc instanceof Date ? kickoffUtc : new Date(kickoffUtc)) : null,
    league
  };
  
  log(`Searching for ${home} vs ${away}${league ? ` (${league})` : ''}`);
  
  // Load Puppeteer
  const puppeteer = loadPuppeteer();
  if (!puppeteer) {
    log('Puppeteer not available, cannot scrape');
    return emptyResult;
  }
  
  // Find Chrome - required for puppeteer-core
  const chromePath = findChromePath();
  if (!chromePath) {
    log('Chrome/Chromium not found on system. Set CHROME_PATH env var or install Chrome.');
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
    await page.setUserAgent(USER_AGENT);
    
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
        
        // Wait for dynamic content to load
        await page.waitForTimeout(PAGE_LOAD_DELAY_MS);
        
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
            
            await page.waitForTimeout(PAGE_LOAD_DELAY_MS);
            
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
      return {
        url: matchPageUrl,
        kickoffUtc,
        regionChannels,
        matchScore: 75 // Default good score when found via direct match
      };
    } else {
      log(`WARNING: No TV channels found for ${home} vs ${away} - no match page found or page had no channel data`);
      return {
        url: null,
        kickoffUtc: null,
        regionChannels: [],
        matchScore: null
      };
    }
    
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
    
    await page.waitForTimeout(PAGE_LOAD_DELAY_MS);
    
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
      
      await page.waitForTimeout(PAGE_LOAD_DELAY_MS);
      
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
 * Get detailed system information about Chrome/Puppeteer availability.
 * @returns {{puppeteerAvailable: boolean, puppeteerType: string, chromeFound: boolean, chromePath: string|null, searchedPaths: string[], bundledChrome: boolean}}
 */
function getSystemInfo() {
  let puppeteerAvailable = false;
  let puppeteerType = 'none';
  let bundledChrome = false;
  
  // Check for full puppeteer first (bundles Chromium)
  const puppeteer = loadPuppeteer();
  if (puppeteer) {
    puppeteerAvailable = true;
    
    // Check if it's full puppeteer with bundled Chromium
    try {
      const bundledPath = puppeteer.executablePath();
      if (bundledPath && fs.existsSync(bundledPath)) {
        bundledChrome = true;
        puppeteerType = 'puppeteer';
      } else {
        puppeteerType = 'puppeteer-core';
      }
    } catch (err) {
      puppeteerType = 'puppeteer-core';
    }
  }
  
  const chromePath = findChromePath();
  
  return {
    puppeteerAvailable,
    puppeteerType,
    chromeFound: !!chromePath,
    chromePath,
    bundledChrome,
    searchedPaths: CHROME_PATHS.filter(p => p) // Filter out null/undefined
  };
}

/**
 * Perform a health check by loading the LiveSoccerTV homepage.
 * @returns {Promise<{ok: boolean, latencyMs: number, error?: string, systemInfo?: Object}>}
 */
async function healthCheck() {
  const startTime = Date.now();
  const systemInfo = getSystemInfo();
  
  const puppeteer = loadPuppeteer();
  if (!puppeteer) {
    const result = { 
      ok: false, 
      latencyMs: 0, 
      error: 'Puppeteer not available. Install puppeteer (recommended) or puppeteer-core: npm install puppeteer',
      systemInfo
    };
    log(`[health] FAIL: ${result.error}`);
    return result;
  }
  
  // chromePath is required for puppeteer-core
  const chromePath = findChromePath();
  if (!chromePath) {
    const result = { 
      ok: false, 
      latencyMs: 0, 
      error: 'Chrome/Chromium not found. Install Chrome or set CHROME_PATH environment variable. On Ubuntu: apt-get install chromium-browser',
      systemInfo
    };
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
    const result = { ok: true, latencyMs, systemInfo };
    
    log(`[health] OK in ${latencyMs}ms`);
    return result;
    
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const result = { ok: false, latencyMs, error: err.message, systemInfo };
    
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
  getSystemInfo,
  // Export helpers for testing
  normalizeTeamName,
  normalizeForComparison,
  teamNameSimilarity,
  scoreCandidate,
  buildSearchUrls,
  findChromePath,
  BASE_URL,
  SCORE_THRESHOLD,
  DEBUG
};
