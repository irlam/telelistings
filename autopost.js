// autopost.js
// Autoposter that can:
//  - In "TheFishy multi" mode: pull fixtures from multiple team ICS feeds (one per team, capped & throttled).
//  - In default mode: pull from a single ICS URL and filter by team names.
/**
 * Telegram Sports TV Bot – Autoposter
 *
 * Reads config.json and posts “what’s on” football fixtures into Telegram channels.
 * Two modes per channel:
 *  1) TheFishy multi-ICS mode (useTheFishyMulti: true):
 *     - Each team has an ICS at https://thefishy.co.uk/calendar/<Team+Name>.
 *     - Only fetch up to multiMaxTeams per run, with multiIcsDelayMs between requests.
 *     - Merge fixtures across teams, dedupe, sort, and post one combined message.
 *     - Be polite: stop fetching if we hit HTTP 429 (rate limit).
 *  2) Single-ICS mode:
 *     - Use cfg.icsUrl or channel.icsUrl.
 *     - Optionally filter fixtures by team names.
 *
 * Uses getFixturesFromIcs(...) from ics_source.js.
 * Sends messages via Telegram Bot API (sendMessage).
 * Logs to autopost.log using logLine().
 *
 * Constraints:
 * - No DB, config from config.json.
 * - Plain text messages (no Markdown formatting).
 * - Keep logic small and testable; add good logging for ops.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getFixturesFromIcs } = require('./ics_source');
const theSportsDb = require('./thesportsdb');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, 'autopost.log');

// ---------- logging helpers ----------

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    now.getFullYear() +
    '-' +
    pad(now.getMonth() + 1) +
    '-' +
    pad(now.getDate()) +
    ' ' +
    pad(now.getHours()) +
    ':' +
    pad(now.getMinutes()) +
    ':' +
    pad(now.getSeconds())
  );
}

function logLine(msg) {
  const line = `[${timestamp()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (_) {
    // ignore file errors
  }
  console.log(line.trim());
}

// ---------- config helpers ----------

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`config.json not found at ${CONFIG_PATH}`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

// ---------- Telegram helper ----------

async function sendTelegramMessage(botToken, channelId, text) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(
    botToken
  )}/sendMessage`;

  const payload = {
    chat_id: channelId,
    text: text
    // plain text – no Markdown to avoid escaping headaches
  };

  const resp = await axios.post(url, payload, {
    timeout: 15000
  });

  if (!resp.data || !resp.data.ok) {
    const desc = resp.data && resp.data.description;
    throw new Error(`Telegram sendMessage failed: ${desc || 'unknown error'}`);
  }
}

// ---------- Poster-style formatting helpers ----------

/**
 * Format a time in a given timezone.
 * @param {Date} date - The date to format
 * @param {string} timezone - IANA timezone string (e.g., 'Europe/London')
 * @returns {string} Formatted time string (e.g., "3:00pm")
 */
function formatTimeInZone(date, timezone) {
  try {
    const options = {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone
    };
    return date.toLocaleTimeString('en-US', options).toLowerCase().replace(' ', '');
  } catch (err) {
    // Fallback if timezone is invalid
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).toLowerCase().replace(' ', '');
  }
}

/**
 * Parse team names from a fixture summary.
 * Attempts to split on common separators like "v", "vs", "-", "@".
 * @param {string} summary - Fixture summary (e.g., "Arsenal v Chelsea")
 * @returns {{ homeTeam: string, awayTeam: string }}
 */
function parseTeamsFromSummary(summary) {
  const text = (summary || '').trim();
  
  // Try common separators: " v ", " vs ", " - ", " @ "
  const separators = [/ v /i, / vs /i, / - /, / @ /];
  
  for (const sep of separators) {
    const parts = text.split(sep);
    if (parts.length >= 2) {
      return {
        homeTeam: parts[0].trim(),
        awayTeam: parts.slice(1).join(' ').trim()
      };
    }
  }
  
  // Fallback: return the whole summary as homeTeam
  return {
    homeTeam: text,
    awayTeam: ''
  };
}

