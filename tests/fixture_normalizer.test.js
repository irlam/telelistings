'use strict';

const assert = require('assert');
const normalizer = require('../lib/fixture_normalizer');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed += 1; }
  catch (error) { console.error(`✗ ${name}\n  ${error.message}`); failed += 1; }
}

console.log('UK Fixture Normalizer Tests\n===========================\n');

test('normalizes a UK source fixture and assigns UK coverage', () => {
  const fixture = normalizer.normalizeFixture({
    home: 'Manchester City FC',
    away: 'Liverpool',
    kickoffUtc: '2026-08-30T15:30:00Z',
    competition: 'Premier League',
    channels: ['Sky Sports Main Event']
  }, 'livefootballontv', '2026-08-30');
  assert.strictEqual(fixture.homeTeam, 'Manchester City FC');
  assert.strictEqual(fixture.tvByRegion[0].region, 'UK');
  assert.strictEqual(fixture.tvByRegion[0].channel, 'Sky Sports Main Event');
  assert(fixture.start instanceof Date);
});

test('merges duplicate fixtures from several sources', () => {
  const left = normalizer.normalizeFixture({
    homeTeam: 'Arsenal', awayTeam: 'Chelsea', kickoffUtc: '2026-08-30T14:00:00Z',
    competition: 'Premier League', channels: ['Sky Sports Premier League']
  }, 'skysports', '2026-08-30');
  const right = normalizer.normalizeFixture({
    home: 'Chelsea FC', away: 'Arsenal FC', kickoffUtc: '2026-08-30T14:00:00Z',
    channels: ['PS One'], homeBadgeUrl: 'https://r2.thesportsdb.com/images/media/team/badge/1.png'
  }, 'premiersports', '2026-08-30');
  const merged = normalizer.mergeFixtures([left, right]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].tvByRegion.length, 2);
  assert.deepStrictEqual(new Set(merged[0].sources), new Set(['skysports', 'premiersports']));
  assert(merged[0].awayBadgeUrl);
  assert.strictEqual(merged[0].confidence, 'confirmed');
  assert.strictEqual(merged[0].sourceCount, 2);
});

test('keeps fixtures on different dates separate', () => {
  const first = normalizer.normalizeFixture({ home: 'Bolton', away: 'Wigan', kickoffUtc: '2026-08-30T12:00:00Z' }, 'bbc', '2026-08-30');
  const second = normalizer.normalizeFixture({ home: 'Bolton', away: 'Wigan', kickoffUtc: '2026-08-31T12:00:00Z' }, 'bbc', '2026-08-31');
  assert.strictEqual(normalizer.mergeFixtures([first, second]).length, 2);
});

test('merges conservative shortened UK club names and keeps the fuller display name', () => {
  const full = normalizer.normalizeFixture({
    home: 'Cheltenham Town', away: 'York City', kickoffUtc: '2026-09-01T18:45:00Z',
    channels: ['Sky Sports+']
  }, 'skysports', '2026-09-01');
  const short = normalizer.normalizeFixture({
    home: 'Cheltenham', away: 'York', kickoffUtc: '2026-09-01T18:45:00Z',
    channels: ['Sky Sports Football']
  }, 'liveonsat', '2026-09-01');
  const merged = normalizer.mergeFixtures([short, full]);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].homeTeam, 'Cheltenham Town');
  assert.strictEqual(merged[0].awayTeam, 'York City');
  assert.strictEqual(merged[0].summary, 'Cheltenham Town v York City');
  assert.strictEqual(merged[0].sourceCount, 2);
});

test('does not merge distinct clubs that share a place name', () => {
  const city = normalizer.normalizeFixture({
    home: 'Bristol City', away: 'Bolton Wanderers', kickoffUtc: '2026-09-01T18:45:00Z'
  }, 'bbc', '2026-09-01');
  const rovers = normalizer.normalizeFixture({
    home: 'Bristol Rovers', away: 'Bolton Wanderers', kickoffUtc: '2026-09-01T18:45:00Z'
  }, 'bbc', '2026-09-01');
  assert.strictEqual(normalizer.mergeFixtures([city, rovers]).length, 2);
});

test('excludes women\'s football across team, competition and gender labels', () => {
  const cases = [
    { home: 'Arsenal Women', away: 'Chelsea Women', competition: "Women's Super League" },
    { home: 'Manchester United W', away: 'Liverpool W', competition: 'WSL' },
    { home: 'Barcelona', away: 'Lyon', competition: "UEFA Women's Champions League" },
    { home: 'Bayern Munich', away: 'Wolfsburg', competition: 'Frauen-Bundesliga' },
    { home: 'England', away: 'Spain', competition: 'World Cup', gender: 'Female' }
  ];

  for (const fixture of cases) {
    assert.strictEqual(
      normalizer.normalizeFixture({ ...fixture, kickoffUtc: '2026-09-04T18:00:00Z' }, 'liveonsat', '2026-09-04'),
      null
    );
  }
});

