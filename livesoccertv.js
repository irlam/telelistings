// livesoccertv.js
// DEPRECATED: This file is kept for reference only.
// Actual LiveSoccerTV scraping is now performed by the remote VPS service.
// Use scrapers/lstv.js to call the remote service.
/**
 * Telegram Sports TV Bot – LiveSoccerTV Reference Module (DEPRECATED)
 *
 * NOTE: This module is DEPRECATED and kept for reference purposes only.
 * 
 * LiveSoccerTV scraping is now handled by a remote VPS service to avoid
 * running Puppeteer/Chrome on the Plesk production server. This improves:
 * - Server resource usage (no Chrome browser running on Plesk)
 * - Reliability (dedicated scraping infrastructure)
 * - Maintenance (scraping code isolated from main application)
 *
 * For actual LiveSoccerTV data fetching, use:
 *   const lstv = require('./scrapers/lstv');
 *   const result = await lstv.fetchLSTV({ home, away, date });
 *
 * The remote VPS service URL is configured via environment variables:
 *   - LSTV_SCRAPER_URL: Base URL of the scraper service
 *   - LSTV_SCRAPER_KEY: API key for authentication
 *
 * This file contains HTTP-based scraping utilities that could be used
 * as fallback methods on the VPS if browser automation fails.
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

// ---------- HTTP Scraper (reference implementation) ----------

/**
 * Fetch a page with realistic browser headers.
 * This is a reference implementation for the VPS service.
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
 * Parse TV channels from a match page HTML.
 * This is a reference implementation for the VPS service.
 * @param {string} html - Match page HTML
 * @returns {Array<{region: string, channel: string}>}
 */
function parseTvChannels(html) {
  const $ = cheerio.load(html);
  const tvByRegion = [];

  // LiveSoccerTV lists TV channels in a table with country flags and channel names
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
    
    channelCell.find('a, span').each((j, el) => {
      const channelName = $(el).text().trim();
      if (channelName && !channels.includes(channelName)) {
        channels.push(channelName);
      }
    });
    
    if (!channels.length) {
      const rawText = channelCell.text().trim();
      if (rawText) {
        channels.push(rawText);
      }
    }

    if (region && channels.length) {
      for (const channel of channels) {
        tvByRegion.push({
          region: cleanRegionName(region),
          channel: channel
        });
      }
    }
  });

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
    .replace(/^UK$/i, 'United Kingdom')
    .replace(/^USA?$/i, 'United States')
    .replace(/^CA$/i, 'Canada')
    .replace(/^AU$/i, 'Australia');
}

/**
 * Fetch TV channels for a specific match page URL.
 * This is a reference implementation for the VPS service.
 * @param {string} matchUrl - Full URL to the match page on LiveSoccerTV
 * @returns {Promise<{homeTeam: string, awayTeam: string, tvByRegion: Array<{region: string, channel: string}>}>}
 */
async function getMatchTvChannels(matchUrl) {
  if (!matchUrl) {
    return { homeTeam: '', awayTeam: '', tvByRegion: [] };
  }

  const cached = readCache(matchUrl);
  if (cached) {
    console.log(`[LiveSoccerTV] Using cached data for ${matchUrl}`);
    return cached;
  }

  try {
    console.log(`[LiveSoccerTV] Fetching match page: ${matchUrl}`);
    const html = await fetchPage(matchUrl);
    const $ = cheerio.load(html);

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
    console.log(`[LiveSoccerTV] Error fetching match page: ${err.message}`);
    return { homeTeam: '', awayTeam: '', tvByRegion: [] };
  }
}

// ---------- Main API Functions (reference implementation) ----------

/**
 * Find and get TV channels for a match by team names and date.
 * DEPRECATED: Use scrapers/lstv.js fetchLSTV() instead for production use.
 * 
 * @param {string} homeTeam - Home team name
 * @param {string} awayTeam - Away team name
 * @param {Date|string} matchDate - Match date
 * @param {Object} options - Options
 * @returns {Promise<{tvByRegion: Array<{region: string, channel: string}>, source: string}>}
 */