/**
 * Adapt a basic fixture object to the poster data model.
 * Adds timeUk, timeEt, homeTeam, awayTeam, and tvByRegion fields.
 * 
 * @param {Object} fixture - Basic fixture object with start, summary, tvChannel, etc.
 * @param {Object} channel - Channel config object
 * @returns {Object} Adapted fixture with poster fields
 */
function adaptFixtureForPoster(fixture) {
  const start = fixture.start instanceof Date ? fixture.start : new Date(fixture.start);
  
  // Format times in UK and US Eastern timezones
  const timeUk = formatTimeInZone(start, 'Europe/London');
  const timeEt = formatTimeInZone(start, 'America/New_York');
  
  // Parse home and away teams from summary
  const { homeTeam, awayTeam } = parseTeamsFromSummary(fixture.summary);
  
  // Build tvByRegion from tvChannel if available (simple conversion)
  // For now, if we have a single tvChannel, put it under a default region
  let tvByRegion = fixture.tvByRegion || [];
  
  if (tvByRegion.length === 0 && fixture.tvChannel) {
    // Single channel - assume UK region
    tvByRegion = [{ region: 'UK', channel: fixture.tvChannel }];
  }
  
  return {
    ...fixture,
    date: start,
    timeUk,
    timeEt,
    homeTeam,
    awayTeam,
    competition: fixture.competition || '',
    venue: fixture.location || fixture.venue || '',
    tvByRegion
  };
}

/**
 * Format a fixture in poster-style layout for Telegram.
 * 
 * Layout:
 * ═══════════════════════════
 * SPORTS LISTINGS ON TV
 * ═══════════════════════════
 * 
 * 3:00pm UK    10:00am ET
 * 
 * BRENTFORD v BURNLEY
 * Premier League
 * 
 * Australia     Stan Sport
 * Canada        Fubo Sports 4
 * Caribbean     ESPN on Disney+
 * ...
 * 
 * Support the listings by subscribing.
 * 
 * @param {Object} fixture - Fixture object with poster fields
 * @param {Object} options - Options for formatting
 * @param {boolean} options.showFooter - Whether to show the footer (default true)
 * @param {string} options.footerText - Custom footer text (default: "Please support the listings by subscribing.")
 * @returns {string} Formatted poster message
 */
const DEFAULT_FOOTER_TEXT = 'Please support the listings by subscribing.';

function formatFixturePoster(fixture, options = {}) {
  const { showFooter = true, footerText = DEFAULT_FOOTER_TEXT } = options;
  
  const lines = [];
  
  // Banner
  lines.push('═══════════════════════════');
  lines.push('   SPORTS LISTINGS ON TV   ');
  lines.push('═══════════════════════════');
  lines.push('');
  
  // Times in two zones
  const timeUk = fixture.timeUk || '';
  const timeEt = fixture.timeEt || '';
  if (timeUk || timeEt) {
    const timeLine = [];
    if (timeUk) timeLine.push(`${timeUk} UK`);
    if (timeEt) timeLine.push(`${timeEt} ET`);
    lines.push(timeLine.join('    '));
    lines.push('');
  }
  
  // Fixture in uppercase
  const homeTeam = (fixture.homeTeam || '').toUpperCase();
  const awayTeam = (fixture.awayTeam || '').toUpperCase();
  if (homeTeam && awayTeam) {
    lines.push(`${homeTeam} v ${awayTeam}`);
  } else if (homeTeam) {
    lines.push(homeTeam);
  }
  
  // Competition (optional)
  if (fixture.competition) {
    lines.push(fixture.competition);
  }
  
  lines.push('');
  
  // TV by Region list
  const tvByRegion = fixture.tvByRegion || [];
  if (tvByRegion.length > 0) {
    // Calculate max region width for alignment
    const maxRegionLen = Math.max(...tvByRegion.map(r => (r.region || '').length));
    
    for (const { region, channel } of tvByRegion) {
      const paddedRegion = (region || '').padEnd(maxRegionLen, ' ');
      lines.push(`${paddedRegion}  ${channel || ''}`);
    }
  } else {
    lines.push('TV details TBC');
  }
  
  // Footer (optional)
  if (showFooter && footerText) {
    lines.push('');
    lines.push(footerText);
  }
  
  return lines.join('\n');
}

