// ics_source.js
// Read an ICS (iCalendar) feed and return fixtures filtered by team names.
/**
 * Telegram Sports TV Bot – ICS Fixture Source
 *
 * Provides getFixturesFromIcs(icsUrl, timezone, teamFilters, daysAhead).
 * - Fetches an ICS URL (e.g. from TheFishy).
 * - Parses events into JS objects with start, end, summary, location, etc.
 * - Filters to events within the next N days (daysAhead).
 * - If teamFilters is non-empty, only keep events whose summary matches a team name.
 *
 * Used by autopost.js to generate Telegram messages.
 * Keep the parsing code robust but lightweight (no huge dependencies).
 *
 * Caching:
 * - Caches ICS responses to disk in cache/ folder.
 * - Uses a 30-minute TTL by default.
 * - Falls back to cached copy on network errors (e.g. HTTP 429).
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ical = require('node-ical');

// ---------- Cache Configuration ----------

const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ---------- Cache Helpers ----------

/**
 * Generate a safe filename from a URL using SHA-256 hash.
 * @param {string} url
 * @returns {string}
 */
function getCacheKey(url) {
  return crypto.createHash('sha256').update(url).digest('hex') + '.json';
}

/**
 * Ensure the cache directory exists.
 */
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * Read cached ICS data if it exists and is fresh.
 * @param {string} url
 * @returns {{ text: string, timestamp: number } | null}
 */
function readCache(url) {
  try {
    const cacheFile = path.join(CACHE_DIR, getCacheKey(url));
    if (!fs.existsSync(cacheFile)) {
      return null;
    }
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const entry = JSON.parse(raw);
    if (entry && typeof entry.text === 'string' && typeof entry.timestamp === 'number') {
      return entry;
    }
  } catch (err) {
    // Ignore cache read errors
  }
  return null;
}

/**
 * Write ICS data to cache.
 * @param {string} url
 * @param {string} text
 */
function writeCache(url, text) {
  try {
    ensureCacheDir();
    const cacheFile = path.join(CACHE_DIR, getCacheKey(url));
    const entry = {
      text,
      timestamp: Date.now()
    };
    fs.writeFileSync(cacheFile, JSON.stringify(entry), 'utf8');
  } catch (err) {
    // Ignore cache write errors
  }
}

/**
 * Check if a cache entry is still fresh (within TTL).
 * @param {{ text: string, timestamp: number }} entry
 * @returns {boolean}
 */
function isCacheFresh(entry) {
  return entry && (Date.now() - entry.timestamp) < CACHE_TTL_MS;
}

/**
 * Fetch ICS text from network or cache.
 * Logs network fetch, cache hit, and cache fallback.
 *
 * @param {string} icsUrl
 * @returns {Promise<string>} The raw ICS text
 */
async function fetchIcsWithCache(icsUrl) {
  const cached = readCache(icsUrl);

  // If cache is fresh, use it
  if (cached && isCacheFresh(cached)) {
    console.log(`[ICS] Using cached ICS for ${icsUrl}`);
    return cached.text;
  }

  // Otherwise, try network
  console.log(`[ICS] Fetching ${icsUrl} from network`);

  try {
    const resp = await axios.get(icsUrl, {
      responseType: 'text',
      timeout: 15000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; DefectTrackerIcsBot/1.0; +https://telegram.defecttracker.uk/)',
        'Accept': 'text/calendar,text/plain,*/*;q=0.8'
      }
    });

    const text = resp.data;

    // Write to cache
    writeCache(icsUrl, text);

    return text;
  } catch (err) {
    // On network error, try to fall back to stale cache
    if (cached) {
      const status = err?.response?.status;
      const errMsg = status ? `HTTP ${status}` : (err.message || String(err));
      console.log(`[ICS] Network error (${errMsg}) – falling back to cached ICS for ${icsUrl}`);
      return cached.text;
    }

    // No cache available, re-throw the error
    throw err;
  }
}

/**
 * Fetch & filter fixtures from an ICS URL.
 *
 * @param {string} icsUrl          - URL to the .ics feed
 * @param {string} timezone        - IANA timezone (e.g. "Europe/London")
 * @param {string[]} teamNames     - Team names to match in event summary (case-insensitive).
 *                                   If empty or null, returns all events.
 * @param {number} daysAhead       - How many days ahead from now to include (default 1)
 * @returns {Promise<Array<{start: Date, summary: string, location: string, description: string}>>}
 */
async function getFixturesFromIcs(
  icsUrl,
  timezone = 'Europe/London',
  teamNames = [],
  daysAhead = 1
) {
  if (!icsUrl) {
    throw new Error('ICS URL is not configured');
  }

  const text = await fetchIcsWithCache(icsUrl);
  const events = ical.sync.parseICS(text);

  const now = new Date();
  const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  const needles = (teamNames || [])
    .map((t) => (t || '').toLowerCase().trim())
    .filter(Boolean);

  const fixtures = [];

  for (const key of Object.keys(events)) {
    const ev = events[key];
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;

    const start = ev.start;
    if (!(start instanceof Date)) continue;

    // time window
    if (start < now || start > cutoff) continue;

    const summary = (ev.summary || '').toString();
    const location = (ev.location || '').toString();
    const description = (ev.description || '').toString();

    if (needles.length) {
      const lower = summary.toLowerCase();
      const hit = needles.some(
        (name) => name && lower.includes(name)
      );
      if (!hit) continue;
    }

    // tvChannel is optional and defaults to null. It can be enriched later
    // via the enrichFixtureWithTvChannel hook or via config overrides.
    fixtures.push({ start, summary, location, description, tvChannel: null });
  }

  fixtures.sort((a, b) => a.start - b.start);
  return fixtures;
}

/**
 * Hook function to enrich a fixture with TV channel information.
 * This can be called after fetching fixtures to attach tvChannel metadata.
 *
 * @param {Object} fixture - Fixture object with start, summary, location, description
 * @param {string|null} tvChannel - The TV channel name to attach (or null)
 * @returns {Object} The same fixture object with tvChannel property set
 */
function enrichFixtureWithTvChannel(fixture, tvChannel) {
  if (fixture && typeof fixture === 'object') {
    fixture.tvChannel = tvChannel || null;
  }
  return fixture;
}

module.exports = {
  getFixturesFromIcs,
  enrichFixtureWithTvChannel
};
