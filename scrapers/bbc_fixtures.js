// scrapers/bbc_fixtures.js
// BBC Sport fixtures scraper.
/**
 * Telegram Sports TV Bot – BBC Sport Fixtures Scraper
 *
 * Exports fetchBBCFixtures({ teamName, teamSlug }) which:
 * - Fetches BBC Sport team fixtures page
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
 *
 * Never throws; on failure returns { matches: [] } and logs warning.
 * All logs use prefix [BBC]
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------

const BASE_URL = 'https://www.bbc.co.uk/sport/football/teams';
const DEFAULT_TIMEOUT = 15000;

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

// ---------- Logging ----------

/**
 * Log a message with [BBC] prefix.
 * @param {string} msg - Message to log
 */
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [BBC] ${msg}`;
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
 * Get BBC slug for a team name.
 * @param {string} teamName - Team name
 * @returns {string|null} BBC slug or null
 */
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

/**
 * Fetch fixtures from BBC Sport for a team.
 *
 * @param {Object} params - Parameters
 * @param {string} [params.teamName] - Team name (will be converted to slug)
 * @param {string} [params.teamSlug] - Direct BBC team slug
 * @returns {Promise<{matches: Array<{home: string, away: string, kickoffUtc: string|null, competition: string|null}>}>}
 */
async function fetchBBCFixtures({ teamName, teamSlug }) {
  const emptyResult = { matches: [] };
  
  // Determine slug
  const slug = teamSlug || getTeamSlug(teamName);
  if (!slug) {
    log(`Could not determine BBC slug for: ${teamName}`);
    return emptyResult;
  }
  
  const url = `${BASE_URL}/${slug}/scores-fixtures`;
  log(`Fetching fixtures from: ${url}`);
  
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
    const matches = [];
    
    // Parse fixture cards - BBC uses various selectors
    // Try multiple selectors for robustness
    const fixtureSelectors = [
      '.sp-c-fixture',
      '[class*="fixture"]',
      '.qa-match-block',
      'article[class*="fixture"]'
    ];
    
    for (const selector of fixtureSelectors) {
      $(selector).each((i, el) => {
        try {
          const $fixture = $(el);
          
          // Extract teams
          const homeTeam = $fixture.find('[class*="home-team"], .sp-c-fixture__team--home, .sp-c-fixture__team-name--home').text().trim();
          const awayTeam = $fixture.find('[class*="away-team"], .sp-c-fixture__team--away, .sp-c-fixture__team-name--away').text().trim();
          
          // Extract time/date
          const timeEl = $fixture.find('time, [datetime]');
          let kickoffUtc = null;
          if (timeEl.length) {
            kickoffUtc = timeEl.attr('datetime') || null;
          }
          
          // Extract competition
          const competition = $fixture.find('[class*="competition"], [class*="tournament"]').text().trim() || null;
          
          if (homeTeam && awayTeam) {
            matches.push({
              home: homeTeam,
              away: awayTeam,
              kickoffUtc,
              competition
            });
          }
        } catch (parseErr) {
          // Skip malformed fixtures
        }
      });
      
      // If we found matches, no need to try other selectors
      if (matches.length > 0) break;
    }
    
    // Alternative: parse from list items
    if (matches.length === 0) {
      $('li[class*="fixture"], li[data-fixture]').each((i, el) => {
        try {
          const text = $(el).text().trim();
          // Try to parse "Home Team vs Away Team" patterns
          const vsMatch = text.match(/^(.+?)\s+(?:v|vs|versus)\s+(.+?)$/i);
          if (vsMatch) {
            matches.push({
              home: vsMatch[1].trim(),
              away: vsMatch[2].trim(),
              kickoffUtc: null,
              competition: null
            });
          }
        } catch (parseErr) {
          // Skip
        }
      });
    }
    
    log(`Found ${matches.length} fixtures for ${slug}`);
    return { matches };
    
  } catch (err) {
    if (err.response && err.response.status === 404) {
      log(`Team page not found: ${slug}`);
    } else {
      log(`Error fetching fixtures: ${err.message}`);
    }
    return emptyResult;
  }
}

/**
 * Perform a health check on BBC Sport.
 * @returns {Promise<{ok: boolean, latencyMs: number, error?: string}>}
 */
async function healthCheck() {
  const startTime = Date.now();
  
  try {
    await axios.get(`${BASE_URL}/arsenal`, {
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
  fetchBBCFixtures,
  healthCheck,
  getTeamSlug,
  TEAM_SLUGS,
  BASE_URL
};
