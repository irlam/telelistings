// scrapers/fixtures_scraper.js
// Unified fixture scraper that aggregates fixtures from multiple web sources.
// This is an alternative to ics_source.js, preferring web scrapers over ICS feeds.
/**
 * Telegram Sports TV Bot – Unified Fixtures Scraper
 *
 * This module provides fixture discovery using web scrapers instead of ICS feeds.
 * It aggregates fixtures from multiple sources:
 * - TheSportsDB API (primary source for reliable fixture data + TV stations)
 * - BBC Sport (fallback for UK teams)
 * - LiveFootballOnTV (UK-specific fixtures with TV channels)
 * - Sky Sports (UK TV channels)
 * - TNT Sports (UK TV channels)
 *
 * Key Feature: TV Channel Collection
 * Each scraper may find different TV stations/channels for an event.
 * This module collects ALL channels from ALL sources, deduplicates them,
 * and includes them in the fixture data for display in Telegram posts.
 *
 * Exports getFixturesFromScrapers(options) which:
 * - Queries multiple sources for team fixtures
 * - Merges and deduplicates results
 * - Collects TV channels from all sources
 * - Returns normalized fixture objects
 *
 * Returns:
 * Array<{
 *   start: Date,
 *   summary: string,
 *   homeTeam: string,
 *   awayTeam: string,
 *   location: string | null,
 *   competition: string | null,
 *   tvChannels: string[],           // Flat list of all unique channel names
 *   tvByRegion: Array<{region, channel, source}>,  // Channels by region with source attribution
 *   source: string
 * }>
 *
 * Never throws; on failure returns empty array and logs warnings.
 * All logs use prefix [FIX]
 */

const fs = require('fs');
const path = require('path');

// Import scrapers
const tsdb = require('./thesportsdb');
const bbcFixtures = require('./bbc_fixtures');
const livefootballontv = require('./livefootballontv');

// Optional scrapers - loaded lazily
let skysports = null;
let tnt = null;

try { skysports = require('./skysports'); } catch (err) { /* not available */ }
try { tnt = require('./tnt'); } catch (err) { /* not available */ }

// ---------- Configuration ----------

const LOG_PATH = path.join(__dirname, '..', 'autopost.log');

// Default days ahead for fixture lookups
const DEFAULT_DAYS_AHEAD = 7;

// ---------- Logging ----------