// ---------- TheFishy helpers ----------

// Build a TheFishy ICS URL from a team label, e.g.
//   "Man Utd"  -> https://thefishy.co.uk/calendar/Man+Utd
function buildTheFishyIcsUrl(teamLabel) {
  const trimmed = String(teamLabel || '').trim();
  if (!trimmed) return null;

  // Keep letters/numbers/spaces, drop other punctuation from the label.
  const cleaned = trimmed.replace(/[^A-Za-z0-9\s]/g, '');
  // Spaces => plus
  const plus = cleaned.replace(/\s+/g, '+');

  return `https://thefishy.co.uk/calendar/${plus}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- TV channel helpers ----------

/**
 * Look up a TV channel for a fixture based on channel's tvChannelOverrides config.
 *
 * @param {Object} fixture - Fixture object with at least `summary` and optionally `tvChannel`
 * @param {Object} channel - Channel config object with optional `tvChannelOverrides`
 * @returns {string|null} The TV channel name if matched, or null if no match
 */
function getTvChannelForFixture(fixture, channel) {
  // If fixture already has a tvChannel (e.g. from ICS source or TheSportsDB), return it
  if (fixture.tvChannel) {
    return fixture.tvChannel;
  }

  // Check channel's tvChannelOverrides
  const overrides = channel && channel.tvChannelOverrides;
  if (!overrides || typeof overrides !== 'object') {
    return null;
  }

  const summary = (fixture.summary || '').toLowerCase();
  if (!summary) {
    return null;
  }

  // Iterate over override keys and check for case-insensitive match in summary
  for (const key of Object.keys(overrides)) {
    const needle = key.toLowerCase();
    if (summary.includes(needle)) {
      return overrides[key];
    }
  }

  return null;
}

/**
 * Try to enrich a fixture with TV channel info from TheSportsDB API.
 * Falls back gracefully if API key not set or if no TV info found.
 *
 * @param {Object} cfg - Config object with theSportsDbApiKey
 * @param {Object} fixture - Fixture object
 * @param {string} teamLabel - Team name to search for
 * @returns {Promise<Object>} Fixture object (possibly with tvChannel enriched)
 */
async function enrichFixtureWithTheSportsDb(cfg, fixture, teamLabel) {
  const apiKey = cfg.theSportsDbApiKey;
  
  // Skip if no API key configured
  if (!apiKey) {
    return fixture;
  }
  
  // Skip if fixture already has TV channel info
  if (fixture.tvChannel) {
    return fixture;
  }
  
  try {
    const enriched = await theSportsDb.enrichFixtureWithTvInfo(
      apiKey,
      fixture,
      teamLabel,
      'UK'
    );
    return enriched;
  } catch (err) {
    // Log but don't fail - TV enrichment is optional
    logLine(`  [TheSportsDB] Warning: ${err.message}`);
    return fixture;
  }
}

// ---------- build message for a channel ----------

async function buildChannelMessage(cfg, channel) {
  const timezone = cfg.timezone || 'Europe/London';
  const daysAhead = cfg.icsDaysAhead && Number.isFinite(cfg.icsDaysAhead)
    ? cfg.icsDaysAhead
    : 7;

  // --- MODE 1: TheFishy multi-ICS (one ICS per team, capped & throttled) ---
  if (channel.useTheFishyMulti) {
    const allTeamEntries = channel.teams || [];
    if (!allTeamEntries.length) {
      throw new Error(
        'useTheFishyMulti is true but this channel has no teams configured'
      );
    }

    // Cap how many team ICS feeds we hit in a single run
    const maxTeams = Number.isFinite(channel.multiMaxTeams)
      ? channel.multiMaxTeams
      : 10; // default: 10 teams per run

    const delayMs = Number.isFinite(channel.multiIcsDelayMs)
      ? channel.multiIcsDelayMs
      : 1500; // default: 1.5s between requests

    const teams = allTeamEntries.slice(0, maxTeams);

    logLine(
      `Channel "${channel.label || channel.id}": TheFishy multi-ICS mode – using first ${teams.length} of ${allTeamEntries.length} teams (maxTeams=${maxTeams}, delay=${delayMs}ms)`
    );

    const allFixtures = [];
    let hitRateLimit = false;

    for (let i = 0; i < teams.length; i++) {
      const t = teams[i];
      const teamLabel = t.label || t.slug || '';
      if (!teamLabel) {
        logLine(`  Skipping team with no label: ${JSON.stringify(t)}`);
        continue;
      }

      const icsUrl = buildTheFishyIcsUrl(teamLabel);
      if (!icsUrl) {
        logLine(`  Skipping team "${teamLabel}" – could not build ICS URL`);
        continue;
      }

      try {
        logLine(`  Fetching ICS for team "${teamLabel}" from ${icsUrl}`);
        // No extra filtering here; the feed is already per-team.
        const fixtures = await getFixturesFromIcs(
          icsUrl,
          timezone,
          [],
          daysAhead
        );

        fixtures.forEach((f) => {
          allFixtures.push({
            ...f,
            teamLabel
          });
        });

        logLine(
          `  -> ${fixtures.length} fixtures fetched for team "${teamLabel}"`
        );
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        const status = err && err.response && err.response.status;
        logLine(
          `  ERROR fetching ICS for team "${teamLabel}": ${msg}`
        );

        // If TheFishy / Cloudflare gives us 429, stop hammering them this run.
        if (status === 429) {
          logLine(
            '  Hit HTTP 429 (Too Many Requests) – stopping further ICS requests for this run.'
          );
          hitRateLimit = true;
          break;
        }
      }

      // Be polite: small delay between requests
      if (i < teams.length - 1) {
        await sleep(delayMs);
      }
    }

    if (!allFixtures.length) {
      if (hitRateLimit) {
        logLine(
          `Channel "${channel.label || channel.id}": no fixtures collected because of rate limiting.`
        );
      } else {
        logLine(
          `Channel "${channel.label || channel.id}": no fixtures collected from TheFishy multi-ICS.`
        );
      }
      return { text: '', matchCount: 0 };
    }

    // Deduplicate by (startTime + summary) in case overlaps
    const seen = new Set();
    const merged = [];

    for (const f of allFixtures) {
      const startIso =
        f.start instanceof Date ? f.start.toISOString() : new Date(f.start).toISOString();
      const key = `${startIso}|${f.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(f);
    }

    merged.sort((a, b) => {
      const sa =
        a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
      const sb =
        b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
      return sa - sb;
    });

    // Try to enrich fixtures with TV info from TheSportsDB (if API key configured)
    if (cfg.theSportsDbApiKey) {
      logLine(`  Attempting to enrich fixtures with TheSportsDB TV info...`);
      for (let i = 0; i < merged.length; i++) {
        const f = merged[i];
        if (!f.tvChannel && f.teamLabel) {
          merged[i] = await enrichFixtureWithTheSportsDb(cfg, f, f.teamLabel);
          // Small delay to be polite to TheSportsDB API
          if (i < merged.length - 1) {
            await sleep(300);
          }
        }
      }
    }

    // If posterStyle is enabled, return fixtures array for individual poster messages
    if (channel.posterStyle) {
      // Enrich fixtures with TV channel info from overrides
      for (let i = 0; i < merged.length; i++) {
        const tvChannel = getTvChannelForFixture(merged[i], channel);
        if (tvChannel) {
          merged[i].tvChannel = tvChannel;
        }
      }
      
      return {
        text: '',
        matchCount: merged.length,
        fixtures: merged,
        posterStyle: true
      };
    }

    const lines = merged.map((f) => {
      const dt = f.start instanceof Date ? f.start : new Date(f.start);
      const when = dt.toLocaleString('en-GB', {
        timeZone: timezone,
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });

      let line = `${when} – ${f.summary}`;
      if (f.location) line += ` @ ${f.location}`;
      if (f.teamLabel) line += ` [${f.teamLabel}]`;

      // Add TV channel if available
      const tvChannel = getTvChannelForFixture(f, channel);
      if (tvChannel) line += ` (TV: ${tvChannel})`;

      return line;
    });

    const header = `Upcoming fixtures – ${channel.label || channel.id} (next ${daysAhead} day(s))`;
    const text = `${header}\n\n${lines.join('\n')}`;

    return {
      text,
      matchCount: merged.length
    };
  }

  // --- MODE 2: Single ICS URL (global or per-channel), filtered by teams ----
  const icsUrl = channel.icsUrl || cfg.icsUrl;
  if (!icsUrl) {
    throw new Error(
      `No ICS URL configured (channel "${channel.label || channel.id}")`
    );
  }

  const teamNames = (channel.teams || []).map(
    (t) => t.label || t.slug || ''
  );

  logLine(
    `Channel "${channel.label || channel.id}": single ICS mode, url=${icsUrl}, daysAhead=${daysAhead}, teamFilters=${teamNames.length}`
  );

  const fixtures = await getFixturesFromIcs(
    icsUrl,
    timezone,
    teamNames,
    daysAhead
  );

  if (!fixtures.length) {
    return { text: '', matchCount: 0 };
  }

  // Try to enrich fixtures with TV info from TheSportsDB (if API key configured)
  if (cfg.theSportsDbApiKey && teamNames.length) {
    logLine(`  Attempting to enrich fixtures with TheSportsDB TV info...`);
    for (let i = 0; i < fixtures.length; i++) {
      const f = fixtures[i];
      if (!f.tvChannel) {
        // Try to find a matching team for this fixture using word boundary matching
        const summary = (f.summary || '').toLowerCase();
        const matchedTeam = teamNames.find(t => {
          if (!t || t.length < 3) return false;
          const teamLower = t.toLowerCase();
          // Escape special regex characters
          const escaped = teamLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Match with word boundaries
          const regex = new RegExp(`(?:^|[^a-z])${escaped}(?:$|[^a-z])`, 'i');
          return regex.test(summary);
        });
        if (matchedTeam) {
          fixtures[i] = await enrichFixtureWithTheSportsDb(cfg, f, matchedTeam);
          // Small delay to be polite to TheSportsDB API
          if (i < fixtures.length - 1) {
            await sleep(300);
          }
        }
      }
    }
  }

  // If posterStyle is enabled, return fixtures array for individual poster messages
  if (channel.posterStyle) {
    // Enrich fixtures with TV channel info from overrides
    for (let i = 0; i < fixtures.length; i++) {
      const tvChannel = getTvChannelForFixture(fixtures[i], channel);
      if (tvChannel) {
        fixtures[i].tvChannel = tvChannel;
      }
    }
    
    return {
      text: '',
      matchCount: fixtures.length,
      fixtures: fixtures,
      posterStyle: true
    };
  }

  const lines = fixtures.map((f) => {
    const dt = f.start instanceof Date ? f.start : new Date(f.start);
    const when = dt.toLocaleString('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });

    let line = `${when} – ${f.summary}`;
    if (f.location) line += ` @ ${f.location}`;

    // Add TV channel if available
    const tvChannel = getTvChannelForFixture(f, channel);
    if (tvChannel) line += ` (TV: ${tvChannel})`;

    return line;
  });

  const header = `Upcoming fixtures from ICS – ${channel.label || channel.id} (next ${daysAhead} day(s))`;
  const text = `${header}\n\n${lines.join('\n')}`;

  return {
    text,
    matchCount: fixtures.length
  };
}

