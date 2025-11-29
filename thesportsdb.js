// thesportsdb.js
// Integration with TheSportsDB v1 JSON API for fixture and TV listing information.
/**
 * Telegram Sports TV Bot – TheSportsDB v1 API Integration
 *
 * Provides functions to interact with TheSportsDB v1 API:
 * - Search teams by name
 * - Get upcoming events (fixtures) for a team
 * - Get TV listings for specific events
 *
 * API Base URL: https://www.thesportsdb.com/api/v1/json/<APIKEY>/...
 *
 * Key Endpoints:
 * - /searchteams.php?t={team_name} - Search for teams
 * - /eventsnext.php?id={team_id} - Get upcoming events by team ID
 * - /lookuptv.php?id={event_id} - Get TV listings for an event
 *
 * This module is designed to:
 * - Supplement ICS fixture data with TV channel information
 * - Enable team search for configuration
 * - Be called from autopost.js to enrich fixture messages
 */

const axios = require('axios');

// ---------- Configuration ----------

const BASE_URL = 'https://www.thesportsdb.com/api/v1/json';
const DEFAULT_TIMEOUT = 15000;

// ---------- API Client ----------

/**
 * Build the full API URL with API key.
 * @param {string} apiKey - TheSportsDB API key
 * @param {string} endpoint - API endpoint (e.g., '/searchteams.php')
 * @returns {string} Full API URL
 */
function buildApiUrl(apiKey, endpoint) {
  const key = apiKey || '1'; // '1' is the free/test key
  return `${BASE_URL}/${encodeURIComponent(key)}${endpoint}`;
}

/**
 * Make an API request to TheSportsDB.
 * @param {string} apiKey - TheSportsDB API key
 * @param {string} endpoint - API endpoint with query parameters
 * @returns {Promise<Object>} Parsed JSON response
 */
async function apiRequest(apiKey, endpoint) {
  const url = buildApiUrl(apiKey, endpoint);
  
  try {
    const response = await axios.get(url, {
      timeout: DEFAULT_TIMEOUT,
      headers: {
        'User-Agent': 'TelegramSportsBot/1.0 (https://telegram.defecttracker.uk/)',
        'Accept': 'application/json'
      }
    });
    
    return response.data;
  } catch (err) {
    const status = err?.response?.status;
    const message = err?.message || String(err);
    
    if (status === 429) {
      throw new Error(`TheSportsDB rate limit exceeded (HTTP 429)`);
    }
    
    throw new Error(`TheSportsDB API error: ${message}`);
  }
}

// ---------- Team Search ----------

/**
 * Search for teams by name.
 * @param {string} apiKey - TheSportsDB API key
 * @param {string} teamName - Team name to search for
 * @returns {Promise<Array<Object>>} Array of team objects
 * 
 * Each team object contains:
 * - idTeam: Unique team ID
 * - strTeam: Team name
 * - strLeague: League name
 * - strCountry: Country
 * - strStadium: Stadium name
 * - strBadge: Team badge URL
 */
async function searchTeams(apiKey, teamName) {
  if (!teamName || typeof teamName !== 'string') {
    return [];
  }
  
  const encoded = encodeURIComponent(teamName.trim());
  const endpoint = `/searchteams.php?t=${encoded}`;
  
  const data = await apiRequest(apiKey, endpoint);
  
  // API returns { teams: [...] } or { teams: null }
  if (!data || !data.teams || !Array.isArray(data.teams)) {
    return [];
  }
  
  return data.teams;
}

/**
 * Find a team ID by name (returns first match).
 * @param {string} apiKey - TheSportsDB API key
 * @param {string} teamName - Team name to search for
 * @returns {Promise<string|null>} Team ID or null if not found
 */
async function findTeamId(apiKey, teamName) {
  const teams = await searchTeams(apiKey, teamName);
  
  if (!teams.length) {
    return null;
  }
  
  // Return the first match's ID
  return teams[0].idTeam || null;
}

