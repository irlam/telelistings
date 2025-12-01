// scrapers/tnt.js
// TNT Sports fixtures scraper with TV channel information.
// NOTE: This is an HTTP scraper that runs directly on Plesk (no Puppeteer needed).
/**
 * Telegram Sports TV Bot – TNT Sports Fixtures Scraper
 *
 * This is a lightweight HTTP scraper that can run directly on Plesk.
 * No browser automation required – uses axios + cheerio for HTML parsing.
 *
 * Exports fetchTNTFixtures({ teamName }) which:
 * - Fetches TNT Sports fixtures pages
 * - Parses fixture list with TV channels
 *
 * Returns:
 * {
 *   fixtures: Array<{
 *     home: string,
 *     away: string,
 *     kickoffUtc: string | null,
 *     competition: string | null,
 *     channels: string[]   // e.g. ["TNT Sports 1", "TNT Sports 2"]
 *   }>
 * }
 *
 * Never throws; on failure returns { fixtures: [] } and logs warning.
 * All logs use prefix [TNT]
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------

const BASE_URL = 'https://www.tntsports.co.uk';
// Updated URL - TNT Sports has multiple possible schedule pages
const SCHEDULE_URL = `${BASE_URL}/football/calendar-results.shtml`;
// Backup URLs to try
const BACKUP_SCHEDULE_URLS = [
  `${BASE_URL}/football/blog/2024/calendar-results.shtml`,
  `${BASE_URL}/football/2024-25/calendar-results.shtml`
];
const DEFAULT_TIMEOUT = 15000;

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

// ---------- Logging ----------

/**
 * Log a message with [TNT] prefix.
 * @param {string} msg - Message to log
 */
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [TNT] ${msg}`;
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
  
  for (const channel of TNT_CHANNELS) {
    if (textLower.includes(channel.toLowerCase())) {
      channels.push(channel);
    }
  }
  
  // Also look for patterns like "TNT Sports 1" or "TNT Sports Ultimate"
  const tntMatch = text.match(/TNT Sports\s*(\d+|Ultimate)?/gi);
  if (tntMatch) {
    for (const match of tntMatch) {
      const cleaned = match.trim();
      if (!channels.includes(cleaned)) {
        channels.push(cleaned);
      }
    }
  }
  
  // Check for BT Sport (legacy name, now TNT Sports)
  if (textLower.includes('bt sport')) {
    const btMatch = text.match(/BT Sport\s*(\d+)?/gi);
    if (btMatch) {
      for (const match of btMatch) {
        // Convert BT Sport to TNT Sports
        const converted = match.replace(/BT Sport/i, 'TNT Sports');
        if (!channels.includes(converted)) {
          channels.push(converted);
        }
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
 * Fetch fixtures from TNT Sports.
 *
 * @param {Object} params - Parameters
 * @param {string} [params.teamName] - Team name to filter fixtures (optional)
 * @param {string} [params.competition] - Competition to filter (optional)
 * @returns {Promise<{fixtures: Array<{home: string, away: string, kickoffUtc: string|null, competition: string|null, channels: string[]}>}>}
 */
async function fetchTNTFixtures({ teamName, competition }) {
  const emptyResult = { fixtures: [] };
  
  log(`Fetching fixtures${teamName ? ` for ${teamName}` : ''}`);
  
  // Try main URL first, then backup URLs
  const urlsToTry = [SCHEDULE_URL, ...BACKUP_SCHEDULE_URLS];
  
  for (const url of urlsToTry) {
    try {
      const result = await fetchFixturesFromUrl(url, { teamName, competition });
      if (result.fixtures.length > 0) {
        return result;
      }
    } catch (err) {
      // Try next URL
      continue;
    }
  }
  
  return emptyResult;
}

/**
 * Fetch fixtures from a specific URL.
 * @private
 */
async function fetchFixturesFromUrl(url, { teamName, competition }) {
  const emptyResult = { fixtures: [] };
  
  try {
    const response = await axios.get(url, {
      timeout: DEFAULT_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9'
      }
    });
    
    const $ = cheerio.load(response.data);
    const fixtures = [];
    
    // Parse fixture elements - TNT Sports uses various formats (updated for 2024-2025 structure)
    const fixtureSelectors = [
      '.schedule-item',
      '.event-item',
      '[class*="fixture"]',
      '[class*="match"]',
      '.programme-item',
      // TNT Sports 2024-2025 selectors
      '[class*="Result"]',
      '[class*="Event"]',
      '[class*="Calendar"]',
      'tr[class*="result"]',
      '.calres',
      // Additional selectors
      '[class*="Match"]',
      '[class*="Game"]',
      '[class*="Schedule"]',
      'li[class*="event"]',
      'article[class*="fixture"]',
      '.tv-schedule-item',
      '.broadcast-item',
      '[data-event-id]'
    ];
    
    for (const selector of fixtureSelectors) {
      $(selector).each((i, el) => {
        try {
          const $fixture = $(el);
          const text = $fixture.text();
          
          // Skip non-football content
          const textLower = text.toLowerCase();
          if (!textLower.includes('football') && 
              !textLower.includes('premier league') && 
              !textLower.includes('champions league') &&
              !textLower.includes('europa league') &&
              !textLower.includes('fa cup') &&
              !textLower.includes('efl') &&
              !textLower.includes('uefa') &&
              !textLower.includes('league')) {
            // Check if it looks like a football match (contains "v" or "vs")
            if (!textLower.match(/\b(v|vs)\b/)) {
              return;
            }
          }
          
          // Extract teams
          let homeTeam = '';
          let awayTeam = '';
          
          // Try specific selectors first
          homeTeam = $fixture.find('[class*="home"], .team-home').first().text().trim();
          awayTeam = $fixture.find('[class*="away"], .team-away').first().text().trim();
          
          // Try team name links
          if (!homeTeam || !awayTeam) {
            const teamLinks = $fixture.find('a[href*="team"], .team-name, [class*="TeamName"]');
            if (teamLinks.length >= 2) {
              homeTeam = $(teamLinks[0]).text().trim();
              awayTeam = $(teamLinks[1]).text().trim();
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
          
          // Filter by competition if specified
          if (competition && comp) {
            if (!comp.toLowerCase().includes(competition.toLowerCase())) {
              return;
            }
          }
          
          // Extract TV channels from text
          const channels = extractChannels(text);
          
          // Also check for channel indicator elements
          const channelIndicator = $fixture.find('[class*="channel"], [class*="broadcast"]').text();
          if (channelIndicator) {
            channels.push(...extractChannels(channelIndicator));
          }
          
          // Default to TNT Sports if no specific channel found but it's on TNT schedule
          if (channels.length === 0) {
            channels.push('TNT Sports');
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
 * Perform a health check on TNT Sports.
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
  fetchTNTFixtures,
  healthCheck,
  extractChannels,
  normalizeTeamName,
  TNT_CHANNELS,
  BASE_URL
};
