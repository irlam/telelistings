'use strict';

const { canonicalChannelName, classifyProgramme } = require('./iptv_channels');

const UK_SOURCE_NAMES = new Set([
  'bbc',
  'livefootballontv',
  'liveonsat',
  'skysports',
  'premiersports'
]);

const SOURCE_REGION = {
  bbc: 'UK',
  livefootballontv: 'UK',
  liveonsat: 'UK',
  skysports: 'UK',
  premiersports: 'UK'
};

const UK_COMPETITION_PATTERN = new RegExp([
  'premier league', 'championship', 'league one', 'league two',
  'national league', 'fa cup', 'efl cup', 'carabao cup', 'community shield',
  'scottish', 'welsh', 'cymru', 'irish premiership', 'northern ireland',
  'england', 'scotland', 'wales', 'uefa champions league', 'europa league',
  'conference league', 'world cup', 'european championship', 'nations league'
].join('|'), 'i');

const WOMENS_FOOTBALL_PATTERNS = [
  /\b(?:women(?:['’]?s)?|woman(?:['’]?s)?|ladies|girls?|female)\b/i,
  /\b(?:feminine|femenin[oa]|feminin[oa]|femminile|frauen|damen)\b/i,
  /\b(?:wfc|wsl|nwsl|uwcl)\b/i,
  /\b(?:damallsvenskan|toppserien|premiere ligue|liga f|we league)\b/i
];

const REGION_PRIORITY = [
  'UK', 'Ireland', 'USA', 'Canada', 'Australia', 'New Zealand',
  'Italy', 'Spain', 'Germany', 'Portugal', 'France', 'Belgium',
  'Netherlands', 'Switzerland', 'Austria', 'Poland', 'Japan',
  'Brazil', 'Mexico', 'Argentina', 'International'
];

// TV guides frequently shorten well-known club names. Keep these aliases
// explicit: removing words such as "City", "Town" or "United" globally would
// incorrectly collapse distinct clubs (for example Bristol City/Rovers).
const TEAM_ALIASES = new Map(Object.entries({
  'brighton': 'brighton and hove albion',
  'cheltenham': 'cheltenham town',
  'man city': 'manchester city',
  'man united': 'manchester united',
  'man utd': 'manchester united',
  'newcastle': 'newcastle united',
  'qpr': 'queens park rangers',
  'sheffield wed': 'sheffield wednesday',
  'spurs': 'tottenham hotspur',
  'tottenham': 'tottenham hotspur',
  'west brom': 'west bromwich albion',
  'wolves': 'wolverhampton wanderers',
  'york': 'york city'
}));

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function isWomensFixture(fixture) {
  if (!fixture || typeof fixture !== 'object') return false;

  const gender = cleanText(fixture.gender || fixture.strGender || fixture.sex);
  if (/^(?:f|female|woman|women)$/i.test(gender)) return true;

  const teamNames = [
    fixture.homeTeam, fixture.home, fixture.strHomeTeam,
    fixture.awayTeam, fixture.away, fixture.strAwayTeam
  ].map(cleanText).filter(Boolean);
  if (teamNames.some((team) => /(?:[\s_\-(]|^)(?:w|f)\)?$/i.test(team))) return true;

  const searchable = [
    ...teamNames,
    fixture.summary,
    fixture.title,
    fixture.match,
    fixture.event,
    fixture.competition,
    fixture.competitionRaw,
    fixture.league,
    fixture.tournament,
    fixture.category,
    fixture.division
  ]
    .map((value) => cleanText(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, ''))
    .filter(Boolean)
    .join(' ');

  return WOMENS_FOOTBALL_PATTERNS.some((pattern) => pattern.test(searchable));
}