/**
 * Log a message with [FIX] prefix.
 * @param {string} msg - Message to log
 */
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [FIX] ${msg}`;
  console.log(line);
  
  try {
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
  } catch (err) {
    // Ignore file errors
  }
}

// ---------- Team Name Normalization ----------

/**
 * Normalize a team name for comparison/matching.
 * @param {string} name - Team name
 * @returns {string} Normalized name
 */
function normalizeTeamName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/\b(fc|afc|cf|sc|ac)\b/gi, '')
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
  
  // Check if main word matches
  const words1 = norm1.split(' ').filter(w => w.length > 3);
  const words2 = norm2.split(' ').filter(w => w.length > 3);
  
  for (const w1 of words1) {
    if (words2.includes(w1)) return true;
  }
  
  return false;
}

// ---------- Fixture Normalization ----------

/**
 * Create a unique key for a fixture (for deduplication).
 * @param {Object} fixture - Fixture object
 * @returns {string} Unique key
 */
function getFixtureKey(fixture) {
  const home = normalizeTeamName(fixture.homeTeam);
  const away = normalizeTeamName(fixture.awayTeam);
  const date = fixture.start instanceof Date 
    ? fixture.start.toISOString().slice(0, 10)
    : '';
  return `${home}|${away}|${date}`;
}

/**
 * Normalize a fixture object to the standard format.
 * @param {Object} raw - Raw fixture from a source
 * @param {string} source - Source name
 * @returns {Object} Normalized fixture
 */
function normalizeFixture(raw, source) {
  let start = null;
  
  // Handle various date/time formats
  if (raw.kickoffUtc) {
    start = new Date(raw.kickoffUtc);
  } else if (raw.start) {
    start = raw.start instanceof Date ? raw.start : new Date(raw.start);
  } else if (raw.dateEvent && raw.strTime) {
    start = new Date(`${raw.dateEvent}T${raw.strTime}`);
  } else if (raw.dateEvent) {
    start = new Date(raw.dateEvent);
  }
  
  // Validate date
  if (start && isNaN(start.getTime())) {
    start = null;
  }
  
  // Build summary if not present
  let summary = raw.summary || raw.strEvent || '';
  const homeTeam = raw.homeTeam || raw.strHomeTeam || raw.home || '';
  const awayTeam = raw.awayTeam || raw.strAwayTeam || raw.away || '';
  
  if (!summary && homeTeam && awayTeam) {
    summary = `${homeTeam} v ${awayTeam}`;
  }
  
  return {
    start,
    summary,
    homeTeam,
    awayTeam,
    location: raw.location || raw.strVenue || raw.venue || null,
    competition: raw.competition || raw.strLeague || raw.league || null,
    tvChannels: raw.tvChannels || raw.channels || [],
    tvByRegion: raw.tvByRegion || [],  // Array of {region, channel, source}
    source
  };
}

// ---------- Source-Specific Fetchers ----------

/**
 * Fetch fixtures from TheSportsDB for a team.
 * @param {string} teamName - Team name
 * @param {number} daysAhead - Number of days to look ahead
 * @returns {Promise<Array>} Array of normalized fixtures
 */
async function fetchFromTSDB(teamName, daysAhead) {
  try {
    const apiKey = tsdb.getApiKey();
    const team = await tsdb.searchTeam(apiKey, teamName);
    
    if (!team) {
      return [];
    }
    
    const events = await tsdb.getUpcomingEvents(apiKey, team.idTeam);
    
    if (!events || events.length === 0) {
      return [];
    }
    
    const now = new Date();
    const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    
    const fixtures = [];
    for (const event of events) {
      const fixture = normalizeFixture({
        dateEvent: event.dateEvent,
        strTime: event.strTime,
        strEvent: event.strEvent,
        strHomeTeam: event.strHomeTeam,
        strAwayTeam: event.strAwayTeam,
        strVenue: event.strVenue,
        strLeague: event.strLeague
      }, 'TSDB');
      
      // Filter by date range
      if (fixture.start && fixture.start >= now && fixture.start <= cutoff) {
        fixtures.push(fixture);
      }
    }
    
    return fixtures;
  } catch (err) {
    log(`TSDB error for ${teamName}: ${err.message}`);
    return [];
  }
}

/**
 * Fetch fixtures from BBC Sport for a team.
 * @param {string} teamName - Team name
 * @param {number} daysAhead - Number of days to look ahead
 * @returns {Promise<Array>} Array of normalized fixtures
 */
async function fetchFromBBC(teamName, daysAhead) {
  try {
    const result = await bbcFixtures.fetchBBCFixtures({ teamName });
    
    if (!result.matches || result.matches.length === 0) {
      return [];
    }
    
    const now = new Date();
    const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    
    const fixtures = [];
    for (const match of result.matches) {
      const fixture = normalizeFixture({
        kickoffUtc: match.kickoffUtc,
        home: match.home,
        away: match.away,
        competition: match.competition
      }, 'BBC');
      
      // Filter by date range (if we have a date)
      if (fixture.start) {
        if (fixture.start >= now && fixture.start <= cutoff) {
          fixtures.push(fixture);
        }
      } else {
        // No date info - include anyway (might be upcoming)
        fixtures.push(fixture);
      }
    }
    
    return fixtures;
  } catch (err) {
    log(`BBC error for ${teamName}: ${err.message}`);
    return [];
  }
}

/**
 * Fetch fixtures from LiveFootballOnTV for a team.
 * This source provides UK TV channels for fixtures.
 * @param {string} teamName - Team name
 * @param {number} daysAhead - Number of days to look ahead
 * @returns {Promise<Array>} Array of normalized fixtures
 */
async function fetchFromLFOTV(teamName, daysAhead) {
  try {
    const result = await livefootballontv.fetchLFOTVFixtures({ teamName });
    
    if (!result.fixtures || result.fixtures.length === 0) {
      return [];
    }
    
    const now = new Date();
    const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    
    const fixtures = [];
    for (const match of result.fixtures) {
      // Build tvByRegion with source attribution
      const tvByRegion = [];
      if (match.channels && match.channels.length > 0) {
        for (const channel of match.channels) {
          tvByRegion.push({
            region: 'UK',
            channel,
            source: 'LFOTV'
          });
        }
      }
      
      const fixture = normalizeFixture({
        kickoffUtc: match.kickoffUtc,
        home: match.home,
        away: match.away,
        competition: match.competition,
        channels: match.channels || [],
        tvByRegion
      }, 'LFOTV');
      
      // Filter by date range (if we have a date)
      if (fixture.start) {
        if (fixture.start >= now && fixture.start <= cutoff) {
          fixtures.push(fixture);
        }
      } else {
        // No date info - include anyway
        fixtures.push(fixture);
      }
    }
    
    return fixtures;
  } catch (err) {
    log(`LFOTV error for ${teamName}: ${err.message}`);
    return [];
  }
}

// ---------- Additional TV Channel Fetchers ----------

/**
 * Fetch TV channels from Sky Sports for a team.
 * @param {string} teamName - Team name
 * @param {number} daysAhead - Number of days to look ahead
 * @returns {Promise<Array>} Array of normalized fixtures with TV channels
 */
async function fetchFromSkySports(teamName, daysAhead) {
  if (!skysports) return [];
  
  try {
    const result = await skysports.fetchSkyFixtures({ teamName });
    
    if (!result.fixtures || result.fixtures.length === 0) {
      return [];
    }
    
    const now = new Date();
    const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    
    const fixtures = [];
    for (const match of result.fixtures) {
      // Build tvByRegion with source attribution
      const tvByRegion = [];
      if (match.channels && match.channels.length > 0) {
        for (const channel of match.channels) {
          tvByRegion.push({
            region: 'UK',
            channel,
            source: 'SKY'
          });
        }
      }
      
      const fixture = normalizeFixture({
        kickoffUtc: match.kickoffUtc,
        home: match.home,
        away: match.away,
        competition: match.competition,
        channels: match.channels || [],
        tvByRegion
      }, 'SKY');
      
      // Filter by date range (if we have a date)
      if (fixture.start) {
        if (fixture.start >= now && fixture.start <= cutoff) {
          fixtures.push(fixture);
        }
      } else {
        fixtures.push(fixture);
      }
    }
    
    return fixtures;
  } catch (err) {
    log(`SKY error for ${teamName}: ${err.message}`);
    return [];
  }
}

/**
 * Fetch TV channels from TNT Sports for a team.
 * @param {string} teamName - Team name
 * @param {number} daysAhead - Number of days to look ahead
 * @returns {Promise<Array>} Array of normalized fixtures with TV channels
 */
async function fetchFromTNT(teamName, daysAhead) {
  if (!tnt) return [];
  
  try {
    const result = await tnt.fetchTNTFixtures({ teamName });
    
    if (!result.fixtures || result.fixtures.length === 0) {
      return [];
    }
    
    const now = new Date();
    const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    
    const fixtures = [];
    for (const match of result.fixtures) {
      // Build tvByRegion with source attribution
      const tvByRegion = [];
      if (match.channels && match.channels.length > 0) {
        for (const channel of match.channels) {
          tvByRegion.push({
            region: 'UK',
            channel,
            source: 'TNT'
          });
        }
      }
      
      const fixture = normalizeFixture({
        kickoffUtc: match.kickoffUtc,
        home: match.home,
        away: match.away,
        competition: match.competition,
        channels: match.channels || [],
        tvByRegion
      }, 'TNT');
      
      // Filter by date range (if we have a date)
      if (fixture.start) {
        if (fixture.start >= now && fixture.start <= cutoff) {
          fixtures.push(fixture);
        }
      } else {
        fixtures.push(fixture);
      }
    }
    
    return fixtures;
  } catch (err) {
    log(`TNT error for ${teamName}: ${err.message}`);
    return [];
  }
}

// ---------- TV Channel Merging ----------

/**
 * Merge TV channel information from multiple fixtures.
 * Collects all unique channels and tvByRegion entries.
 * @param {Object} existing - Existing fixture
 * @param {Object} newFixture - New fixture with potentially more TV data
 */
function mergeTvChannels(existing, newFixture) {
  // Merge flat channel list
  const existingChannels = new Set(existing.tvChannels || []);
  for (const ch of newFixture.tvChannels || []) {
    existingChannels.add(ch);
  }
  existing.tvChannels = Array.from(existingChannels);
  
  // Merge tvByRegion with deduplication
  const existingByRegion = existing.tvByRegion || [];
  const newByRegion = newFixture.tvByRegion || [];
  
  // Track seen region+channel combinations
  const seen = new Set();
  for (const entry of existingByRegion) {
    const key = `${(entry.region || '').toLowerCase()}|${(entry.channel || '').toLowerCase()}`;
    seen.add(key);
  }
  
  // Add new entries that aren't duplicates
  for (const entry of newByRegion) {
    const key = `${(entry.region || '').toLowerCase()}|${(entry.channel || '').toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      existingByRegion.push(entry);
    }
  }
  
  existing.tvByRegion = existingByRegion;
}

