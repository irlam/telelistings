// scrapers/wiki_broadcasters.js
// Wikipedia broadcaster scraper for football league TV rights information.
// NOTE: This is an HTTP scraper that runs directly on Plesk (no Puppeteer needed).
/**
 * Telegram Sports TV Bot – Wikipedia Broadcaster Scraper
 *
 * This is a lightweight HTTP scraper that can run directly on Plesk.
 * No browser automation required – uses axios + cheerio for HTML parsing.
 *
 * Exports fetchWikiBroadcasters({ leagueName, season, country }) which:
 * - Fetches Wikipedia pages for league broadcasting info
 * - Parses "Broadcasting" or "Television broadcasters" tables
 * - Returns region/channel pairs
 *
 * Returns:
 * {
 *   sourceUrl: string | null,
 *   broadcasters: [{ region: string, channel: string }, ...]
 * }
 *
 * Never throws; on failure returns { broadcasters: [] }
 * All logs use prefix [WIKI]
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------

const WIKI_BASE_URL = 'https://en.wikipedia.org';
const DEFAULT_TIMEOUT = 15000;

// In-memory cache to avoid refetching within the same process
// Key: "leagueName:season" -> { data, timestamp }
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache

// User agent for Wikipedia requests (be polite)
const USER_AGENT = 'TelegramSportsBot/1.0 (https://telegram.defecttracker.uk/; contact@defecttracker.uk) axios/1.x';

// ---------- Logging ----------

/**
 * Log a message with [WIKI] prefix.
 * @param {string} msg - Message to log
 */
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [WIKI] ${msg}`;
  console.log(line);
  
  // Also append to autopost.log for visibility in /admin/logs
  try {
    const logPath = path.join(__dirname, '..', 'autopost.log');
    fs.appendFileSync(logPath, line + '\n', 'utf8');
  } catch (err) {
    // Ignore file errors
  }
}

// ---------- League Name Mapping ----------

// Map common league names to Wikipedia article patterns
const LEAGUE_PATTERNS = {
  // English leagues
  'premier league': '{season} Premier League',
  'english premier league': '{season} Premier League',
  'epl': '{season} Premier League',
  'championship': '{season} EFL Championship',
  'efl championship': '{season} EFL Championship',
  'league one': '{season} EFL League One',
  'efl league one': '{season} EFL League One',
  'league two': '{season} EFL League Two',
  'efl league two': '{season} EFL League Two',
  'fa cup': '{season} FA Cup',
  'efl cup': '{season} EFL Cup',
  'carabao cup': '{season} EFL Cup',
  'league cup': '{season} EFL Cup',
  
  // Scottish leagues
  'scottish premiership': '{season} Scottish Premiership',
  'spfl premiership': '{season} Scottish Premiership',
  'scottish championship': '{season} Scottish Championship',
  
  // European competitions
  'champions league': '{season} UEFA Champions League',
  'uefa champions league': '{season} UEFA Champions League',
  'europa league': '{season} UEFA Europa League',
  'uefa europa league': '{season} UEFA Europa League',
  'conference league': '{season} UEFA Europa Conference League',
  'uefa conference league': '{season} UEFA Europa Conference League',
  
  // Other major leagues
  'la liga': '{season} La Liga',
  'bundesliga': '{season} Bundesliga',
  'serie a': '{season} Serie A',
  'ligue 1': '{season} Ligue 1'
};

/**
 * Get the current football season string (e.g., "2024–25").
 * Football seasons typically run Aug-May, so:
 * - Jan-Jul = previous year to current year (e.g., 2024–25 in May 2025)
 * - Aug-Dec = current year to next year (e.g., 2024–25 in Oct 2024)
 * @param {Date} [date] - Optional date to determine season
 * @returns {string} Season string like "2024–25"
 */
function getCurrentSeason(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed
  
  // Aug (7) through Dec (11) = new season starting this year
  // Jan (0) through Jul (6) = season that started last year
  if (month >= 7) {
    return `${year}–${String(year + 1).slice(-2)}`;
  } else {
    return `${year - 1}–${String(year).slice(-2)}`;
  }
}

/**
 * Build Wikipedia article title for a league/season.
 * @param {string} leagueName - League name
 * @param {string} season - Season string (e.g., "2024–25")
 * @returns {string|null} Wikipedia article title or null
 */
function buildWikiTitle(leagueName, season) {
  if (!leagueName) return null;
  
  const normalized = leagueName.toLowerCase().trim();
  
  // Check if we have a pattern for this league
  for (const [key, pattern] of Object.entries(LEAGUE_PATTERNS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return pattern.replace('{season}', season);
    }
  }
  
  // Fallback: try "{season} {LeagueName}" format
  // Capitalize each word
  const titleCase = leagueName
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
  
  return `${season} ${titleCase}`;
}

/**
 * Build Wikipedia URL for an article title.
 * @param {string} title - Article title
 * @returns {string} Full Wikipedia URL
 */
function buildWikiUrl(title) {
  // Replace spaces with underscores for URL
  const urlTitle = encodeURIComponent(title.replace(/ /g, '_'));
  return `${WIKI_BASE_URL}/wiki/${urlTitle}`;
}

// ---------- HTML Parsing ----------

/**
 * Fetch a Wikipedia page.
 * @param {string} url - Wikipedia URL
 * @returns {Promise<string>} HTML content
 */
async function fetchPage(url) {
  const response = await axios.get(url, {
    timeout: DEFAULT_TIMEOUT,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  return response.data;
}

/**
 * Parse broadcaster information from a Wikipedia page.
 * Looks for tables with broadcasting/TV information.
 * @param {string} html - HTML content
 * @returns {Array<{region: string, channel: string}>}
 */
function parseBroadcasters(html) {
  const $ = cheerio.load(html);
  const broadcasters = [];
  
  // Strategy 1: Look for "Broadcasting" or "Television" sections
  // and parse infobox or tables within
  
  // Find the broadcasting/television section
  const sectionHeaders = ['Broadcasting', 'Television', 'TV broadcasting', 'Broadcasters', 'Media coverage'];
  
  let broadcastSection = null;
  
  // Look for section headers (h2, h3 with these titles)
  $('h2, h3').each((i, el) => {
    const headerText = $(el).find('.mw-headline').text().trim();
    for (const target of sectionHeaders) {
      if (headerText.toLowerCase().includes(target.toLowerCase())) {
        broadcastSection = el;
        return false; // break
      }
    }
  });
  
  // Strategy 2: Parse tables after the broadcast section
  if (broadcastSection) {
    // Get all tables following this section header until next h2
    let nextEl = $(broadcastSection).next();
    while (nextEl.length && !nextEl.is('h2')) {
      if (nextEl.is('table') || nextEl.find('table').length) {
        const table = nextEl.is('table') ? nextEl : nextEl.find('table').first();
        const rows = parseTableRows($, table);
        broadcasters.push(...rows);
      }
      nextEl = nextEl.next();
    }
  }
  
  // Strategy 3: Look for infobox with TV/broadcasting info
  const infobox = $('.infobox, .infobox-body, .vcard');
  infobox.find('tr').each((i, row) => {
    const $row = $(row);
    const header = $row.find('th').text().toLowerCase();
    
    if (header.includes('television') || header.includes('broadcaster') || header.includes('tv')) {
      const value = $row.find('td').text().trim();
      if (value) {
        // Try to split by common separators
        const channels = value.split(/[,;]|\band\b/i).map(s => s.trim()).filter(Boolean);
        for (const channel of channels) {
          broadcasters.push({
            region: 'Unknown',
            channel: cleanChannelName(channel)
          });
        }
      }
    }
  });
  
  // Strategy 4: Look for any table with "Country" or "Region" and "Broadcaster" columns
  $('table.wikitable, table.sortable').each((i, table) => {
    const $table = $(table);
    const headers = [];
    
    $table.find('tr').first().find('th').each((j, th) => {
      headers.push($(th).text().toLowerCase().trim());
    });
    
    // Check if this looks like a broadcaster table
    const hasRegionCol = headers.some(h => 
      h.includes('country') || h.includes('region') || h.includes('territory') || h.includes('nation')
    );
    const hasBroadcasterCol = headers.some(h => 
      h.includes('broadcaster') || h.includes('channel') || h.includes('network') || h.includes('rights')
    );
    
    if (hasRegionCol && hasBroadcasterCol) {
      const regionIdx = headers.findIndex(h => 
        h.includes('country') || h.includes('region') || h.includes('territory') || h.includes('nation')
      );
      const broadcasterIdx = headers.findIndex(h => 
        h.includes('broadcaster') || h.includes('channel') || h.includes('network') || h.includes('rights')
      );
      
      $table.find('tr').slice(1).each((j, row) => {
        const cells = $(row).find('td, th');
        if (cells.length > Math.max(regionIdx, broadcasterIdx)) {
          const region = $(cells[regionIdx]).text().trim();
          const channel = $(cells[broadcasterIdx]).text().trim();
          
          if (region && channel) {
            // Channel cell might have multiple broadcasters
            const channels = channel.split(/\n|,|;/).map(s => s.trim()).filter(Boolean);
            for (const ch of channels) {
              broadcasters.push({
                region: cleanRegionName(region),
                channel: cleanChannelName(ch)
              });
            }
          }
        }
      });
    }
  });
  
  // Deduplicate
  const seen = new Set();
  const unique = [];
  for (const b of broadcasters) {
    const key = `${b.region}|${b.channel}`;
    if (!seen.has(key) && b.channel) {
      seen.add(key);
      unique.push(b);
    }
  }
  
  return unique;
}

/**
 * Parse rows from a generic Wikipedia table.
 * @param {CheerioStatic} $ - Cheerio instance
 * @param {Cheerio} table - Table element
 * @returns {Array<{region: string, channel: string}>}
 */
function parseTableRows($, table) {
  const results = [];
  const $table = $(table);
  
  $table.find('tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length >= 2) {
      const region = $(cells[0]).text().trim();
      const channel = $(cells[1]).text().trim();
      
      if (region && channel) {
        results.push({
          region: cleanRegionName(region),
          channel: cleanChannelName(channel)
        });
      }
    }
  });
  
  return results;
}

/**
 * Clean a region/country name.
 * @param {string} region
 * @returns {string}
 */
function cleanRegionName(region) {
  return (region || '')
    .replace(/\[.*?\]/g, '') // Remove citation references [1], [2], etc.
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean a channel/broadcaster name.
 * @param {string} channel
 * @returns {string}
 */
function cleanChannelName(channel) {
  return (channel || '')
    .replace(/\[.*?\]/g, '') // Remove citation references
    .replace(/\(.*?\)/g, '') // Remove parenthetical notes
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Main Function ----------

/**
 * Fetch broadcaster information from Wikipedia for a league/season.
 *
 * @param {Object} params - Parameters
 * @param {string} params.leagueName - League name (e.g., "Premier League")
 * @param {string} [params.season] - Season string (e.g., "2024–25"), defaults to current
 * @param {string} [params.country] - Country filter (optional)
 * @returns {Promise<{sourceUrl: string|null, broadcasters: Array<{region: string, channel: string}>}>}
 */
async function fetchWikiBroadcasters({ leagueName, season = null, country = null }) {
  const emptyResult = {
    sourceUrl: null,
    broadcasters: []
  };
  
  if (!leagueName) {
    log('Missing league name');
    return emptyResult;
  }
  
  // Determine season
  const effectiveSeason = season || getCurrentSeason();
  
  // Check cache
  const cacheKey = `${leagueName.toLowerCase()}:${effectiveSeason}`;
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    log(`Using cached data for ${leagueName} ${effectiveSeason}`);
    return cached.data;
  }
  
  // Build Wikipedia title and URL
  const wikiTitle = buildWikiTitle(leagueName, effectiveSeason);
  if (!wikiTitle) {
    log(`Could not build Wikipedia title for: ${leagueName}`);
    return emptyResult;
  }
  
  const wikiUrl = buildWikiUrl(wikiTitle);
  log(`Fetching: ${wikiTitle}`);
  
  try {
    const html = await fetchPage(wikiUrl);
    let broadcasters = parseBroadcasters(html);
    
    // Filter by country if specified
    if (country && broadcasters.length > 0) {
      const countryLower = country.toLowerCase();
      const filtered = broadcasters.filter(b => {
        const regionLower = b.region.toLowerCase();
        // Match country or common variations
        return regionLower.includes(countryLower) ||
               (countryLower === 'uk' && (regionLower.includes('united kingdom') || regionLower.includes('britain'))) ||
               (countryLower === 'usa' && (regionLower.includes('united states') || regionLower.includes('america')));
      });
      
      // Only use filtered if it has results, otherwise return all
      if (filtered.length > 0) {
        broadcasters = filtered;
      }
    }
    
    // Log summary
    if (broadcasters.length > 0) {
      const channelList = [...new Set(broadcasters.map(b => b.channel))].slice(0, 5).join(', ');
      const more = broadcasters.length > 5 ? ', ...' : '';
      log(`${leagueName} ${effectiveSeason}: broadcasters=${broadcasters.length} (${channelList}${more})`);
    } else {
      log(`${leagueName} ${effectiveSeason}: no broadcasters found`);
    }
    
    const result = {
      sourceUrl: wikiUrl,
      broadcasters
    };
    
    // Cache the result
    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    
    return result;
    
  } catch (err) {
    // Handle 404 (article not found) gracefully
    if (err.response && err.response.status === 404) {
      log(`Article not found: ${wikiTitle}`);
    } else {
      log(`Error fetching ${wikiTitle}: ${err.message}`);
    }
    return emptyResult;
  }
}

/**
 * Get unique channel names from broadcasters for a specific region.
 * @param {Array<{region: string, channel: string}>} broadcasters
 * @param {string} [region] - Optional region filter
 * @returns {string[]} Unique channel names
 */
function getUniqueChannels(broadcasters, region = null) {
  if (!broadcasters || !Array.isArray(broadcasters)) {
    return [];
  }
  
  let filtered = broadcasters;
  if (region) {
    const regionLower = region.toLowerCase();
    filtered = broadcasters.filter(b => 
      b.region.toLowerCase().includes(regionLower) ||
      (regionLower === 'uk' && (b.region.toLowerCase().includes('united kingdom') || b.region.toLowerCase().includes('britain')))
    );
  }
  
  return [...new Set(filtered.map(b => b.channel))].filter(Boolean);
}

/**
 * Clear the in-memory cache.
 */
function clearCache() {
  cache.clear();
}

// ---------- Module Exports ----------

module.exports = {
  fetchWikiBroadcasters,
  getUniqueChannels,
  clearCache,
  // Export helpers for testing
  getCurrentSeason,
  buildWikiTitle,
  buildWikiUrl,
  parseBroadcasters,
  cleanChannelName,
  cleanRegionName,
  LEAGUE_PATTERNS
};
