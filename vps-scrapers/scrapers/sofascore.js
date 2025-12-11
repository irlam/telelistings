// scrapers/sofascore.js
// SofaScore football fixture + TV scraper for VPS microservice.
//
// Strategy:
// 1) Use SofaScore schedule API for a given date:
//    GET https://www.sofascore.com/api/v1/sport/football/scheduled-events/YYYY-MM-DD
// 2) For each event we keep, call the TV channels API:
//    GET https://www.sofascore.com/api/v1/event/{id}/tvchannels
//
// NOTE: This is “best effort”. If TV data isn’t present or the API
// shape changes, we just return fixtures with channels = [] so
// the aggregator can still fall back to other sources.

const axios = require("axios");

const BASE_URL = "https://www.sofascore.com/api/v1";
const TIMEOUT = 15000;

// Soft filters to avoid youth / women / reserve comps
const EXCLUDE = [/women/i, /\bu\d{2}\b/i, /youth/i, /reserve/i];

function log(msg) {
  console.log(`[${new Date().toISOString()}] [SOFASCORE] ${msg}`);
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function isExcludedTournament(name) {
  if (!name) return false;
  return EXCLUDE.some((re) => re.test(name));
}

/**
 * Fetch SofaScore schedule JSON for a date.
 */
async function fetchSchedule(date) {
  const d = date || today();
  const url = `${BASE_URL}/sport/football/scheduled-events/${d}`;

  log(`Fetching schedule for ${d}`);
  const { data } = await axios.get(url, {
    timeout: TIMEOUT,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
      Accept: "application/json",
      Referer: "https://www.sofascore.com/",
    },
  });

  const events = Array.isArray(data?.events) ? data.events : [];
  log(`Schedule events returned: ${events.length}`);
  return { d, events };
}

/**
 * Fetch TV channels for a single event ID.
 * Returns an array of channel names (strings).
 */
async function fetchTvChannelsForEvent(eventId) {
  if (!eventId) return [];

  const url = `${BASE_URL}/event/${eventId}/tvchannels`;

  try {
    const { data } = await axios.get(url, {
      timeout: TIMEOUT,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
        Accept: "application/json",
        Referer: "https://www.sofascore.com/",
      },
    });

    // Be defensive about the shape
    const list =
      data?.tvChannels ||
      data?.tvchannels ||
      data?.channels ||
      data?.results ||
      [];

    const names = list
      .map((ch) => {
        if (!ch) return null;
        // Try common shapes: {name}, {channel: {name}}, {shortName}, etc.
        return (
          ch.name ||
          ch.shortName ||
          (ch.channel && ch.channel.name) ||
          (ch.channel && ch.channel.shortName) ||
          null
        );
      })
      .filter(Boolean);

    return Array.from(new Set(names));
  } catch (err) {
    log(`TV channels fetch failed for event ${eventId}: ${err.message}`);
    return [];
  }
}

/**
 * Fetch fixtures + TV info.
 *
 * params:
 *  - date?: 'YYYY-MM-DD' (default: today)
 *  - teamName?: string (filter fixtures containing this team)
 *  - maxEvents?: number (cap number of events to query TV for; default 40)
 */
async function fetchSofaScoreFixturesWithTv(params = {}) {
  const { date, teamName, maxEvents = 40 } = params;
  const needle = teamName ? teamName.toLowerCase() : null;

  const { d, events } = await fetchSchedule(date);

  // Filter the schedule down to relevant football events
  const filtered = events.filter((ev) => {
    const home = ev.homeTeam?.name;
    const away = ev.awayTeam?.name;
    const comp = ev.tournament?.name;

    if (!home || !away) return false;
    if (isExcludedTournament(comp)) return false;

    if (needle) {
      const hit =
        home.toLowerCase().includes(needle) ||
        away.toLowerCase().includes(needle);
      if (!hit) return false;
    }

    return true;
  });

  log(
    `Filtered events for ${d}: ${filtered.length} (teamName=${teamName || "N/A"})`
  );

  // Limit the number of events for TV channel lookups
  const slice = filtered.slice(0, maxEvents);

  const fixtures = [];

  for (const ev of slice) {
    const homeName = ev.homeTeam?.name || null;
    const awayName = ev.awayTeam?.name || null;
    const compName = ev.tournament?.name || null;
    const leagueName = ev.tournament?.category?.name || null;

    const ts = ev.startTimestamp
      ? new Date(ev.startTimestamp * 1000)
      : null;
    const kickoffUtc = ts ? ts.toISOString() : null;

    let matchUrl = null;
    if (ev.slug && ev.customId) {
      matchUrl = `https://www.sofascore.com/${ev.slug}/${ev.customId}`;
    } else if (ev.id && ev.slug) {
      matchUrl = `https://www.sofascore.com/${ev.slug}/${ev.id}`;
    }

    const channels = await fetchTvChannelsForEvent(ev.id);

    fixtures.push({
      homeTeam: homeName,
      awayTeam: awayName,
      kickoffUtc,
      league: leagueName,
      competition: compName,
      url: matchUrl,
      channels,
    });
  }

  log(`Built fixtures with TV data: ${fixtures.length}`);

  return { fixtures };
}

async function healthCheck() {
  const start = Date.now();
  try {
    const { fixtures } = await fetchSofaScoreFixturesWithTv({
      date: today(),
      maxEvents: 5,
    });
    const latencyMs = Date.now() - start;
    const ok = fixtures.length >= 0;
    return {
      ok,
      latencyMs,
      title: "SofaScore football schedule + TV",
      fixtures: fixtures.length,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return { ok: false, latencyMs, error: err.message || String(err) };
  }
}

/**
 * Unified interface used by vps-scrapers/server.js
 */
async function scrape(params = {}) {
  const { fixtures } = await fetchSofaScoreFixturesWithTv(params);
  return {
    fixtures,
    source: "sofascore",
  };
}

module.exports = {
  scrape,
  healthCheck,
  fetchSofaScoreFixturesWithTv,
};