// ---------- Main Aggregator Function ----------

/**
 * Get fixtures for a team from multiple web scrapers.
 * This is a web scraper-based alternative to getFixturesFromIcs.
 * 
 * IMPORTANT: Collects TV channels from ALL sources and merges them.
 * Each source may find different channels, so we aggregate everything.
 *
 * @param {Object} options - Options
 * @param {string} options.teamName - Team name to search for (required)
 * @param {string} options.teamLabel - Display label for the team (optional)
 * @param {number} [options.daysAhead=7] - Number of days to look ahead
 * @param {boolean} [options.useTSDB=true] - Use TheSportsDB
 * @param {boolean} [options.useBBC=true] - Use BBC Sport
 * @param {boolean} [options.useLFOTV=true] - Use LiveFootballOnTV
 * @param {boolean} [options.useSkySports=true] - Use Sky Sports
 * @param {boolean} [options.useTNT=true] - Use TNT Sports
 * @returns {Promise<Array>} Array of normalized fixtures with all TV channels merged
 */
async function getFixturesFromScrapers(options = {}) {
  const {
    teamName,
    teamLabel,
    daysAhead = DEFAULT_DAYS_AHEAD,
    useTSDB = true,
    useBBC = true,
    useLFOTV = true,
    useSkySports = true,
    useTNT = true
  } = options;
  
  if (!teamName) {
    log('Missing teamName parameter');
    return [];
  }
  
  log(`Fetching fixtures for ${teamName} (${daysAhead} days ahead)`);
  
  // Collect fixtures from all enabled sources
  const allFixtures = [];
  const sourcesUsed = [];
  
  // TheSportsDB (primary source - most reliable for fixture data)
  if (useTSDB) {
    const tsdbFixtures = await fetchFromTSDB(teamName, daysAhead);
    if (tsdbFixtures.length > 0) {
      allFixtures.push(...tsdbFixtures);
      sourcesUsed.push('TSDB');
      log(`TSDB: Found ${tsdbFixtures.length} fixtures for ${teamName}`);
    }
  }
  
  // BBC Sport (good for UK teams, fixture data)
  if (useBBC) {
    const bbcFixtures = await fetchFromBBC(teamName, daysAhead);
    if (bbcFixtures.length > 0) {
      allFixtures.push(...bbcFixtures);
      sourcesUsed.push('BBC');
      log(`BBC: Found ${bbcFixtures.length} fixtures for ${teamName}`);
    }
  }
  
  // LiveFootballOnTV (UK fixtures with TV channels)
  if (useLFOTV) {
    const lfotvFixtures = await fetchFromLFOTV(teamName, daysAhead);
    if (lfotvFixtures.length > 0) {
      allFixtures.push(...lfotvFixtures);
      sourcesUsed.push('LFOTV');
      const tvCount = lfotvFixtures.reduce((sum, f) => sum + (f.tvChannels?.length || 0), 0);
      log(`LFOTV: Found ${lfotvFixtures.length} fixtures with ${tvCount} TV channels for ${teamName}`);
    }
  }
  
  // Sky Sports (UK TV channels)
  if (useSkySports && skysports) {
    const skyFixtures = await fetchFromSkySports(teamName, daysAhead);
    if (skyFixtures.length > 0) {
      allFixtures.push(...skyFixtures);
      sourcesUsed.push('SKY');
      const tvCount = skyFixtures.reduce((sum, f) => sum + (f.tvChannels?.length || 0), 0);
      log(`SKY: Found ${skyFixtures.length} fixtures with ${tvCount} TV channels for ${teamName}`);
    }
  }
  
  // TNT Sports (UK TV channels)
  if (useTNT && tnt) {
    const tntFixtures = await fetchFromTNT(teamName, daysAhead);
    if (tntFixtures.length > 0) {
      allFixtures.push(...tntFixtures);
      sourcesUsed.push('TNT');
      const tvCount = tntFixtures.reduce((sum, f) => sum + (f.tvChannels?.length || 0), 0);
      log(`TNT: Found ${tntFixtures.length} fixtures with ${tvCount} TV channels for ${teamName}`);
    }
  }
  
  if (allFixtures.length === 0) {
    log(`No fixtures found for ${teamName} from any source`);
    return [];
  }
  
  // Deduplicate fixtures and merge TV channels from all sources
  const seen = new Map();
  const merged = [];
  
  for (const fixture of allFixtures) {
    const key = getFixtureKey(fixture);
    
    if (seen.has(key)) {
      // Merge TV channels from duplicate fixture
      const existing = seen.get(key);
      mergeTvChannels(existing, fixture);
      
      // Use more complete data from any source
      if (!existing.location && fixture.location) {
        existing.location = fixture.location;
      }
      if (!existing.competition && fixture.competition) {
        existing.competition = fixture.competition;
      }
      if (!existing.start && fixture.start) {
        existing.start = fixture.start;
      }
    } else {
      // Add team label if provided
      if (teamLabel) {
        fixture.teamLabel = teamLabel;
      }
      seen.set(key, fixture);
      merged.push(fixture);
    }
  }
  
  // Sort by start time
  merged.sort((a, b) => {
    if (!a.start && !b.start) return 0;
    if (!a.start) return 1;
    if (!b.start) return -1;
    return a.start.getTime() - b.start.getTime();
  });
  
  // Calculate total TV channels collected
  const totalTvChannels = merged.reduce((sum, f) => sum + (f.tvChannels?.length || 0), 0);
  const totalTvByRegion = merged.reduce((sum, f) => sum + (f.tvByRegion?.length || 0), 0);
  
  log(`Merged: ${merged.length} unique fixtures for ${teamName} from [${sourcesUsed.join(',')}], TV channels: ${totalTvChannels}, by region: ${totalTvByRegion}`);
  
  return merged;
}

