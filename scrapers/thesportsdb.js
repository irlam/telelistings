// scrapers/thesportsdb.js
// TheSportsDB v1 JSON API integration for fixture lookup and TV station info.
// NOTE: This is an API client that runs directly on Plesk (no Puppeteer needed).
/**
 * Telegram Sports TV Bot – TheSportsDB Fixture Scraper
 *
 * This is a lightweight API client that can run directly on Plesk.
 * No browser automation required – uses axios for API calls.
 *
 * Exports fetchTSDBFixture({ home, away, date }) which:
 * - Queries TheSportsDB API for the specific fixture
 * - Returns normalized fixture data with kickoff time, league, venue
 * - Optionally includes TV stations if available from API
 *
 * Returns:
 * {
 *   matched: boolean,       // Whether a fixture was found
 *   kickoffUtc: string|null,
 *   league: string|null,
 *   venue: string|null,
 *   tvStations: string[]    // List of TV stations (if available)
 * }
 *
 * Never throws; on failure returns { matched: false }
 * All logs use prefix [TSDB]
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------

const BASE_URL = 'https://www.thesportsdb.com/api/v1/json';
const DEFAULT_TIMEOUT = 15000;

// Get API key from environment variable or config
function getApiKey() {
  // Try environment variable first
  if (process.env.THESPORTSDB_API_KEY) {
    return process.env.THESPORTSDB_API_KEY;
  }
  
  // Try config.json
  try {
    const configPath = path.join(__dirname, '..', 'config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return cfg.theSportsDbApiKey || '1'; // Free tier key
    }
  } catch (err) {
    // Ignore config errors
  }
  
  // Default to free tier key
  return '1';
}

// Alternative API keys to try if default fails
const FALLBACK_API_KEYS = ['3', '2', '1'];

// ---------- Logging ----------

/**
 * Log a message with [TSDB] prefix.
 * @param {string} msg - Message to log
 */
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [TSDB] ${msg}`;
  console.log(line);
  
  // Also append to autopost.log for visibility in /admin/logs
  try {
    const logPath = path.join(__dirname, '..', 'autopost.log');
    fs.appendFileSync(logPath, line + '\n', 'utf8');
  } catch (err) {
    // Ignore file errors
  }
}

// ---------- Team Name Normalization ----------

/**
 * Normalize a team name for comparison/matching.
 * Only strips truly redundant prefixes like FC, AFC.
 * Keeps distinguishing words like City, United, Town.
 * @param {string} name - Team name
 * @returns {string} Normalized name
 */
function normalizeTeamName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    // Only remove truly redundant prefixes/suffixes (FC, AFC, SC, etc.)
    // Keep words like United, City, Town as they distinguish teams
    .replace(/\b(fc|afc|cf|sc|ac|as|ss|rc|rfc)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if two team names match (fuzzy).
 * @param {string} name1 - First team name
 * @param {string} name2 - Second team name
 * @returns {boolean}
 */
function teamsMatch(name1, name2) {
  const norm1 = normalizeTeamName(name1);
  const norm2 = normalizeTeamName(name2);
  
  if (!norm1 || !norm2) return false;
  
  // Exact match after normalization
  if (norm1 === norm2) return true;
  
  // One contains the other
  if (norm1.includes(norm2) || norm2.includes(norm1)) return true;
  
  // Check if main word matches (e.g., "Arsenal" in "Arsenal FC")
  const words1 = norm1.split(' ').filter(w => w.length > 3);
  const words2 = norm2.split(' ').filter(w => w.length > 3);
  
  for (const w1 of words1) {
    if (words2.includes(w1)) return true;
  }
  
  return false;
}

// ---------- API Helpers ----------

/**
 * Make an API request to TheSportsDB.
 * @param {string} apiKey - API key
 * @param {string} endpoint - API endpoint path
 * @returns {Promise<Object>} API response data
 */
async function apiRequest(apiKey, endpoint) {
  const url = `${BASE_URL}/${encodeURIComponent(apiKey)}${endpoint}`;
  
  const response = await axios.get(url, {
    timeout: DEFAULT_TIMEOUT,
    headers: {
      'User-Agent': 'TelegramSportsBot/1.0',
      'Accept': 'application/json'
    }
  });
  
  return response.data;
}

/**
 * Search for a team by name.
 * @param {string} apiKey - API key
 * @param {string} teamName - Team name to search
 * @returns {Promise<Object|null>} Team object or null
 */
async function searchTeam(apiKey, teamName) {
  const encoded = encodeURIComponent(teamName.trim());
  const data = await apiRequest(apiKey, `/searchteams.php?t=${encoded}`);
  
  if (!data || !data.teams || !Array.isArray(data.teams) || data.teams.length === 0) {
    return null;
  }
  
  // Return first match
  return data.teams[0];
}

/**
 * Get upcoming events for a team.
 * @param {string} apiKey - API key
 * @param {string} teamId - Team ID
 * @returns {Promise<Array>} Array of events
 */
async function getUpcomingEvents(apiKey, teamId) {
  const data = await apiRequest(apiKey, `/eventsnext.php?id=${teamId}`);
  
  if (!data || !data.events || !Array.isArray(data.events)) {
    return [];
  }
  
  return data.events;
}

/**
 * Get TV listings for an event.
 * @param {string} apiKey - API key
 * @param {string} eventId - Event ID
 * @returns {Promise<Array>} Array of TV listings
 */
async function getTvListings(apiKey, eventId) {
  try {
    const data = await apiRequest(apiKey, `/lookuptv.php?id=${eventId}`);
    
    if (!data || !data.tvevent || !Array.isArray(data.tvevent)) {
      return [];
    }
    
    return data.tvevent;
  } catch (err) {
    // TV listings endpoint may not be available for all events
    return [];
  }
}

// ---------- Main Fixture Lookup ----------

/**
 * Fetch fixture information from TheSportsDB.
 *
 * @param {Object} params - Parameters
 * @param {string} params.home - Home team name
 * @param {string} params.away - Away team name
 * @param {Date|string} params.date - Match date
 * @returns {Promise<{matched: boolean, kickoffUtc: string|null, league: string|null, venue: string|null, tvStations: string[], eventId: string|null}>}
 */
async function fetchTSDBFixture({ home, away, date }) {
  const emptyResult = {
    matched: false,
    kickoffUtc: null,
    league: null,
    venue: null,
    tvStations: [],
    eventId: null
  };
  
  if (!home || !away) {
    log(`Missing team names: home="${home}", away="${away}"`);
    return emptyResult;
  }
  
  let apiKey = getApiKey();
  
  // Parse date for matching
  const matchDate = date instanceof Date ? date : new Date(date || Date.now());
  const matchDateStr = matchDate.toISOString().slice(0, 10);
  
  log(`Searching for ${home} vs ${away} on ${matchDateStr}`);
  
  // Build list of API keys to try
  const keysToTry = [apiKey];
  for (const fallbackKey of FALLBACK_API_KEYS) {
    if (!keysToTry.includes(fallbackKey)) {
      keysToTry.push(fallbackKey);
    }
  }
  
  for (const tryKey of keysToTry) {
    try {
      // Search for home team first
      const homeTeam = await searchTeam(tryKey, home);
      
      if (!homeTeam) {
        log(`Could not find team: ${home}`);
        return emptyResult;
      }
    
      log(`Found team: ${homeTeam.strTeam} (ID: ${homeTeam.idTeam})`);
    
      // Get upcoming events
      const events = await getUpcomingEvents(tryKey, homeTeam.idTeam);
    
      if (events.length === 0) {
        log(`No upcoming events found for ${homeTeam.strTeam}`);
        return emptyResult;
      }
    
      // Find matching fixture
      let bestMatch = null;
    
      for (const event of events) {
        // Check date match
        if (event.dateEvent !== matchDateStr) {
          continue;
        }
      
        // Check if away team matches
        const eventHome = event.strHomeTeam || '';
        const eventAway = event.strAwayTeam || '';
      
        const homeMatches = teamsMatch(eventHome, home) || teamsMatch(eventAway, home);
        const awayMatches = teamsMatch(eventHome, away) || teamsMatch(eventAway, away);
      
        if (homeMatches && awayMatches) {
          bestMatch = event;
          break;
        }
      }
    
      if (!bestMatch) {
        log(`No matching fixture found for ${home} vs ${away} on ${matchDateStr}`);
        return emptyResult;
      }
    
      log(`Found fixture: ${bestMatch.strEvent} (ID: ${bestMatch.idEvent})`);
    
      // Build kickoff UTC from date and time
      let kickoffUtc = null;
      if (bestMatch.dateEvent && bestMatch.strTime) {
        kickoffUtc = `${bestMatch.dateEvent}T${bestMatch.strTime}`;
      } else if (bestMatch.strTimestamp) {
        kickoffUtc = bestMatch.strTimestamp;
      }
    
      // Try to get TV listings
      let tvStations = [];
      if (bestMatch.idEvent) {
        const tvListings = await getTvListings(tryKey, bestMatch.idEvent);
        tvStations = tvListings.map(tv => tv.strChannel).filter(Boolean);
      
        // Remove duplicates
        tvStations = [...new Set(tvStations)];
      
        if (tvStations.length > 0) {
          log(`Found ${tvStations.length} TV stations`);
        }
      }
    
      return {
        matched: true,
        kickoffUtc,
        league: bestMatch.strLeague || null,
        venue: bestMatch.strVenue || null,
        tvStations,
        eventId: bestMatch.idEvent || null
      };
    
    } catch (err) {
      // If it's a 404, try the next API key
      if (err.response && err.response.status === 404) {
        continue;
      }
      log(`Error: ${err.message}`);
      return emptyResult;
    }
  }
  
  // All API keys failed
  log(`All API keys failed for ${home} vs ${away}`);
  return emptyResult;
}

/**
 * Perform a health check on TheSportsDB API.
 * @returns {Promise<{ok: boolean, latencyMs: number, error?: string}>}
 */
async function healthCheck() {
  const startTime = Date.now();
  
  try {
    const apiKey = getApiKey();
    // Simple query to test API connectivity - try default key first
    try {
      await apiRequest(apiKey, '/searchteams.php?t=Arsenal');
    } catch (firstErr) {
      // If default key fails and it was '1', try '3' as fallback
      if (apiKey === '1' && firstErr.response && firstErr.response.status === 404) {
        await apiRequest('3', '/searchteams.php?t=Arsenal');
      } else {
        throw firstErr;
      }
    }
    
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
  fetchTSDBFixture,
  healthCheck,
  // Export helpers for testing
  searchTeam,
  getUpcomingEvents,
  getTvListings,
  normalizeTeamName,
  teamsMatch,
  getApiKey,
  BASE_URL
};