test('does not mistake men\'s club names for women\'s markers', () => {
  const fixture = normalizer.normalizeFixture({
    home: 'Wolverhampton Wanderers',
    away: 'Wrexham AFC',
    kickoffUtc: '2026-09-04T18:00:00Z',
    competition: 'Premier League'
  }, 'skysports', '2026-09-04');

  assert(fixture);
  assert.strictEqual(normalizer.isWomensFixture(fixture), false);
});

test('excludes under-21 fixtures across team, competition and age-group labels', () => {
  const cases = [
    { home: 'Liverpool U-21', away: 'Brighton U-21', competition: 'Premier League 2' },
    { home: 'Tottenham U21', away: 'Manchester City U21', competition: 'English Football' },
    { home: 'Arsenal Under 21', away: 'Chelsea Under-21', competition: 'Premier League Cup' },
    { home: 'Bolton Wanderers', away: 'Wigan Athletic', competition: 'Youth fixture', ageGroup: 'U21' },
    { home: 'England', away: 'France', competition: 'International', strAgeGroup: '21' },
    { home: 'Liverpool', away: 'Brighton', competition: 'Premier League 2' },
    { home: 'Charlton Athletic', away: 'Millwall', competition: 'Professional Development League' }
  ];

  for (const fixture of cases) {
    assert.strictEqual(
      normalizer.normalizeFixture({ ...fixture, kickoffUtc: '2026-09-23T18:00:00Z' }, 'liveonsat', '2026-09-23'),
      null
    );
  }
});

test('does not mistake senior teams containing 21 for under-21 fixtures', () => {
  const fixture = normalizer.normalizeFixture({
    home: 'Club 21 United',
    away: 'Bolton Wanderers',
    kickoffUtc: '2026-09-23T18:00:00Z',
    competition: 'Senior Friendly'
  }, 'liveonsat', '2026-09-23');

  assert(fixture);
  assert.strictEqual(normalizer.isUnder21Fixture(fixture), false);
});

test('UK channels and competitions are considered relevant', () => {
  const covered = normalizer.normalizeFixture({ home: 'A', away: 'B', kickoffUtc: '2026-08-30T12:00:00Z', channels: ['BBC One'] }, 'bbc', '2026-08-30');
  const competition = normalizer.normalizeFixture({ home: 'A', away: 'B', kickoffUtc: '2026-08-30T12:00:00Z', competition: 'Scottish Premiership' }, 'premiersports', '2026-08-30');
  assert.strictEqual(normalizer.isUkRelevant(covered), true);
  assert.strictEqual(normalizer.isUkRelevant(competition), true);
});

test('infers UK and USA regions from broadcaster names', () => {
  assert.strictEqual(normalizer.inferRegionForChannel('Sky Sports Main Event', 'International'), 'UK');
  assert.strictEqual(normalizer.inferRegionForChannel('Peacock', 'International'), 'USA');
});

test('removes LiveOnSat access markers from channel names', () => {
  assert.strictEqual(normalizer.normalizeChannelName('DAZN Great Britain (geo/R)'), 'DAZN UK');
  assert.strictEqual(normalizer.normalizeChannelName('DAZN Ireland ($/geo/R)'), 'DAZN Ireland');
  assert.strictEqual(normalizer.normalizeChannelName('DAZN Italia ($/geo/R)'), 'DAZN Italia');
});

test('assigns country-specific DAZN services to the correct regions', () => {
  const fixture = normalizer.normalizeFixture({
    home: 'Sutton United',
    away: 'Wealdstone',
    kickoffUtc: '2026-08-31T15:00:00Z',
    channels: [
      'DAZN Great Britain (geo/R)',
      'DAZN Ireland ($/geo/R)',
      'DAZN Italia ($/geo/R)',
      'DAZN Japan ($/geo/R)',
      'DAZN Portugal ($/geo/R)'
    ]
  }, 'liveonsat', '2026-08-31');

  assert.deepStrictEqual(fixture.tvByRegion.map(({ region, channel }) => [region, channel]), [
    ['UK', 'DAZN UK'],
    ['Ireland', 'DAZN Ireland'],
    ['Italy', 'DAZN Italia'],
    ['Portugal', 'DAZN Portugal'],
    ['Japan', 'DAZN Japan']
  ]);
});

test('converts UK local kick-off time to UTC during summer time', () => {
  const date = normalizer.localDateTimeToUtc('2026-08-30', '16:30', 'Europe/London');
  assert.strictEqual(date.toISOString(), '2026-08-30T15:30:00.000Z');
});

console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