/**
 * Get fixtures for multiple teams from web scrapers.
 * Collects and merges TV channels from all sources.
 *
 * @param {Object} options - Options
 * @param {Array<{label: string, slug: string}>} options.teams - Array of team objects
 * @param {number} [options.daysAhead=7] - Number of days to look ahead
 * @param {number} [options.maxTeams=10] - Maximum number of teams to process
 * @param {number} [options.delayMs=1000] - Delay between team lookups
 * @param {boolean} [options.useTSDB=true] - Use TheSportsDB
 * @param {boolean} [options.useBBC=true] - Use BBC Sport
 * @param {boolean} [options.useLFOTV=true] - Use LiveFootballOnTV
 * @param {boolean} [options.useSkySports=true] - Use Sky Sports
 * @param {boolean} [options.useTNT=true] - Use TNT Sports
 * @returns {Promise<Array>} Array of normalized fixtures with all TV channels
 */
async function getFixturesForTeams(options = {}) {
  const {
    teams = [],
    daysAhead = DEFAULT_DAYS_AHEAD,
    maxTeams = 10,
    delayMs = 1000,
    useTSDB = true,
    useBBC = true,
    useLFOTV = true,
    useSkySports = true,
    useTNT = true
  } = options;
  
  if (!teams || teams.length === 0) {
    log('No teams provided');
    return [];
  }
  
  log(`Fetching fixtures for ${Math.min(teams.length, maxTeams)} teams (max ${maxTeams})`);
  
  const allFixtures = [];
  const processedTeams = teams.slice(0, maxTeams);
  
  for (let i = 0; i < processedTeams.length; i++) {
    const team = processedTeams[i];
    const teamName = team.label || team.slug || '';
    
    if (!teamName) {
      continue;
    }
    
    try {
      const fixtures = await getFixturesFromScrapers({
        teamName,
        teamLabel: team.label,
        daysAhead,
        useTSDB,
        useBBC,
        useLFOTV,
        useSkySports,
        useTNT
      });
      
      allFixtures.push(...fixtures);
    } catch (err) {
      log(`Error fetching fixtures for ${teamName}: ${err.message}`);
    }
    
    // Rate limiting between teams
    if (i < processedTeams.length - 1 && delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  // Deduplicate across all teams and merge TV channels
  const seen = new Map();
  const merged = [];
  
  for (const fixture of allFixtures) {
    const key = getFixtureKey(fixture);
    
    if (seen.has(key)) {
      // Merge TV channels from duplicate
      mergeTvChannels(seen.get(key), fixture);
    } else {
      seen.set(key, fixture);
      merged.push(fixture);
    }
  }
  
  // Sort by start time
  merged.sort((a, b) => {
    if (!a.start && !b.start) return 0;
    if (!a.start) return 1;
    if (!b.start) return -1;
    return a.start.getTime() - b.start.getTime();
  });
  
  // Calculate total TV channels
  const totalTvChannels = merged.reduce((sum, f) => sum + (f.tvChannels?.length || 0), 0);
  
  log(`Total: ${merged.length} unique fixtures from ${processedTeams.length} teams, TV channels: ${totalTvChannels}`);
  
  return merged;
}

/**
 * Perform a health check on all scraper sources.
 * @returns {Promise<{ok: boolean, sources: Object}>}
 */
async function healthCheck() {
  const results = {
    tsdb: null,
    bbc: null,
    lfotv: null,
    sky: null,
    tnt: null
  };
  
  try {
    results.tsdb = await tsdb.healthCheck();
  } catch (err) {
    results.tsdb = { ok: false, error: err.message };
  }
  
  try {
    results.bbc = await bbcFixtures.healthCheck();
  } catch (err) {
    results.bbc = { ok: false, error: err.message };
  }
  
  try {
    results.lfotv = await livefootballontv.healthCheck();
  } catch (err) {
    results.lfotv = { ok: false, error: err.message };
  }
  
  // Optional scrapers
  if (skysports) {
    try {
      results.sky = await skysports.healthCheck();
    } catch (err) {
      results.sky = { ok: false, error: err.message };
    }
  } else {
    results.sky = { ok: false, error: 'Not available' };
  }
  
  if (tnt) {
    try {
      results.tnt = await tnt.healthCheck();
    } catch (err) {
      results.tnt = { ok: false, error: err.message };
    }
  } else {
    results.tnt = { ok: false, error: 'Not available' };
  }
  
  // Consider ok if at least one primary source is working
  const primaryOk = (results.tsdb?.ok || results.bbc?.ok || results.lfotv?.ok);
  
  return {
    ok: primaryOk,
    sources: results
  };
}

// ---------- Module Exports ----------

module.exports = {
  getFixturesFromScrapers,
  getFixturesForTeams,
  healthCheck,
  // Export helpers for testing
  normalizeTeamName,
  teamsMatch,
  normalizeFixture,
  getFixtureKey,
  mergeTvChannels,
  DEFAULT_DAYS_AHEAD
};
