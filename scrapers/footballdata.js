// scrapers/footballdata.js
// FootballData.org API integration for fixture lookup.
/**
 * Telegram Sports TV Bot – FootballData.org Fixture Scraper
 *
 * Exports fetchFootballData({ teamId, dateUtc }) which:
 * - Queries FootballData.org v4 API for fixtures
 * - Returns kickoff time and league information
 *
 * Returns:
 * {
 *   kickoffUtc: string | null,
 *   league: string | null
 * }
 *
 * Never throws; on failure returns null values and logs warning.
 * All logs use prefix [FBD]
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------

const BASE_URL = 'https://api.football-data.org/v4';
const DEFAULT_TIMEOUT = 15000;

/**
 * Get API key from environment or config.
 * @returns {string|null} API key or null
 */
function getApiKey() {
  // Try environment variable first
  if (process.env.FOOTBALLDATA_API_KEY) {
    return process.env.FOOTBALLDATA_API_KEY;
  }
  
  // Try config.json
  try {
    const configPath = path.join(__dirname, '..', 'config.json');
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return cfg.footballDataApiKey || null;
    }
  } catch (err) {
    // Ignore config errors
  }
  
  return null;
}

// ---------- Logging ----------

/**
 * Log a message with [FBD] prefix.
 * @param {string} msg - Message to log
 */
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [FBD] ${msg}`;
  console.log(line);
  
  try {
    const logPath = path.join(__dirname, '..', 'autopost.log');
    fs.appendFileSync(logPath, line + '\n', 'utf8');
  } catch (err) {
    // Ignore file errors
  }
}

// ---------- API Helpers ----------

/**
 * Make an API request to FootballData.org.
 * @param {string} endpoint - API endpoint path
 * @param {string} apiKey - API key
 * @returns {Promise<Object>} API response data
 */
async function apiRequest(endpoint, apiKey) {
  const url = `${BASE_URL}${endpoint}`;
  
  const response = await axios.get(url, {
    timeout: DEFAULT_TIMEOUT,
    headers: {
      'X-Auth-Token': apiKey,
      'Accept': 'application/json'
    }
  });
  
  return response.data;
}

// ---------- Main Function ----------

/**
 * Fetch fixture information from FootballData.org.
 *
 * @param {Object} params - Parameters
 * @param {string} params.teamId - FootballData.org team ID
 * @param {Date|string} params.dateUtc - Match date
 * @returns {Promise<{kickoffUtc: string|null, league: string|null}>}
 */
async function fetchFootballData({ teamId, dateUtc }) {
  const emptyResult = {
    kickoffUtc: null,
    league: null
  };
  
  if (!teamId) {
    log('Missing teamId parameter');
    return emptyResult;
  }
  
  const apiKey = getApiKey();
  if (!apiKey) {
    log('No API key configured (set FOOTBALLDATA_API_KEY env var or footballDataApiKey in config.json)');
    return emptyResult;
  }
  
  // Parse date for filtering
  const matchDate = dateUtc instanceof Date ? dateUtc : new Date(dateUtc || Date.now());
  const dateFrom = matchDate.toISOString().slice(0, 10);
  const dateTo = new Date(matchDate.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  
  log(`Looking up fixtures for team ${teamId} from ${dateFrom} to ${dateTo}`);
  
  try {
    const data = await apiRequest(`/teams/${teamId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`, apiKey);
    
    if (!data || !data.matches || !Array.isArray(data.matches) || data.matches.length === 0) {
      log(`No fixtures found for team ${teamId} on ${dateFrom}`);
      return emptyResult;
    }
    
    // Get the first match (closest to the date)
    const match = data.matches[0];
    
    log(`Found fixture: ${match.homeTeam?.name || 'unknown'} vs ${match.awayTeam?.name || 'unknown'}`);
    
    return {
      kickoffUtc: match.utcDate || null,
      league: match.competition?.name || null
    };
    
  } catch (err) {
    // Handle specific error cases
    if (err.response) {
      if (err.response.status === 403) {
        log('API key invalid or rate limited');
      } else if (err.response.status === 404) {
        log(`Team ${teamId} not found`);
      } else {
        log(`API error: ${err.response.status} ${err.response.statusText}`);
      }
    } else {
      log(`Error: ${err.message}`);
    }
    return emptyResult;
  }
}

/**
 * Perform a health check on FootballData.org API.
 * @returns {Promise<{ok: boolean, latencyMs: number, error?: string}>}
 */
async function healthCheck() {
  const startTime = Date.now();
  
  const apiKey = getApiKey();
  if (!apiKey) {
    return { 
      ok: false, 
      latencyMs: 0, 
      error: 'No API key configured' 
    };
  }
  
  try {
    // Simple query to test API connectivity
    await apiRequest('/competitions/PL', apiKey);
    
    const latencyMs = Date.now() - startTime;
    log(`[health] OK in ${latencyMs}ms`);
    return { ok: true, latencyMs };
    
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    const errorMsg = err.response 
      ? `${err.response.status} ${err.response.statusText}` 
      : err.message;
    log(`[health] FAIL in ${latencyMs}ms: ${errorMsg}`);
    return { ok: false, latencyMs, error: errorMsg };
  }
}

// ---------- Module Exports ----------

module.exports = {
  fetchFootballData,
  healthCheck,
  getApiKey,
  BASE_URL
};
