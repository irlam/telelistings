// scrapers/footballdata.js
// FootballData.org API integration for fixture lookup.
// NOTE: This is an API client that runs directly on Plesk (no Puppeteer needed).
/**
 * Telegram Sports TV Bot – FootballData.org Fixture Scraper
 *
 * This is a lightweight API client that can run directly on Plesk.
 * No browser automation required – uses axios for API calls.
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
 * @param {string} [params.teamId] - FootballData.org team ID (optional for general fixtures)
 * @param {Date|string} [params.dateUtc] - Match date
 * @param {string} [params.competition] - Competition code (e.g., 'PL' for Premier League)
 * @returns {Promise<{fixtures: Array<{home: string, away: string, kickoffUtc: string|null, league: string|null}>}|{kickoffUtc: string|null, league: string|null}>}
 */
async function fetchFootballData({ teamId, dateUtc, competition } = {}) {
  const emptyResult = {
    fixtures: [],
    kickoffUtc: null,
    league: null
  };
  
  const apiKey = getApiKey();
  if (!apiKey) {
    log('No API key configured (set FOOTBALLDATA_API_KEY env var or footballDataApiKey in config.json)');
    return emptyResult;
  }
  
  // Parse date for filtering
  const matchDate = dateUtc instanceof Date ? dateUtc : new Date(dateUtc || Date.now());
  const dateFrom = matchDate.toISOString().slice(0, 10);
  const dateTo = new Date(matchDate.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  
  try {
    let data;
    
    if (teamId) {
      // Team-specific query
      log(`Looking up fixtures for team ${teamId} from ${dateFrom} to ${dateTo}`);
      data = await apiRequest(`/teams/${teamId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`, apiKey);
    } else if (competition) {
      // Competition-specific query
      log(`Looking up fixtures for competition ${competition} from ${dateFrom} to ${dateTo}`);
      data = await apiRequest(`/competitions/${competition}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`, apiKey);
    } else {
      // General fixtures for today - query multiple UK competitions
      log(`Looking up all fixtures from ${dateFrom} to ${dateTo}`);
      const competitions = ['PL', 'ELC', 'FL1', 'FL2']; // Premier League, Championship, League 1, League 2
      const allMatches = [];
      
      for (const comp of competitions) {
        try {
          const compData = await apiRequest(`/competitions/${comp}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`, apiKey);
          if (compData && compData.matches) {
            allMatches.push(...compData.matches);
          }
        } catch (compErr) {
          // Skip competition on error
          continue;
        }
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      data = { matches: allMatches };
    }
    
    if (!data || !data.matches || !Array.isArray(data.matches) || data.matches.length === 0) {
      log(`No fixtures found for ${dateFrom}`);
      return emptyResult;
    }
    
    // Build fixtures array
    const fixtures = data.matches.map(match => ({
      home: match.homeTeam?.name || 'Unknown',
      away: match.awayTeam?.name || 'Unknown',
      kickoffUtc: match.utcDate || null,
      league: match.competition?.name || null
    }));
    
    log(`Found ${fixtures.length} fixtures`);
    
    // For backwards compatibility, also include first match data at top level
    const firstMatch = data.matches[0];
    return {
      fixtures,
      kickoffUtc: firstMatch?.utcDate || null,
      league: firstMatch?.competition?.name || null
    };
    
  } catch (err) {
    // Handle specific error cases
    if (err.response) {
      if (err.response.status === 403) {
        log('API key invalid or rate limited');
      } else if (err.response.status === 404) {
        log(`Resource not found`);
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