// ---------- Upcoming Events ----------

/**
 * Get upcoming events (fixtures) for a team.
 * @param {string} apiKey - TheSportsDB API key
 * @param {string} teamId - TheSportsDB team ID
 * @returns {Promise<Array<Object>>} Array of event objects
 * 
 * Each event object contains:
 * - idEvent: Unique event ID
 * - strEvent: Event name (e.g., "Arsenal vs Chelsea")
 * - strHomeTeam: Home team name
 * - strAwayTeam: Away team name
 * - dateEvent: Event date (YYYY-MM-DD)
 * - strTime: Event time (HH:MM:SS)
 * - strVenue: Venue name
 * - idLeague: League ID
 * - strLeague: League name
 */
async function getUpcomingEvents(apiKey, teamId) {
  if (!teamId) {
    return [];
  }
  
  const endpoint = `/eventsnext.php?id=${encodeURIComponent(teamId)}`;
  
  const data = await apiRequest(apiKey, endpoint);
  
  // API returns { events: [...] } or { events: null }
  if (!data || !data.events || !Array.isArray(data.events)) {
    return [];
  }
  
  return data.events;
}

/**
 * Get upcoming events for a team by name (combines search + events).
 * @param {string} apiKey - TheSportsDB API key
 * @param {string} teamName - Team name
 * @returns {Promise<Array<Object>>} Array of event objects
 */
async function getUpcomingEventsForTeam(apiKey, teamName) {
  const teamId = await findTeamId(apiKey, teamName);
  
  if (!teamId) {
    return [];
  }
  
  return getUpcomingEvents(apiKey, teamId);
}

// ---------- TV Listings ----------

/**
 * Get TV listings for a specific event.
 * @param {string} apiKey - TheSportsDB API key
 * @param {string} eventId - TheSportsDB event ID
 * @returns {Promise<Array<Object>>} Array of TV listing objects
 * 
 * Each TV listing object contains:
 * - strChannel: TV channel name
 * - strCountry: Country code
 * - strLogo: Channel logo URL
 * - strTime: Broadcast time
 */
async function getTvListings(apiKey, eventId) {
  if (!eventId) {
    return [];
  }
  
  const endpoint = `/lookuptv.php?id=${encodeURIComponent(eventId)}`;
  
  const data = await apiRequest(apiKey, endpoint);
  
  // API returns { tvevent: [...] } or { tvevent: null }
  if (!data || !data.tvevent || !Array.isArray(data.tvevent)) {
    return [];
  }
  
  return data.tvevent;
}

/**
 * Get TV channels for an event, filtered by country.
 * @param {string} apiKey - TheSportsDB API key
 * @param {string} eventId - TheSportsDB event ID
 * @param {string} [countryCode] - Optional country code filter (e.g., "UK", "US")
 * @returns {Promise<Array<string>>} Array of TV channel names
 */
async function getTvChannels(apiKey, eventId, countryCode = null) {
  const listings = await getTvListings(apiKey, eventId);
  
  if (!listings.length) {
    return [];
  }
  
  // Filter by country if specified
  let filtered = listings;
  if (countryCode) {
    const code = countryCode.toUpperCase();
    filtered = listings.filter(tv => {
      const tvCountry = (tv.strCountry || '').toUpperCase();
      return tvCountry === code || tvCountry.includes(code);
    });
  }
  
  // Extract unique channel names
  const channels = new Set();
  for (const tv of filtered) {
    if (tv.strChannel) {
      channels.add(tv.strChannel);
    }
  }
  
  return Array.from(channels);
}

// ---------- Fixture Matching & Enrichment ----------

/**
 * Try to find a matching TheSportsDB event for an ICS fixture.
 * This is a heuristic match based on team names and date.
 * 
 * @param {string} apiKey - TheSportsDB API key
 * @param {Object} fixture - ICS fixture object with summary, start date
 * @param {string} teamName - Team name to search events for
 * @returns {Promise<Object|null>} Matching event object or null
 */