// ---------- main runner ----------

async function runOnce() {
  const cfg = loadConfig();

  const botToken = cfg.botToken;
  if (!botToken) {
    throw new Error('botToken not set in config.json');
  }

  const channels = cfg.channels || [];
  if (!channels.length) {
    throw new Error('No channels configured in config.json');
  }

  const results = [];
  let totalMatches = 0;
  let sendCount = 0;

  for (const channel of channels) {
    const label = channel.label || channel.id || '(unknown channel)';

    try {
      const buildResult = await buildChannelMessage(cfg, channel);
      const { text, matchCount, posterStyle, fixtures } = buildResult;

      if (!matchCount) {
        logLine(
          `Channel "${label}": no fixtures found for current window (matches=0).`
        );
        results.push({
          channelLabel: label,
          sent: false,
          matchCount: 0
        });
        continue;
      }

      // Handle poster-style messages (one message per fixture)
      if (posterStyle && fixtures && fixtures.length > 0) {
        logLine(
          `Channel "${label}": posting ${fixtures.length} fixtures in poster style.`
        );
        
        let postersSent = 0;
        for (const fixture of fixtures) {
          try {
            // Adapt the fixture for poster format
            const posterFixture = adaptFixtureForPoster(fixture);
            
            // Format the poster message
            const posterText = formatFixturePoster(posterFixture, {
              showFooter: true
            });
            
            // Log the fixture being posted (use already parsed team names)
            const tvRegionCount = posterFixture.tvByRegion ? posterFixture.tvByRegion.length : 0;
            logLine(
              `  Poster for ${posterFixture.homeTeam.toUpperCase()} v ${posterFixture.awayTeam.toUpperCase()} – TV regions: ${tvRegionCount}`
            );
            
            // Send the poster message
            await sendTelegramMessage(botToken, channel.id, posterText);
            postersSent++;
            
            // Small delay between messages to avoid rate limiting
            if (postersSent < fixtures.length) {
              await sleep(500);
            }
          } catch (posterErr) {
            logLine(
              `  ERROR sending poster for "${fixture.summary}": ${posterErr.message || String(posterErr)}`
            );
          }
        }
        
        logLine(
          `Channel "${label}": sent ${postersSent} poster messages.`
        );
        
        results.push({
          channelLabel: label,
          sent: postersSent > 0,
          matchCount,
          posterCount: postersSent
        });
        
        totalMatches += matchCount;
        if (postersSent > 0) sendCount += 1;
        continue;
      }

      // Standard list-style message
      if (!text) {
        logLine(
          `Channel "${label}": no text to send (matches=0).`
        );
        results.push({
          channelLabel: label,
          sent: false,
          matchCount: 0
        });
        continue;
      }

      await sendTelegramMessage(botToken, channel.id, text);
      logLine(
        `Channel "${label}": sent message with ${matchCount} fixtures.`
      );

      results.push({
        channelLabel: label,
        sent: true,
        matchCount
      });

      totalMatches += matchCount;
      sendCount += 1;
    } catch (err) {
      logLine(
        `ERROR for channel "${label}": ${err.message || String(err)}`
      );
      results.push({
        channelLabel: label,
        sent: false,
        matchCount: 0,
        error: err.message || String(err)
      });
    }
  }

  const summary = `Channels=${channels.length}, sent=${sendCount}, totalMatches=${totalMatches}`;
  logLine(`Run summary: ${summary}`);

  return { summary, results };
}

// allow manual CLI run
if (require.main === module) {
  runOnce()
    .then(({ summary }) => {
      console.log('Done:', summary);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Fatal error in runOnce:', err);
      process.exit(1);
    });
}

module.exports = {
  runOnce,
  getTvChannelForFixture,
  formatFixturePoster,
  adaptFixtureForPoster,
  parseTeamsFromSummary,
  formatTimeInZone,
  CONFIG_PATH,
  LOG_PATH
};
