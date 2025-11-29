// aggregators/tv_channels.js
// Universal TV channel aggregator that merges data from multiple sources.
/**
 * Telegram Sports TV Bot – Universal TV Data Aggregator
 *
 * This module provides a single unified function `getTvDataForFixture()` that:
 * - Calls multiple TV data sources (TSDB, FootballData, LSTV, BBC, Sky, TNT, LFOTV, Wiki)
 * - Merges results into a canonical fixture TV data format
 * - Never throws; catches errors and continues with available data
 *
 * Canonical fixture TV data returned:
 * {
 *   homeTeam: string,
 *   awayTeam: string,
 *   league: string | null,
 *   venue?: string | null,
 *   kickoffUtc: string | null,    // ISO string
 *   kickoffLocal?: string | null, // formatted string in requested timezone
 *   tvRegions: Array<{ region: string, channel: string, source: string }>,
 *   tvStationsFlat: string[],     // de-duplicated list of all stations
 *   sourcesUsed: { lstv?: boolean, tsdb?: boolean, ... }
 * }
 *
 * All logs use prefix [AGG]
 */

const fs = require('fs');
const path = require('path');

// Import scrapers
const tsdb = require('../scrapers/thesportsdb');
const lstv = require('../scrapers/lstv');
const wiki = require('../scrapers/wiki_broadcasters');

// Optional scrapers - will be loaded lazily if available
let footballdata = null;
let bbcFixtures = null;
let skysports = null;
let tnt = null;
let livefootballontv = null;

// Try to load optional scrapers
try { footballdata = require('../scrapers/footballdata'); } catch (err) { /* not available */ }
try { bbcFixtures = require('../scrapers/bbc_fixtures'); } catch (err) { /* not available */ }
try { skysports = require('../scrapers/skysports'); } catch (err) { /* not available */ }
try { tnt = require('../scrapers/tnt'); } catch (err) { /* not available */ }
try { livefootballontv = require('../scrapers/livefootballontv'); } catch (err) { /* not available */ }

// ---------- Configuration ----------

const LOG_PATH = path.join(__dirname, '..', 'autopost.log');

// ---------- Logging ----------

/**
 * Log a message with [AGG] prefix.
 * @param {string} msg - Message to log
 */
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [AGG] ${msg}`;
  console.log(line);
  
  try {
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
  } catch (err) {
    // Ignore file errors
  }
}

/**
 * Log an error from a source.
 * @param {string} source - Source name (e.g., 'LSTV', 'TSDB')
 * @param {string} errorMsg - Error message
 */
function logSourceError(source, errorMsg) {
  log(`[${source}] error: ${errorMsg}`);
}

// ---------- Helpers ----------

/**
 * Format a kickoff time in a specific timezone.
 * @param {string|Date} utcTime - UTC time (ISO string or Date)
 * @param {string} timezone - IANA timezone (e.g., 'Europe/London')
 * @returns {string|null} Formatted local time or null
 */
function formatKickoffLocal(utcTime, timezone) {
  if (!utcTime) return null;
  
  try {
    const date = utcTime instanceof Date ? utcTime : new Date(utcTime);
    if (isNaN(date.getTime())) return null;
    
    return date.toLocaleString('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (err) {
    return null;
  }
}

/**
 * Normalize a string for case-insensitive comparison.
 * @param {string} str - String to normalize
 * @returns {string} Normalized string
 */
function normalizeForComparison(str) {
  return (str || '').toLowerCase().trim();
}

/**
 * Check if two channel names are the same (case-insensitive).
 * @param {string} a - First channel name
 * @param {string} b - Second channel name
 * @returns {boolean}
 */
function channelsEqual(a, b) {
  return normalizeForComparison(a) === normalizeForComparison(b);
}

/**
 * Deduplicate an array of region/channel entries.
 * @param {Array<{region: string, channel: string, source: string}>} entries
 * @returns {Array<{region: string, channel: string, source: string}>}
 */
function deduplicateRegionChannels(entries) {
  const seen = new Set();
  const result = [];
  
  for (const entry of entries) {
    const key = `${normalizeForComparison(entry.region)}|${normalizeForComparison(entry.channel)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  
  return result;
}

/**
 * Extract unique station names from all sources.
 * @param {Array<{region: string, channel: string}>} regionChannels
 * @param {string[]} additionalStations - Additional station names
 * @returns {string[]} Deduplicated list of station names
 */
function buildFlatStationList(regionChannels, additionalStations = []) {
  const seen = new Set();
  const result = [];
  
  // Add from regionChannels
  for (const entry of regionChannels) {
    const normalized = normalizeForComparison(entry.channel);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(entry.channel);
    }
  }
  
  // Add additional stations
  for (const station of additionalStations) {
    const normalized = normalizeForComparison(station);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(station);
    }
  }
  
  return result;
}