function normalizeTeamName(value) {
  const normalized = cleanText(value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(fc|afc|cf|sc|ac|rfc)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return TEAM_ALIASES.get(normalized) || normalized;
}

function normalizeChannelName(value) {
  return canonicalChannelName(value)
    .replace(/^dazn great britain$/i, 'DAZN UK')
    .replace(/\s+(hd|uhd|4k)$/i, (match) => match.toUpperCase())
    .replace(/^sky sports main event hd$/i, 'Sky Sports Main Event HD')
    .replace(/^tnt sports (\d) hd$/i, 'TNT Sports $1 HD');
}

function normalizeRegion(value) {
  const region = cleanText(value);
  if (!region) return 'International';
  if (/^(uk|united kingdom|england)$/i.test(region)) return 'UK';
  if (/^(us|usa|united states)$/i.test(region)) return 'USA';
  if (/^(ireland|republic of ireland)$/i.test(region)) return 'Ireland';
  if (/^(worldwide|global|other|unknown)$/i.test(region)) return 'International';
  return region;
}

function inferRegionForChannel(channel, fallback) {
  const name = normalizeChannelName(channel);
  if (/\b(ireland|republic of ireland)\b/i.test(name)) return 'Ireland';
  if (/\b(italy|italia)\b/i.test(name)) return 'Italy';
  if (/\bjapan\b/i.test(name)) return 'Japan';
  if (/\bportugal\b/i.test(name)) return 'Portugal';
  if (/\b(spain|españa)\b/i.test(name)) return 'Spain';
  if (/\b(germany|deutschland)\b/i.test(name)) return 'Germany';
  if (/\baustria\b/i.test(name)) return 'Austria';
  if (/\b(switzerland|schweiz|suisse)\b/i.test(name)) return 'Switzerland';
  if (/\bfrance\b/i.test(name)) return 'France';
  if (/\bbelgium\b/i.test(name)) return 'Belgium';
  if (/\b(netherlands|holland)\b/i.test(name)) return 'Netherlands';
  if (/\bpoland\b/i.test(name)) return 'Poland';
  if (/\b(brazil|brasil)\b/i.test(name)) return 'Brazil';
  if (/\bmexico\b/i.test(name)) return 'Mexico';
  if (/\bargentina\b/i.test(name)) return 'Argentina';
  if (/\bcanada\b/i.test(name)) return 'Canada';
  if (/\baustralia\b/i.test(name)) return 'Australia';
  if (/\bnew zealand\b/i.test(name)) return 'New Zealand';
  if (/\b(usa|united states|america)\b/i.test(name)) return 'USA';
  if (/\b(great britain|united kingdom|uk)\b/i.test(name)) return 'UK';
  if (/(sky sports|tnt sports|bbc|itv|s4c|premier sports|discovery\+|now tv|amazon prime)/i.test(name)) return 'UK';
  if (/(peacock|nbc|cbs|paramount\+|fox sports|espn\+|tudn|telemundo)/i.test(name)) return 'USA';
  if (/(dazn canada|fubo canada|tsn|sportsnet)/i.test(name)) return 'Canada';
  if (/(stan sport|optus sport|beIN sports australia)/i.test(name)) return 'Australia';
  if (/^dazn\b/i.test(name)) return 'International';
  return fallback || 'International';
}

function dateKeyInZone(date, timezone = 'Europe/London') {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function timezoneOffsetMs(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second)
  );
  return asUtc - date.getTime();
}

function localDateTimeToUtc(dateKey, timeText, timezone = 'Europe/London') {
  const dateMatch = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(timeText || '').match(/(\d{1,2})[:.](\d{2})(?:\s*(am|pm))?/i);
  if (!dateMatch || !timeMatch) return null;

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = (timeMatch[3] || '').toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  const guessMs = Date.UTC(
    Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), hour, minute, 0
  );
  const guess = new Date(guessMs);
  const first = new Date(guessMs - timezoneOffsetMs(guess, timezone));
  const correction = timezoneOffsetMs(first, timezone);
  return new Date(guessMs - correction);
}

function parseStart(raw, requestedDate, timezone = 'Europe/London') {
  const candidates = [raw.start, raw.kickoffUtc, raw.kickoffLocal, raw.date, raw.startTime];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) return candidate;
    const text = cleanText(candidate);
    if (!text || /^\d{1,2}[:.]\d{2}(?:\s*(?:am|pm))?$/i.test(text)) continue;
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  const timeOnly = raw.timeString || raw.time || raw.kickoffLocal || raw.kickoffUtc;
  return localDateTimeToUtc(requestedDate, timeOnly, timezone);
}

function parseSummaryTeams(summary) {
  const text = cleanText(summary);
  const match = text.match(/^(.+?)\s+(?:v|vs\.?|@)\s+(.+)$/i);
  return match ? { homeTeam: cleanText(match[1]), awayTeam: cleanText(match[2]) } : {};
}

