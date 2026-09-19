'use strict';

const assert = require('assert');
const parser = require('../vps-scrapers/scrapers/tv_guide_parser');
const skyScraper = require('../vps-scrapers/scrapers/skysports');

const sky = parser.parseTvGuideText(`
Fri 4th September
Ipswich Town
20:00
Liverpool
Match Preview
Premier League, Sky Sports Main Event, Sky Sports Premier League
`, { now: new Date('2026-09-01T12:00:00Z'), defaultLive: true, defaultChannel: 'Sky Sports' });

assert.strictEqual(sky.length, 1);
assert.strictEqual(sky[0].homeTeam, 'Ipswich Town');
assert.strictEqual(sky[0].awayTeam, 'Liverpool');
assert.strictEqual(sky[0].kickoffUtc, '2026-09-04T19:00:00.000Z');
assert.deepStrictEqual(sky[0].channels, ['Sky Sports Main Event', 'Sky Sports Premier League']);

const premier = parser.parseTvGuideText(`
Tue Sep 1
4:30 pm
PS One
LIVE: PSG v Aston Villa
Football live on Premier Sports 1
7:00 pm
PS Two
European Football Highlights
`, { now: new Date('2026-09-01T12:00:00Z'), defaultLive: false, defaultChannel: 'Premier Sports 1' });

assert.strictEqual(premier.length, 1);
assert.strictEqual(premier[0].homeTeam, 'PSG');
assert.strictEqual(premier[0].awayTeam, 'Aston Villa');
assert.strictEqual(premier[0].programmeType, 'live');
assert(premier[0].channels.includes('Premier Sports 1'));

const featured = parser.parseTvGuideText(`
Premier League
Nottingham Forest
V
Tottenham Hotspur
Sat 5th September
2:30 pm
Stacked PS1_1
`, { now: new Date('2026-09-01T12:00:00Z'), defaultLive: false, defaultChannel: 'Premier Sports 1' });
assert.strictEqual(featured.length, 1);
assert.strictEqual(featured[0].kickoffUtc, '2026-09-05T13:30:00.000Z');

const skyHtmlText = skyScraper.htmlToText(`
  <h3>Tue 1st September</h3>
  <span>Arsenal</span><span>19:45</span><span>Chelsea</span>
  <a>Match Preview</a><p>Premier League, Sky Sports Main Event</p>
`);
assert.strictEqual(skyScraper.looksLikeGuide(skyHtmlText), true);
assert.strictEqual(parser.parseTvGuideText(skyHtmlText, { now: new Date('2026-09-01T12:00:00Z'), defaultLive: true }).length, 1);

console.log('✓ official-guide text parsing, UK time conversion and replay exclusion');
