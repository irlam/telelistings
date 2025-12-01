// scrapers/skysports.js
// Sky Sports fixtures scraper with TV channel information.
// NOTE: This is an HTTP scraper that runs directly on Plesk (no Puppeteer needed).
/**
 * Telegram Sports TV Bot – Sky Sports Fixtures Scraper
 *
 * This is a lightweight HTTP scraper that can run directly on Plesk.
 * No browser automation required – uses axios + cheerio for HTML parsing.
 *
 * Exports fetchSkyFixtures({ teamName }) which:
 * - Fetches Sky Sports fixtures pages
 * - Parses fixture list with TV channels
 *
 * Returns:
 * {
 *   fixtures: Array<{
 *     home: string,
 *     away: string,
 *     kickoffUtc: string | null,
 *     competition: string | null,
 *     channels: string[]   // e.g. ["Sky Sports Main Event", "Sky Sports Premier League"]
 *   }>
 * }
 *
 * Never throws; on failure returns { fixtures: [] } and logs warning.
 * All logs use prefix [SKY]
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------

const BASE_URL = 'https://www.skysports.com';
const FIXTURES_URL = `${BASE_URL}/football/fixtures`;
const DEFAULT_TIMEOUT = 15000;

// Known Sky Sports channel names
const SKY_CHANNELS = [
  'Sky Sports Main Event',
  'Sky Sports Premier League',
  'Sky Sports Football',
  'Sky Sports Arena',
  'Sky Sports Action',
  'Sky Sports Mix',
  'Sky Sports News',
  'Sky Sports+'
];

// ---------- Logging ----------

/**
 * Log a message with [SKY] prefix.
 * @param {string} msg - Message to log
 */
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [SKY] ${msg}`;
  console.log(line);
  
  try {
    const logPath = path.join(__dirname, '..', 'autopost.log');
    fs.appendFileSync(logPath, line + '\n', 'utf8');
  } catch (err) {
    // Ignore file errors
  }
}

// ---------- Helpers ----------

/**
 * Extract channel names from text.
 * @param {string} text - Text that may contain channel names
 * @returns {string[]} Array of channel names found
 */
function extractChannels(text) {
  if (!text) return [];
  
  const channels = [];
  const textLower = text.toLowerCase();
  
  // Check against known Sky Sports channels
  for (const channel of SKY_CHANNELS) {
    if (textLower.includes(channel.toLowerCase())) {
      channels.push(channel);
    }
  }
  
  // Only add additional channels found via regex if they look like valid channel names
  // Pattern matches "Sky Sports" followed by common channel qualifiers
  const validQualifiers = /^Sky Sports\s+(Main Event|Premier League|Football|Arena|Action|Mix|News|\+|\d+)$/i;
  const skyMatch = text.match(/Sky Sports\s+[A-Za-z0-9+]+(?:\s+[A-Za-z]+)?/gi);
  if (skyMatch) {
    for (const match of skyMatch) {
      const cleaned = match.trim();
      // Only add if not already in channels and looks like a valid channel name
      if (!channels.includes(cleaned) && validQualifiers.test(cleaned)) {
        channels.push(cleaned);
      }
    }
  }
  
  return channels;
}

/**
 * Normalize team name for comparison.
 * @param {string} name - Team name
 * @returns {string} Normalized name
 */
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

/**
 * Fetch fixtures from Sky Sports.
 *
 * @param {Object} params - Parameters
 * @param {string} [params.teamName] - Team name to filter fixtures (optional)
 * @param {string} [params.competition] - Competition to filter (optional)
 * @returns {Promise<{fixtures: Array<{home: string, away: string, kickoffUtc: string|null, competition: string|null, channels: string[]}>}>}
 */
async function fetchSkyFixtures({ teamName, competition }) {
  const emptyResult = { fixtures: [] };
  
  log(`Fetching fixtures${teamName ? ` for ${teamName}` : ''}`);
  
  try {
    const response = await axios.get(FIXTURES_URL, {
      timeout: DEFAULT_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9'
      }
    });
    
    const $ = cheerio.load(response.data);
    const fixtures = [];
    
    // Parse fixture elements - Sky Sports uses various formats
    const fixtureSelectors = [
      '.fixres__item',
      '.fixture',
      '[class*="fixture"]',
      '.match-row'
    ];
    
    for (const selector of fixtureSelectors) {
      $(selector).each((i, el) => {
        try {
          const $fixture = $(el);
          const text = $fixture.text();
          
          // Extract teams
          let homeTeam = '';
          let awayTeam = '';
          
          // Try specific selectors first
          homeTeam = $fixture.find('[class*="home"], .team-home, .fixres__team--home').first().text().trim();
          awayTeam = $fixture.find('[class*="away"], .team-away, .fixres__team--away').first().text().trim();
          
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
          if (teamName) {
            const teamNormalized = normalizeTeamName(teamName);
            const homeNormalized = normalizeTeamName(homeTeam);
            const awayNormalized = normalizeTeamName(awayTeam);
            
            const matchesTeam = homeNormalized.includes(teamNormalized) ||
                               awayNormalized.includes(teamNormalized) ||
                               teamNormalized.includes(homeNormalized) ||
                               teamNormalized.includes(awayNormalized);
            
            if (!matchesTeam) return;
          }
          
          // Extract kickoff time
          let kickoffUtc = null;
          const timeEl = $fixture.find('time, [datetime]');
          if (timeEl.length) {
            kickoffUtc = timeEl.attr('datetime') || null;
          }
          
          // Extract competition
          let comp = $fixture.find('[class*="competition"], [class*="tournament"]').text().trim() || null;
          if (!comp) {
            // Try to find from parent/sibling elements
            comp = $fixture.closest('[class*="competition"]').find('h2, h3').first().text().trim() || null;
          }
          
          // Filter by competition if specified
          if (competition && comp) {
            if (!comp.toLowerCase().includes(competition.toLowerCase())) {
              return;
            }
          }
          
          // Extract TV channels from text
          const channels = extractChannels(text);
          
          // Also check for TV indicator elements
          const tvIndicator = $fixture.find('[class*="tv"], [class*="channel"], [class*="broadcast"]').text();
          if (tvIndicator) {
            channels.push(...extractChannels(tvIndicator));
          }
          
          // Deduplicate channels
          const uniqueChannels = [...new Set(channels)];
          
          fixtures.push({
            home: homeTeam,
            away: awayTeam,
            kickoffUtc,
            competition: comp,
            channels: uniqueChannels
          });
        } catch (parseErr) {
          // Skip malformed fixtures
        }
      });
      
      // If we found fixtures, stop trying other selectors
      if (fixtures.length > 0) break;
    }
    
    log(`Found ${fixtures.length} fixtures`);
    return { fixtures };
    
  } catch (err) {
    log(`Error fetching fixtures: ${err.message}`);
    return emptyResult;
  }
}

/**
 * Perform a health check on Sky Sports.
 * @returns {Promise<{ok: boolean, latencyMs: number, error?: string}>}
 */
async function healthCheck() {
  const startTime = Date.now();
  
  try {
    await axios.get(BASE_URL, {
      timeout: DEFAULT_TIMEOUT,
      headers: {
        'User-Agent': 'TelegramSportsBot/1.0'
      }
    });
    
    const latencyMs = Date.now() - startTime;
    log(`[health] OK in ${latencyMs}ms`);
    return { ok: true, latencyMs };
    
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    log(`[health] FAIL in ${latencyMs}ms: ${err.message}`);
    return { ok: false, latencyMs, error: err.message };
  }
}

// ---------- Module Exports ----------

module.exports = {
  fetchSkyFixtures,
  healthCheck,
  extractChannels,
  normalizeTeamName,
  SKY_CHANNELS,
  BASE_URL
};
