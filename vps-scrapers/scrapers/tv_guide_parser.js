'use strict';

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

function linesFromText(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function dateKeyFromHeading(line, now = new Date()) {
  const match = String(line).match(/(?:today|mon|tue|wed|thu|fri|sat|sun)(?:day)?[,]?\s+(?:(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)|([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?)(?:\s+(\d{4}))?/i);
  if (!match) return null;
  const day = Number(match[1] || match[4]);
  const month = MONTHS[String(match[2] || match[3]).toLowerCase()];
  if (!Number.isInteger(month) || !day) return null;
  let year = Number(match[5]) || now.getUTCFullYear();
  const candidate = Date.UTC(year, month, day, 12);
  if (!match[5] && candidate < now.getTime() - 120 * 86400000) year += 1;
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function londonTimeToUtc(dateKey, timeText) {
  if (!dateKey || !timeText) return null;
  const time = String(timeText).match(/\b(\d{1,2})[:.](\d{2})(?:\s*(am|pm))?\b/i);
  if (!time) return null;
  let hour = Number(time[1]);
  const minute = Number(time[2]);
  const meridiem = String(time[3] || '').toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  const guessMs = Date.parse(`${dateKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const guess = new Date(guessMs);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', timeZoneName: 'shortOffset', hour: '2-digit'
  }).formatToParts(guess);
  const offset = parts.find((part) => part.type === 'timeZoneName')?.value.match(/GMT([+-]\d+)?/i)?.[1];
  return new Date(guessMs - (Number(offset || 0) * 3600000)).toISOString();
}

function programmeType(text, defaultLive) {
  const value = String(text || '').toLowerCase();
  if (/\blive\b/.test(value)) return 'live';
  if (/\b(?:highlights?|replay|repeat|classic|magazine|countdown|greatest|review)\b/.test(value)) return 'highlights/replay';
  if (defaultLive) return 'live';
  if (/\bpreview\b|build[ -]?up/.test(value)) return 'preview';
  return 'unknown';
}

function channelsFromText(text, defaultChannel) {
  const value = String(text || '');
  const patterns = [
    /Sky Sports (?:Main Event|Premier League|Football|\+|Plus|Mix)/gi,
    /Premier Sports (?:1|2|One|Two|Extra)/gi,
    /PS[- ](?:One|Two|Extra)/gi,
    /\bPS(?:1|2)(?:_\d+)?\b/gi
  ];
  const output = [];
  for (const pattern of patterns) output.push(...(value.match(pattern) || []));
  if (!output.length && defaultChannel) output.push(defaultChannel);
  return [...new Set(output.map((channel) => channel
    .replace(/Sky Sports Plus/i, 'Sky Sports+')
    .replace(/Premier Sports One|PS[- ]One|PS1(?:_\d+)?/i, 'Premier Sports 1')
    .replace(/Premier Sports Two|PS[- ]Two|PS2(?:_\d+)?/i, 'Premier Sports 2')
    .replace(/PS[- ]Extra/i, 'Premier Sports Extra')) )];
}

function isTeamLine(line) {
  return Boolean(line) &&
    line.length < 70 &&
    !dateKeyFromHeading(line) &&
    !/^ps\s+(?:one|two|extra)$/i.test(line) &&
    !/\b(?:sky sports|premier sports|match preview|fixtures?|results?|football|watch|live|highlights?|league|cup|subscribe|schedule)\b/i.test(line) &&
    !/\d{1,2}[:.]\d{2}/.test(line);
}

function parseTvGuideText(text, options = {}) {
  const lines = linesFromText(text);
  const fixtures = [];
  let dateKey = options.date || null;

  const addFixture = (home, away, timeText, context) => {
    const type = programmeType(context, options.defaultLive === true);
    if (type !== 'live' && options.includeNonLive !== true) return;
    const kickoffUtc = londonTimeToUtc(dateKey, timeText);
    if (!home || !away || !kickoffUtc) return;
    fixtures.push({
      homeTeam: home.replace(/^LIVE:\s*/i, '').trim(),
      awayTeam: away.trim(),
      kickoffUtc,
      competition: options.competition || null,
      channels: channelsFromText(context, options.defaultChannel),
      programmeType: type
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const heading = dateKeyFromHeading(lines[index], options.now || new Date());
    if (heading) { dateKey = heading; continue; }

    // Premier Sports' featured-fixture cards use: home, V, away, full date, time.
    if (/^(?:v|vs\.?)$/i.test(lines[index + 1] || '')) {
      const cardDate = dateKeyFromHeading(lines[index + 3], options.now || new Date());
      const cardTime = lines[index + 4];
      if (cardDate && /^\d{1,2}[:.]\d{2}(?:\s*(?:am|pm))?$/i.test(cardTime || '')) {
        dateKey = cardDate;
        const context = `${lines.slice(Math.max(0, index - 2), index + 7).join(' | ')} | LIVE`;
        addFixture(lines[index], lines[index + 2], cardTime, context);
        continue;
      }
    }

    if (!dateKey) continue;

    const direct = lines[index].match(/^(?:LIVE:\s*)?(.+?)\s+(?:v|vs\.?|versus)\s+(.+)$/i);
    if (direct) {
      const context = lines.slice(Math.max(0, index - 4), index + 5).join(' | ');
      const time = context.match(/\b\d{1,2}[:.]\d{2}(?:\s*(?:am|pm))?\b/i)?.[0];
      addFixture(direct[1], direct[2], time, context);
      continue;
    }

    if (/^\d{1,2}[:.]\d{2}(?:\s*(?:am|pm))?$/i.test(lines[index])) {
      const home = lines[index - 1];
      const away = lines[index + 1];
      if (isTeamLine(home) && isTeamLine(away)) {
        const context = lines.slice(Math.max(0, index - 3), index + 7).join(' | ');
        addFixture(home, away, lines[index], context);
      }
    }
  }

  const seen = new Set();
  return fixtures.filter((fixture) => {
    const key = `${fixture.kickoffUtc}|${fixture.homeTeam.toLowerCase()}|${fixture.awayTeam.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { linesFromText, dateKeyFromHeading, londonTimeToUtc, programmeType, channelsFromText, parseTvGuideText };
