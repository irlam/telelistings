// scrapers/livefootballontv.js
// LiveFootballOnTV scraper for UK TV channel information.
/**
 * Telegram Sports TV Bot – LiveFootballOnTV Scraper
 *
 * Exports fetchLFOTVFixtures({ teamName }) which:
 * - Scrapes https://www.live-footballontv.com/
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
 *
 * Never throws; on failure returns { fixtures: [] } and logs warning.
 * All logs use prefix [LFOTV]
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------

const BASE_URL = 'https://www.live-footballontv.com';
const DEFAULT_TIMEOUT = 15000;

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

// ---------- Logging ----------

/**
 * Log a message with [LFOTV] prefix.
 * @param {string} msg - Message to log
 */
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [LFOTV] ${msg}`;
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
  
  for (const channel of UK_CHANNELS) {
    if (textLower.includes(channel.toLowerCase())) {
      channels.push(channel);
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

/**
 * Parse a date string from the page.
 * @param {string} dateStr - Date string from the page
 * @returns {Date|null} Parsed date or null
 */
function parseDateString(dateStr) {
  if (!dateStr) return null;
  
  try {
    // Try ISO format first
    const isoDate = new Date(dateStr);
    if (!isNaN(isoDate.getTime())) {
      return isoDate;
    }
    
    // Try UK date format (DD/MM/YYYY or DD-MM-YYYY)
    const ukMatch = dateStr.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (ukMatch) {
      const [, day, month, year] = ukMatch;
      return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    }
    
    return null;
  } catch (err) {
    return null;
  }
}

// ---------- Main Function ----------

/**
 * Fetch fixtures from LiveFootballOnTV.
 *
 * @param {Object} params - Parameters
 * @param {string} [params.teamName] - Team name to filter fixtures (optional)
 * @param {string} [params.competition] - Competition to filter (optional)
 * @returns {Promise<{fixtures: Array<{home: string, away: string, kickoffUtc: string|null, competition: string|null, channels: string[]}>}>}
 */
async function fetchLFOTVFixtures({ teamName, competition }) {
  const emptyResult = { fixtures: [] };
  
  log(`Fetching fixtures${teamName ? ` for ${teamName}` : ''}`);
  
  try {
    const response = await axios.get(BASE_URL, {
      timeout: DEFAULT_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9'
      }
    });
    
    const $ = cheerio.load(response.data);
    const fixtures = [];
    
    // Parse fixture rows - the site typically uses table rows
    const rowSelectors = [
      'table tr',
      '.fixture-row',
      '.match-row',
      '[class*="fixture"]',
      '[class*="match"]'
    ];
    
    for (const selector of rowSelectors) {
      $(selector).each((i, el) => {
        try {
          const $row = $(el);
          const text = $row.text();
          const textLower = text.toLowerCase();
          
          // Skip header rows
          if ($row.find('th').length > 0) return;
          
          // Look for match pattern (Team vs Team or Team v Team)
          const vsMatch = text.match(/([A-Za-z\s\-'\.]+)\s+(?:v|vs|versus)\s+([A-Za-z\s\-'\.]+)/i);
          if (!vsMatch) return;
          
          let homeTeam = vsMatch[1].trim();
          let awayTeam = vsMatch[2].trim();
          
          // Clean up team names (remove time/channel info that might be captured)
          homeTeam = homeTeam.replace(/\d{1,2}[:\.]?\d{0,2}\s*(am|pm)?/gi, '').trim();
          awayTeam = awayTeam.replace(/Sky Sports|TNT Sports|BBC|ITV|Amazon/gi, '').trim();
          
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
          const timeEl = $row.find('time, [datetime]');
          if (timeEl.length) {
            kickoffUtc = timeEl.attr('datetime') || null;
          }
          
          // Try to parse time from text (e.g., "3:00pm", "15:00")
          if (!kickoffUtc) {
            const timeMatch = text.match(/(\d{1,2})[:\.](\d{2})\s*(am|pm)?/i);
            if (timeMatch) {
              // Just store as a note - can't determine full date
              // The aggregator will use other sources for precise time
            }
          }
          
          // Extract competition
          let comp = $row.find('[class*="competition"], [class*="league"]').text().trim() || null;
          
          // Check parent or sibling for competition
          if (!comp) {
            const parentSection = $row.closest('section, .competition-section, [class*="league"]');
            comp = parentSection.find('h2, h3, .section-title').first().text().trim() || null;
          }
          
          // Filter by competition if specified
          if (competition && comp) {
            if (!comp.toLowerCase().includes(competition.toLowerCase())) {
              return;
            }
          }
          
          // Extract TV channels
          const channels = extractChannels(text);
          
          // Also check specific channel cells/elements
          $row.find('[class*="channel"], [class*="tv"], img[alt]').each((j, chEl) => {
            const chText = $(chEl).text() || $(chEl).attr('alt') || '';
            channels.push(...extractChannels(chText));
          });
          
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
          // Skip malformed rows
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
 * Perform a health check on LiveFootballOnTV.
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
  fetchLFOTVFixtures,
  healthCheck,
  extractChannels,
  normalizeTeamName,
  UK_CHANNELS,
  BASE_URL
};