async function findMatchingEvent(apiKey, fixture, teamName) {
  if (!apiKey || !fixture || !teamName) {
    return null;
  }
  
  const events = await getUpcomingEventsForTeam(apiKey, teamName);
  
  if (!events.length) {
    return null;
  }
  
  const fixtureSummary = (fixture.summary || '').toLowerCase();
  const fixtureDate = fixture.start instanceof Date
    ? fixture.start.toISOString().slice(0, 10)
    : null;
  
  for (const event of events) {
    // Match by date first
    if (fixtureDate && event.dateEvent === fixtureDate) {
      // Then check if home or away team is in fixture summary
      const homeTeam = (event.strHomeTeam || '').toLowerCase();
      const awayTeam = (event.strAwayTeam || '').toLowerCase();
      
      if (fixtureSummary.includes(homeTeam) || fixtureSummary.includes(awayTeam)) {
        return event;
      }
    }
    
    // Fallback: match by event name similarity
    const eventName = (event.strEvent || '').toLowerCase();
    if (fixtureSummary.includes(eventName) || eventName.includes(fixtureSummary)) {
      return event;
    }
  }
  
  return null;
}

/**
 * Enrich a fixture with TV channel information from TheSportsDB.
 * 
 * @param {string} apiKey - TheSportsDB API key
 * @param {Object} fixture - ICS fixture object
 * @param {string} teamName - Team name for event lookup
 * @param {string} [countryCode] - Country code for TV listings (e.g., "UK")
 * @returns {Promise<Object>} Fixture object with tvChannel property populated
 */
async function enrichFixtureWithTvInfo(apiKey, fixture, teamName, countryCode = 'UK') {
  if (!apiKey || !fixture) {
    return fixture;
  }
  
  try {
    const event = await findMatchingEvent(apiKey, fixture, teamName);
    
    if (!event || !event.idEvent) {
      return fixture;
    }
    
    const channels = await getTvChannels(apiKey, event.idEvent, countryCode);
    
    if (channels.length) {
      fixture.tvChannel = channels.join(', ');
    }
    
    return fixture;
  } catch (err) {
    // Log but don't fail - TV info is supplementary
    console.log(`[TheSportsDB] Failed to enrich fixture: ${err.message}`);
    return fixture;
  }
}

/**
 * Batch enrich multiple fixtures with TV info.
 * Includes rate limiting to avoid hitting API limits.
 * 
 * @param {string} apiKey - TheSportsDB API key
 * @param {Array<Object>} fixtures - Array of fixture objects
 * @param {string} teamName - Team name for lookups
 * @param {string} [countryCode] - Country code for TV listings
 * @param {number} [delayMs] - Delay between API calls in ms (default 500)
 * @returns {Promise<Array<Object>>} Enriched fixtures
 */
async function enrichFixturesWithTvInfo(apiKey, fixtures, teamName, countryCode = 'UK', delayMs = 500) {
  if (!apiKey || !fixtures || !fixtures.length) {
    return fixtures || [];
  }
  
  const enriched = [];
  
  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i];
    const enrichedFixture = await enrichFixtureWithTvInfo(apiKey, fixture, teamName, countryCode);
    enriched.push(enrichedFixture);
    
    // Rate limiting
    if (i < fixtures.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return enriched;
}

// ---------- Module Exports ----------

module.exports = {
  // Team search
  searchTeams,
  findTeamId,
  
  // Events/Fixtures
  getUpcomingEvents,
  getUpcomingEventsForTeam,
  
  // TV Listings
  getTvListings,
  getTvChannels,
  
  // Fixture enrichment
  findMatchingEvent,
  enrichFixtureWithTvInfo,
  enrichFixturesWithTvInfo
};