function collectRegionChannels(raw, source) {
  const output = [];
  const add = (region, channel) => {
    const cleanChannel = normalizeChannelName(channel);
    if (!cleanChannel) return;
    output.push({ region: normalizeRegion(region), channel: cleanChannel, source });
  };

  for (const entry of raw.tvByRegion || raw.regionChannels || raw.tvRegions || []) {
    if (typeof entry === 'string') add(SOURCE_REGION[source], entry);
    else add(entry.region || entry.country, entry.channel || entry.station || entry.name);
  }

  const flatChannels = [
    ...(Array.isArray(raw.channels) ? raw.channels : []),
    ...(Array.isArray(raw.tvChannels) ? raw.tvChannels : []),
    ...(Array.isArray(raw.tvStationsFlat) ? raw.tvStationsFlat : [])
  ];
  if (raw.tvChannel) flatChannels.push(raw.tvChannel);
  for (const channel of flatChannels) {
    const fallback = SOURCE_REGION[source] || 'International';
    add(inferRegionForChannel(channel, fallback), channel);
  }

  const seen = new Set();
  return sortTvRegions(output.filter((entry) => {
    const key = `${entry.region.toLowerCase()}|${entry.channel.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function normalizeFixture(raw, source, requestedDate, options = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const parsedTeams = parseSummaryTeams(raw.summary || raw.title || raw.match);
  const homeTeam = cleanText(raw.homeTeam || raw.home || parsedTeams.homeTeam);
  const awayTeam = cleanText(raw.awayTeam || raw.away || parsedTeams.awayTeam);
  if (!homeTeam || !awayTeam) return null;

  const start = parseStart(raw, requestedDate, options.timezone || 'Europe/London');
  const competition = cleanText(raw.competition || raw.league || raw.tournament || raw.competitionRaw);
  if (isWomensFixture({ ...raw, homeTeam, awayTeam, competition })) return null;
  const tvByRegion = collectRegionChannels(raw, source);

  return {
    homeTeam,
    awayTeam,
    summary: `${homeTeam} v ${awayTeam}`,
    start,
    competition,
    league: cleanText(raw.league),
    venue: cleanText(raw.venue || raw.location),
    url: cleanText(raw.url),
    tvByRegion,
    channels: tvByRegion.map((entry) => entry.channel),
    homeBadgeUrl: cleanText(raw.homeBadgeUrl || raw.homeLogo || raw.homeBadge),
    awayBadgeUrl: cleanText(raw.awayBadgeUrl || raw.awayLogo || raw.awayBadge),
    competitionImageUrl: cleanText(raw.competitionImageUrl || raw.competitionLogo),
    programmeType: raw.programmeType || classifyProgramme(raw.title || raw.summary || raw.match, { defaultLive: true }),
    requestedDate,
    sources: [source],
    sourceDetails: { [source]: true }
  };
}

function fixtureKey(fixture, timezone = 'Europe/London') {
  const date = fixture.start instanceof Date ? fixture.start : new Date(fixture.start);
  const day = dateKeyInZone(date, timezone) || fixture.requestedDate || 'unknown-date';
  const teams = [normalizeTeamName(fixture.homeTeam), normalizeTeamName(fixture.awayTeam)].sort();
  return `${day}|${teams[0]}|${teams[1]}`;
}

function mergeTvRegions(left = [], right = []) {
  const merged = [];
  const seen = new Set();
  for (const entry of [...left, ...right]) {
    const region = normalizeRegion(entry.region);
    const channel = normalizeChannelName(entry.channel);
    if (!channel) continue;
    const key = `${region.toLowerCase()}|${channel.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ region, channel, source: entry.source });
  }
  return sortTvRegions(merged);
}

function sortTvRegions(entries = []) {
  const priority = (region) => {
    const index = REGION_PRIORITY.indexOf(normalizeRegion(region));
    return index === -1 ? REGION_PRIORITY.length : index;
  };
  return [...entries].sort((a, b) => {
    const byRegion = priority(a.region) - priority(b.region);
    if (byRegion) return byRegion;
    const regionName = normalizeRegion(a.region).localeCompare(normalizeRegion(b.region));
    return regionName || a.channel.localeCompare(b.channel);
  });
}

function mergeFixture(target, incoming) {
  const merged = { ...target };
  const incomingFields = { ...incoming };
  const isReversed = normalizeTeamName(target.homeTeam) === normalizeTeamName(incoming.awayTeam)
    && normalizeTeamName(target.awayTeam) === normalizeTeamName(incoming.homeTeam);
  if (isReversed) {
    incomingFields.homeBadgeUrl = incoming.awayBadgeUrl;
    incomingFields.awayBadgeUrl = incoming.homeBadgeUrl;
  }
  const alignedHome = isReversed ? incoming.awayTeam : incoming.homeTeam;
  const alignedAway = isReversed ? incoming.homeTeam : incoming.awayTeam;
  // Prefer the fuller source spelling on the poster while retaining the
  // original home/away orientation selected for the merged fixture.
  if (cleanText(alignedHome).length > cleanText(merged.homeTeam).length) merged.homeTeam = cleanText(alignedHome);
  if (cleanText(alignedAway).length > cleanText(merged.awayTeam).length) merged.awayTeam = cleanText(alignedAway);
  merged.summary = `${merged.homeTeam} v ${merged.awayTeam}`;
  if ((!merged.start || Number.isNaN(new Date(merged.start).getTime())) && incoming.start) merged.start = incoming.start;
  for (const field of ['competition', 'league', 'venue', 'url', 'homeBadgeUrl', 'awayBadgeUrl', 'competitionImageUrl']) {
    if (!merged[field] && incomingFields[field]) merged[field] = incomingFields[field];
  }
  merged.tvByRegion = mergeTvRegions(target.tvByRegion, incoming.tvByRegion);
  merged.channels = merged.tvByRegion.map((entry) => entry.channel);
  merged.sources = [...new Set([...(target.sources || []), ...(incoming.sources || [])])];
  merged.sourceDetails = { ...(target.sourceDetails || {}), ...(incoming.sourceDetails || {}) };
  if (incoming.programmeType === 'live') merged.programmeType = 'live';
  return merged;
}

function addConfidence(fixture) {
  const sourceCount = new Set(fixture.sources || []).size;
  return {
    ...fixture,
    sourceCount,
    confidence: sourceCount >= 2 ? 'confirmed' : 'single-source',
    confidenceLabel: sourceCount >= 2
      ? `Confirmed by ${sourceCount} sources`
      : 'Single-source listing — check before kick-off'
  };
}

function mergeFixtures(fixtures = [], timezone = 'Europe/London') {
  const byKey = new Map();
  for (const fixture of fixtures) {
    if (!fixture) continue;
    const key = fixtureKey(fixture, timezone);
    byKey.set(key, byKey.has(key) ? mergeFixture(byKey.get(key), fixture) : fixture);
  }
  return [...byKey.values()].map(addConfidence).sort((a, b) => {
    const aTime = a.start ? new Date(a.start).getTime() : Number.MAX_SAFE_INTEGER;
    const bTime = b.start ? new Date(b.start).getTime() : Number.MAX_SAFE_INTEGER;
    return aTime - bTime || a.homeTeam.localeCompare(b.homeTeam);
  });
}

function hasUkCoverage(fixture) {
  return (fixture.tvByRegion || []).some((entry) => normalizeRegion(entry.region) === 'UK');
}

function isTelevised(fixture) {
  return (fixture.tvByRegion || []).length > 0;
}

function isUkRelevant(fixture, teamNames = []) {
  if (!fixture) return false;
  if (hasUkCoverage(fixture)) return true;
  if ((fixture.sources || []).some((source) => UK_SOURCE_NAMES.has(source))) return true;
  if (UK_COMPETITION_PATTERN.test(`${fixture.competition || ''} ${fixture.league || ''}`)) return true;

  const home = normalizeTeamName(fixture.homeTeam);
  const away = normalizeTeamName(fixture.awayTeam);
  return teamNames.some((team) => {
    const normalized = normalizeTeamName(team.label || team.slug || team);
    return normalized && (normalized === home || normalized === away);
  });
}

module.exports = {
  cleanText,
  normalizeTeamName,
  normalizeChannelName,
  normalizeRegion,
  inferRegionForChannel,
  dateKeyInZone,
  localDateTimeToUtc,
  normalizeFixture,
  fixtureKey,
  mergeFixture,
  mergeFixtures,
  mergeTvRegions,
  addConfidence,
  sortTvRegions,
  hasUkCoverage,
  isTelevised,
  isUkRelevant,
  isWomensFixture
};
