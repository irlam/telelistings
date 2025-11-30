// scrapers/lstv.js
// LiveSoccerTV remote scraper client – calls a VPS-hosted scraper service.
/**
 * Telegram Sports TV Bot – LiveSoccerTV Remote Scraper Client
 *
 * This module has been updated to use a remote VPS scraper service instead of
 * local Puppeteer. The VPS handles all browser automation and returns scraped data.
 *
 * Exports fetchLSTV({ home, away, date, kickoffUtc, league }) which:
 * - Posts to the remote LSTV scraper service
 * - Receives TV channel data in response
 *
 * Returns:
 * {
 *   url: string | null,
 *   kickoffUtc: string | null,
 *   league: string | null,
 *   regionChannels: [{ region, channel }, ...],
 *   matchScore: number | null  // score of the selected match (0-100)
 * }
 *
 * Never throws; on failure returns { regionChannels: [] }
 * All logs use prefix [LSTV]
 *
 * Environment Variables (set in Plesk Node settings or .env):
 *   LSTV_SCRAPER_URL - Base URL of the remote scraper service (default: http://185.170.113.230:3333)
 *   LSTV_SCRAPER_KEY - API key for authentication (default: Q0tMx1sJ8nVh3w9L2z)
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ---------- Configuration ----------

// Remote scraper service configuration
const LSTV_SCRAPER_URL = process.env.LSTV_SCRAPER_URL || 'http://185.170.113.230:3333';
const LSTV_SCRAPER_KEY = process.env.LSTV_SCRAPER_KEY || 'Q0tMx1sJ8nVh3w9L2z';

// Legacy constants kept for backwards compatibility with tests
const BASE_URL = 'https://www.livesoccertv.com';

// Match scoring configuration (kept for test compatibility)
const SCORE_THRESHOLD = 50;          // Minimum score to accept a match (0-100)

// Debug flag - set via environment variable LSTV_DEBUG=1 or modify this constant
const DEBUG = process.env.LSTV_DEBUG === '1' || process.env.LSTV_DEBUG === 'true';

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
  const TIME_WINDOW_HOURS = 3;
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

// ---------- URL Building (kept for backwards compatibility) ----------

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
 * Note: This is kept for backwards compatibility with tests but is not used
 * by the remote scraper client.
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

/**
 * Legacy function - no longer used since we use remote scraper.
 * Returns null for backwards compatibility.
 * @returns {string|null}
 */
function findChromePath() {
  // No longer using local Chrome - scraping happens on remote VPS
  return null;
}

// ---------- Main Remote Scraper Function ----------

/**
 * Fetch TV channel information for a fixture from the remote LiveSoccerTV scraper service.
 *
 * @param {Object} params - Parameters
 * @param {string} params.home - Home team name
 * @param {string} params.away - Away team name
 * @param {Date|string} params.date - Match date
 * @param {Date|string} params.kickoffUtc - Known kickoff time (optional, for better matching)
 * @param {string} params.league - League/competition name (optional, for better matching)
 * @returns {Promise<{url: string|null, kickoffUtc: string|null, league: string|null, regionChannels: Array<{region: string, channel: string}>, matchScore: number|null}>}
 */
async function fetchLSTV({ home, away, date, kickoffUtc = null, league = null }) {
  // Convert date/kickoffUtc to ISO string for API
  const dateUtc = kickoffUtc 
    ? (kickoffUtc instanceof Date ? kickoffUtc.toISOString() : kickoffUtc)
    : (date instanceof Date ? date.toISOString() : date || null);
  
  // Default empty result - never throw
  const emptyResult = {
    url: null,
    kickoffUtc: dateUtc || null,
    league: league || null,
    regionChannels: [],
    matchScore: null
  };
  
  // Validate inputs
  if (!home || !away) {
    log(`Missing team names: home="${home}", away="${away}"`);
    return emptyResult;
  }
  
  log(`Searching for ${home} vs ${away}${league ? ` (${league})` : ''} via remote scraper`);
  debugLog(`Remote URL: ${LSTV_SCRAPER_URL}/scrape/lstv`);
  
  try {
    const response = await axios.post(
      `${LSTV_SCRAPER_URL}/scrape/lstv`,
      {
        home,
        away,
        dateUtc,
        leagueHint: league
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': LSTV_SCRAPER_KEY
        },
        timeout: 60000 // 60 second timeout for scraping
      }
    );
    
    const data = response.data;
    
    // Extract data from response
    const result = {
      url: data.url || null,
      kickoffUtc: data.kickoffUtc || dateUtc || null,
      league: data.league || league || null,
      regionChannels: Array.isArray(data.regionChannels) ? data.regionChannels : [],
      matchScore: typeof data.matchScore === 'number' ? data.matchScore : null
    };
    
    if (result.regionChannels.length > 0) {
      log(`Success: Found ${result.regionChannels.length} TV channels for ${home} vs ${away}`);
    } else {
      log(`No TV channels found for ${home} vs ${away}`);
    }
    
    return result;
    
  } catch (err) {
    // Log the error but never throw
    const errorMessage = err.response?.data?.error || err.message || String(err);
    console.error('[LSTV] Remote call error:', errorMessage);
    log(`Remote scraper error: ${errorMessage}`);
    
    return emptyResult;
  }
}

// ---------- Health Check ----------

/**
 * Get detailed system information about the remote scraper service.
 * @returns {{remoteUrl: string, mode: string}}
 */
function getSystemInfo() {
  return {
    remoteUrl: LSTV_SCRAPER_URL,
    mode: 'remote'
  };
}

/**
 * Perform a health check by calling the remote scraper service health endpoint.
 * @returns {Promise<{ok: boolean, latencyMs: number, remote?: Object, error?: string}>}
 */
async function healthCheck() {
  const startTime = Date.now();
  
  try {
    const response = await axios.get(
      `${LSTV_SCRAPER_URL}/health`,
      {
        headers: {
          'x-api-key': LSTV_SCRAPER_KEY
        },
        timeout: 10000 // 10 second timeout for health check
      }
    );
    
    const latencyMs = Date.now() - startTime;
    const result = { 
      ok: true, 
      latencyMs, 
      remote: response.data 
    };
    
    log(`[health] OK in ${latencyMs}ms (remote)`);
    return result;
    
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = err.response?.data?.error || err.message || String(err);
    const result = { 
      ok: false, 
      latencyMs, 
      error: errorMessage 
    };
    
    log(`[health] FAIL in ${latencyMs}ms: ${errorMessage}`);
    return result;
  }
}

// ---------- Module Exports ----------

module.exports = {
  fetchLSTV,
  healthCheck,
  getSystemInfo,
  // Export helpers for testing (backwards compatibility)
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
