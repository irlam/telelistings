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
 */

const axios = require('axios');
const ical = require('node-ical');

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

    fixtures.push({ start, summary, location, description });
  }

  fixtures.sort((a, b) => a.start - b.start);
  return fixtures;
}

module.exports = {
  getFixturesFromIcs
};