async function getTvChannelsForMatch(homeTeam, awayTeam, matchDate, options = {}) {
  console.warn('[LiveSoccerTV] DEPRECATED: Use scrapers/lstv.js fetchLSTV() instead');
  
  if (!homeTeam || !awayTeam) {
    return { tvByRegion: [], source: 'none' };
  }

  const cacheKey = getMatchCacheKey(homeTeam, awayTeam, matchDate);
  const cached = readCache(cacheKey);
  if (cached) {
    console.log(`[LiveSoccerTV] Using cached TV data for ${homeTeam} vs ${awayTeam}`);
    return cached;
  }

  const normalizeForUrl = (name) => name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  
  const homeSlug = normalizeForUrl(homeTeam);
  const awaySlug = normalizeForUrl(awayTeam);
  
  const possibleUrls = [
    `${BASE_URL}/match/${homeSlug}-vs-${awaySlug}/`,
    `${BASE_URL}/match/${homeSlug}-v-${awaySlug}/`
  ];

  let result = { tvByRegion: [], source: 'livesoccertv' };
  
  for (const url of possibleUrls) {
    try {
      result = await getMatchTvChannels(url);
      if (result.tvByRegion && result.tvByRegion.length > 0) {
        break;
      }
    } catch (err) {
      continue;
    }
  }

  if (result.tvByRegion && result.tvByRegion.length > 0) {
    writeCache(cacheKey, result);
  }

  return result;
}

/**
 * Enrich a fixture object with TV channel information.
 * DEPRECATED: Use the TV aggregator in aggregators/tv_channels.js instead.
 * 
 * @param {Object} fixture - Fixture object with homeTeam, awayTeam, date/start
 * @param {Object} options - Options
 * @returns {Promise<Object>} Fixture with tvByRegion populated
 */
async function enrichFixtureWithTvInfo(fixture, options = {}) {
  console.warn('[LiveSoccerTV] DEPRECATED: Use aggregators/tv_channels.js getTvDataForFixture() instead');
  
  if (!fixture) {
    return fixture;
  }

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
    console.log(`[LiveSoccerTV] Warning: Could not enrich fixture: ${err.message}`);
  }

  return fixture;
}

/**
 * Batch enrich multiple fixtures with TV info.
 * DEPRECATED: Use the TV aggregator instead.
 * 
 * @param {Array<Object>} fixtures - Array of fixture objects
 * @param {Object} options - Options
 * @returns {Promise<Array<Object>>} Enriched fixtures
 */
async function enrichFixturesWithTvInfo(fixtures, options = {}) {
  console.warn('[LiveSoccerTV] DEPRECATED: Use aggregators/tv_channels.js instead');
  
  const { delayMs = 1000 } = options;
  
  if (!fixtures || !fixtures.length) {
    return fixtures || [];
  }

  const enriched = [];
  
  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i];
    const enrichedFixture = await enrichFixtureWithTvInfo(fixture, options);
    enriched.push(enrichedFixture);
    
    if (i < fixtures.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  return enriched;
}

/**
 * Search for a team's upcoming matches on LiveSoccerTV.
 * This is a reference implementation for the VPS service.
 * @param {string} teamName - Team name to search for
 * @returns {Promise<Array>}
 */
async function searchTeamMatches(teamName) {
  if (!teamName) {
    return [];
  }

  const searchSlug = teamName.toLowerCase().trim().replace(/\s+/g, '-');
  const countryPaths = ['england', 'spain', 'germany', 'italy', 'france', 'scotland', 'wales'];
  
  for (const country of countryPaths) {
    const searchUrl = `${BASE_URL}/teams/${country}/${searchSlug}/`;

    try {
      const html = await fetchPage(searchUrl);
      const $ = cheerio.load(html);

      const matches = [];

      $('table.schedules tbody tr').each((i, row) => {
        const $row = $(row);
        const matchLink = $row.find('a[href*="/match/"]').first();
        
        if (matchLink.length) {
          const url = BASE_URL + matchLink.attr('href');
          const matchText = matchLink.text().trim();
          
          const vsMatch = matchText.match(/^(.+?)\s+(?:vs?\.?|–|-)\s+(.+)$/i);
          let homeTeam = '';
          let awayTeam = '';
          
          if (vsMatch) {
            homeTeam = vsMatch[1].trim();
            awayTeam = vsMatch[2].trim();
          }

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

      if (matches.length > 0) {
        return matches;
      }
    } catch (err) {
      continue;
    }
  }

  console.log(`[LiveSoccerTV] No team page found for "${teamName}" in any league`);
  return [];
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
// NOTE: These functions are DEPRECATED for direct use on Plesk.
// Use scrapers/lstv.js for production LiveSoccerTV data fetching.

module.exports = {
  // Main API (DEPRECATED - use scrapers/lstv.js instead)
  getTvChannelsForMatch,
  enrichFixtureWithTvInfo,
  enrichFixturesWithTvInfo,
  
  // Lower-level functions (reference implementations for VPS)
  searchTeamMatches,
  getMatchTvChannels,
  parseTvChannels,
  fetchPage,
  
  // Utilities
  clearCache,
  getMatchCacheKey,
  
  // Constants
  BASE_URL,
  CACHE_TTL_MS
};