// ---------- Main Aggregator Function ----------

/**
 * Get unified TV data for a fixture from all available sources.
 *
 * @param {Object} baseFixture - Base fixture information
 * @param {string} baseFixture.homeTeam - Home team name
 * @param {string} baseFixture.awayTeam - Away team name
 * @param {string|Date} baseFixture.dateUtc - Kickoff estimate (Date or ISO string)
 * @param {string} [baseFixture.leagueHint] - Optional league name hint
 * @param {string} [baseFixture.tsdbTeamId] - Optional TheSportsDB team ID
 * @param {string} [baseFixture.footballdataTeamId] - Optional FootballData.org team ID
 * @param {Object} [options={}] - Options
 * @param {string} [options.timezone] - Timezone for local time formatting (e.g., 'Europe/London')
 * @param {boolean} [options.debug] - Enable debug logging
 * @returns {Promise<Object>} Canonical fixture TV data
 */
async function getTvDataForFixture(baseFixture, options = {}) {
  const { timezone = 'Europe/London', debug = false } = options;
  
  const homeTeam = baseFixture.homeTeam || '';
  const awayTeam = baseFixture.awayTeam || '';
  const dateUtc = baseFixture.dateUtc instanceof Date 
    ? baseFixture.dateUtc 
    : new Date(baseFixture.dateUtc || Date.now());
  const leagueHint = baseFixture.leagueHint || null;
  
  log(`${homeTeam} v ${awayTeam} – starting aggregation`);
  
  // Initialize result structure
  const result = {
    homeTeam,
    awayTeam,
    league: null,
    venue: null,
    kickoffUtc: null,
    kickoffLocal: null,
    tvRegions: [],
    tvStationsFlat: [],
    sourcesUsed: {}
  };
  
  // Collect additional stations from various sources
  const additionalStations = [];
  
  // ---------- 1. TheSportsDB ----------
  let tsdbResult = null;
  try {
    tsdbResult = await tsdb.fetchTSDBFixture({
      home: homeTeam,
      away: awayTeam,
      date: dateUtc
    });
    
    if (tsdbResult.matched) {
      result.sourcesUsed.tsdb = true;
      
      // Use TSDB for kickoff, league, venue
      if (tsdbResult.kickoffUtc) {
        result.kickoffUtc = tsdbResult.kickoffUtc;
      }
      if (tsdbResult.league) {
        result.league = tsdbResult.league;
      }
      if (tsdbResult.venue) {
        result.venue = tsdbResult.venue;
      }
      
      // Add TV stations to additional list
      if (tsdbResult.tvStations && tsdbResult.tvStations.length > 0) {
        additionalStations.push(...tsdbResult.tvStations);
      }
      
      if (debug) {
        log(`[TSDB] Matched: league=${tsdbResult.league}, kickoff=${tsdbResult.kickoffUtc}, stations=${tsdbResult.tvStations?.length || 0}`);
      }
    } else {
      result.sourcesUsed.tsdb = false;
      if (debug) log('[TSDB] No match found');
    }
  } catch (err) {
    result.sourcesUsed.tsdb = false;
    logSourceError('TSDB', err.message || String(err));
  }
  
  // ---------- 2. FootballData.org (optional) ----------
  if (footballdata && baseFixture.footballdataTeamId) {
    try {
      const fbdResult = await footballdata.fetchFootballData({
        teamId: baseFixture.footballdataTeamId,
        dateUtc
      });
      
      if (fbdResult) {
        result.sourcesUsed.footballdata = true;
        
        // Use as backup for kickoff/league if not from TSDB
        if (!result.kickoffUtc && fbdResult.kickoffUtc) {
          result.kickoffUtc = fbdResult.kickoffUtc;
        }
        if (!result.league && fbdResult.league) {
          result.league = fbdResult.league;
        }
        
        if (debug) log(`[FBD] Got: league=${fbdResult.league}, kickoff=${fbdResult.kickoffUtc}`);
      }
    } catch (err) {
      result.sourcesUsed.footballdata = false;
      logSourceError('FBD', err.message || String(err));
    }
  }
  
  // ---------- 3. LiveSoccerTV (detailed regionChannels) ----------
  try {
    const lstvResult = await lstv.fetchLSTV({
      home: homeTeam,
      away: awayTeam,
      date: dateUtc,
      kickoffUtc: result.kickoffUtc || null,
      league: result.league || leagueHint
    });
    
    if (lstvResult.regionChannels && lstvResult.regionChannels.length > 0) {
      result.sourcesUsed.lstv = true;
      
      // Add LSTV channels with source tag
      for (const rc of lstvResult.regionChannels) {
        result.tvRegions.push({
          region: rc.region,
          channel: rc.channel,
          source: 'LSTV'
        });
      }
      
      // Use LSTV kickoff as fallback
      if (!result.kickoffUtc && lstvResult.kickoffUtc) {
        result.kickoffUtc = lstvResult.kickoffUtc;
      }
      
      if (debug) log(`[LSTV] Found ${lstvResult.regionChannels.length} channels`);
    } else {
      result.sourcesUsed.lstv = false;
      if (debug) log('[LSTV] No channels found');
    }
  } catch (err) {
    result.sourcesUsed.lstv = false;
    logSourceError('LSTV', err.message || String(err));
  }
  
  // ---------- 4. BBC Fixtures (optional) ----------
  if (bbcFixtures) {
    try {
      const bbcResult = await bbcFixtures.fetchBBCFixtures({ teamName: homeTeam });
      
      if (bbcResult.matches && bbcResult.matches.length > 0) {
        // Find matching fixture
        const match = bbcResult.matches.find(m => {
          const homeMatch = normalizeForComparison(m.home).includes(normalizeForComparison(homeTeam)) ||
                           normalizeForComparison(homeTeam).includes(normalizeForComparison(m.home));
          const awayMatch = normalizeForComparison(m.away).includes(normalizeForComparison(awayTeam)) ||
                           normalizeForComparison(awayTeam).includes(normalizeForComparison(m.away));
          return homeMatch && awayMatch;
        });
        
        if (match) {
          result.sourcesUsed.bbc = true;
          
          // Use BBC competition as fallback league
          if (!result.league && match.competition) {
            result.league = match.competition;
          }
          
          if (debug) log(`[BBC] Matched: competition=${match.competition}`);
        }
      }
    } catch (err) {
      result.sourcesUsed.bbc = false;
      logSourceError('BBC', err.message || String(err));
    }
  }
  
  // ---------- 5. Sky Sports fixtures (optional TV) ----------
  if (skysports) {
    try {
      const skyResult = await skysports.fetchSkyFixtures({ teamName: homeTeam });
      
      if (skyResult.fixtures && skyResult.fixtures.length > 0) {
        // Find matching fixture
        const match = skyResult.fixtures.find(f => {
          const homeMatch = normalizeForComparison(f.home).includes(normalizeForComparison(homeTeam)) ||
                           normalizeForComparison(homeTeam).includes(normalizeForComparison(f.home));
          const awayMatch = normalizeForComparison(f.away).includes(normalizeForComparison(awayTeam)) ||
                           normalizeForComparison(awayTeam).includes(normalizeForComparison(f.away));
          return homeMatch && awayMatch;
        });
        
        if (match) {
          result.sourcesUsed.sky = true;
          
          // Add Sky channels
          if (match.channels && match.channels.length > 0) {
            for (const channel of match.channels) {
              result.tvRegions.push({
                region: 'UK',
                channel,
                source: 'SKY'
              });
            }
            additionalStations.push(...match.channels);
          }
          
          if (debug) log(`[SKY] Matched with ${match.channels?.length || 0} channels`);
        }
      }
    } catch (err) {
      result.sourcesUsed.sky = false;
      logSourceError('SKY', err.message || String(err));
    }
  }
  
  // ---------- 6. TNT Sports fixtures (optional TV) ----------
  if (tnt) {
    try {
      const tntResult = await tnt.fetchTNTFixtures({ teamName: homeTeam });
      
      if (tntResult.fixtures && tntResult.fixtures.length > 0) {
        // Find matching fixture
        const match = tntResult.fixtures.find(f => {
          const homeMatch = normalizeForComparison(f.home).includes(normalizeForComparison(homeTeam)) ||
                           normalizeForComparison(homeTeam).includes(normalizeForComparison(f.home));
          const awayMatch = normalizeForComparison(f.away).includes(normalizeForComparison(awayTeam)) ||
                           normalizeForComparison(awayTeam).includes(normalizeForComparison(f.away));
          return homeMatch && awayMatch;
        });
        
        if (match) {
          result.sourcesUsed.tnt = true;
          
          // Add TNT channels
          if (match.channels && match.channels.length > 0) {
            for (const channel of match.channels) {
              result.tvRegions.push({
                region: 'UK',
                channel,
                source: 'TNT'
              });
            }
            additionalStations.push(...match.channels);
          }
          
          if (debug) log(`[TNT] Matched with ${match.channels?.length || 0} channels`);
        }
      }
    } catch (err) {
      result.sourcesUsed.tnt = false;
      logSourceError('TNT', err.message || String(err));
    }
  }
  
  // ---------- 7. LiveFootballOnTV (optional TV) ----------
  if (livefootballontv) {
    try {
      const lfotvResult = await livefootballontv.fetchLFOTVFixtures({ teamName: homeTeam });
      
      if (lfotvResult.fixtures && lfotvResult.fixtures.length > 0) {
        // Find matching fixture
        const match = lfotvResult.fixtures.find(f => {
          const homeMatch = normalizeForComparison(f.home).includes(normalizeForComparison(homeTeam)) ||
                           normalizeForComparison(homeTeam).includes(normalizeForComparison(f.home));
          const awayMatch = normalizeForComparison(f.away).includes(normalizeForComparison(awayTeam)) ||
                           normalizeForComparison(awayTeam).includes(normalizeForComparison(f.away));
          return homeMatch && awayMatch;
        });
        
        if (match) {
          result.sourcesUsed.lfotv = true;
          
          // Add LFOTV channels
          if (match.channels && match.channels.length > 0) {
            for (const channel of match.channels) {
              result.tvRegions.push({
                region: 'UK',
                channel,
                source: 'LFOTV'
              });
            }
            additionalStations.push(...match.channels);
          }
          
          if (debug) log(`[LFOTV] Matched with ${match.channels?.length || 0} channels`);
        }
      }
    } catch (err) {
      result.sourcesUsed.lfotv = false;
      logSourceError('LFOTV', err.message || String(err));
    }
  }
  
  // ---------- 8. Wikipedia broadcasters ----------
  const leagueName = result.league || leagueHint;
  if (leagueName) {
    try {
      const wikiResult = await wiki.fetchWikiBroadcasters({
        leagueName,
        season: null, // Auto-detect
        country: null // Get all regions
      });
      
      if (wikiResult.broadcasters && wikiResult.broadcasters.length > 0) {
        result.sourcesUsed.wiki = true;
        
        // Add Wikipedia broadcasters only if not already present
        for (const wb of wikiResult.broadcasters) {
          const alreadyExists = result.tvRegions.some(r => 
            normalizeForComparison(r.region) === normalizeForComparison(wb.region) &&
            normalizeForComparison(r.channel) === normalizeForComparison(wb.channel)
          );
          
          if (!alreadyExists) {
            result.tvRegions.push({
              region: wb.region,
              channel: wb.channel,
              source: 'WIKI'
            });
          }
        }
        
        // Add to additional stations
        additionalStations.push(...wikiResult.broadcasters.map(b => b.channel));
        
        if (debug) log(`[WIKI] Found ${wikiResult.broadcasters.length} broadcasters for ${leagueName}`);
      } else {
        result.sourcesUsed.wiki = false;
        if (debug) log(`[WIKI] No broadcasters found for ${leagueName}`);
      }
    } catch (err) {
      result.sourcesUsed.wiki = false;
      logSourceError('WIKI', err.message || String(err));
    }
  }
  
  // ---------- Final processing ----------
  
  // Use baseFixture.dateUtc as final fallback for kickoffUtc
  if (!result.kickoffUtc && dateUtc) {
    result.kickoffUtc = dateUtc.toISOString();
  }
  
  // Use leagueHint as final fallback for league
  if (!result.league && leagueHint) {
    result.league = leagueHint;
  }
  
  // Deduplicate tvRegions
  result.tvRegions = deduplicateRegionChannels(result.tvRegions);
  
  // Build flat station list
  result.tvStationsFlat = buildFlatStationList(result.tvRegions, additionalStations);
  
  // Format local time if timezone provided
  if (timezone && result.kickoffUtc) {
    result.kickoffLocal = formatKickoffLocal(result.kickoffUtc, timezone);
  }
  
  // Log summary
  const sourcesStr = Object.entries(result.sourcesUsed)
    .filter(([, used]) => used)
    .map(([name]) => name.toUpperCase())
    .join(',') || 'none';
  
  log(`${homeTeam} v ${awayTeam} (${result.league || 'unknown'}) – kickoff=${result.kickoffUtc || 'unknown'} local=${result.kickoffLocal || 'unknown'} stations=${result.tvStationsFlat.length} sources={${sourcesStr}}`);
  
  return result;
}

// ---------- Module Exports ----------

module.exports = {
  getTvDataForFixture,
  // Export helpers for testing
  formatKickoffLocal,
  deduplicateRegionChannels,
  buildFlatStationList,
  normalizeForComparison,
  channelsEqual
};
