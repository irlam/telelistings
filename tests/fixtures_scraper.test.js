// tests/fixtures_scraper.test.js
// Test suite for the unified fixtures scraper.

const assert = require('assert');

// Import the scraper
const fixturesScraper = require('../scrapers/fixtures_scraper');

// Test counters
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

console.log('Fixtures Scraper Tests\n======================\n');

// ---------- Unit Tests ----------

console.log('--- Team Name Normalization Tests ---\n');

test('normalizeTeamName: basic normalization', () => {
  assert.strictEqual(fixturesScraper.normalizeTeamName('Arsenal'), 'arsenal');
  assert.strictEqual(fixturesScraper.normalizeTeamName('Manchester United'), 'manchester united');
  assert.strictEqual(fixturesScraper.normalizeTeamName('  Liverpool  '), 'liverpool');
});

test('normalizeTeamName: strips FC/AFC prefixes', () => {
  assert.strictEqual(fixturesScraper.normalizeTeamName('Arsenal FC'), 'arsenal');
  assert.strictEqual(fixturesScraper.normalizeTeamName('AFC Bournemouth'), 'bournemouth');
});

test('normalizeTeamName: handles empty/null input', () => {
  assert.strictEqual(fixturesScraper.normalizeTeamName(''), '');
  assert.strictEqual(fixturesScraper.normalizeTeamName(null), '');
  assert.strictEqual(fixturesScraper.normalizeTeamName(undefined), '');
});

test('teamsMatch: exact match', () => {
  assert.strictEqual(fixturesScraper.teamsMatch('Arsenal', 'Arsenal'), true);
  assert.strictEqual(fixturesScraper.teamsMatch('Arsenal FC', 'Arsenal'), true);
});

test('teamsMatch: substring match', () => {
  assert.strictEqual(fixturesScraper.teamsMatch('Man United', 'Manchester United'), true);
});

test('teamsMatch: no match', () => {
  assert.strictEqual(fixturesScraper.teamsMatch('Arsenal', 'Chelsea'), false);
  assert.strictEqual(fixturesScraper.teamsMatch('Liverpool', 'Everton'), false);
});

// ---------- Fixture Normalization Tests ----------

console.log('\n--- Fixture Normalization Tests ---\n');

test('normalizeFixture: creates standard format from TSDB data', () => {
  const raw = {
    dateEvent: '2024-12-15',
    strTime: '15:00:00',
    strEvent: 'Arsenal vs Chelsea',
    strHomeTeam: 'Arsenal',
    strAwayTeam: 'Chelsea',
    strVenue: 'Emirates Stadium',
    strLeague: 'Premier League'
  };
  
  const fixture = fixturesScraper.normalizeFixture(raw, 'TSDB');
  
  assert.strictEqual(fixture.homeTeam, 'Arsenal');
  assert.strictEqual(fixture.awayTeam, 'Chelsea');
  assert.strictEqual(fixture.location, 'Emirates Stadium');
  assert.strictEqual(fixture.competition, 'Premier League');
  assert.strictEqual(fixture.source, 'TSDB');
});

test('normalizeFixture: creates summary from home/away teams', () => {
  const raw = {
    home: 'Liverpool',
    away: 'Man City'
  };
  
  const fixture = fixturesScraper.normalizeFixture(raw, 'BBC');
  
  assert.strictEqual(fixture.summary, 'Liverpool v Man City');
  assert.strictEqual(fixture.homeTeam, 'Liverpool');
  assert.strictEqual(fixture.awayTeam, 'Man City');
});

test('normalizeFixture: handles missing data gracefully', () => {
  const raw = {};
  
  const fixture = fixturesScraper.normalizeFixture(raw, 'TEST');
  
  assert.strictEqual(fixture.homeTeam, '');
  assert.strictEqual(fixture.awayTeam, '');
  assert.strictEqual(fixture.summary, '');
  assert.strictEqual(fixture.source, 'TEST');
  assert.deepStrictEqual(fixture.tvChannels, []);
});

test('normalizeFixture: handles kickoffUtc date format', () => {
  const raw = {
    kickoffUtc: '2024-12-15T15:00:00Z',
    home: 'Arsenal',
    away: 'Chelsea'
  };
  
  const fixture = fixturesScraper.normalizeFixture(raw, 'LFOTV');
  
  assert(fixture.start instanceof Date);
  assert.strictEqual(fixture.start.getUTCHours(), 15);
});

// ---------- Fixture Key Tests ----------

console.log('\n--- Fixture Key Tests ---\n');

test('getFixtureKey: creates consistent key', () => {
  const fixture1 = {
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    start: new Date('2024-12-15T15:00:00Z')
  };
  
  const fixture2 = {
    homeTeam: 'Arsenal FC',
    awayTeam: 'Chelsea',
    start: new Date('2024-12-15T20:00:00Z')  // Same day
  };
  
  const key1 = fixturesScraper.getFixtureKey(fixture1);
  const key2 = fixturesScraper.getFixtureKey(fixture2);
  
  // Same teams, same date should have same key
  assert.strictEqual(key1, key2);
});

test('getFixtureKey: different dates create different keys', () => {
  const fixture1 = {
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    start: new Date('2024-12-15T15:00:00Z')
  };
  
  const fixture2 = {
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    start: new Date('2024-12-16T15:00:00Z')
  };
  
  const key1 = fixturesScraper.getFixtureKey(fixture1);
  const key2 = fixturesScraper.getFixtureKey(fixture2);
  
  assert.notStrictEqual(key1, key2);
});

// ---------- TV Channel Merging Tests ----------

console.log('\n--- TV Channel Merging Tests ---\n');

test('mergeTvChannels: merges unique channels', () => {
  const existing = {
    tvChannels: ['Sky Sports'],
    tvByRegion: [{ region: 'UK', channel: 'Sky Sports', source: 'LFOTV' }]
  };
  
  const newFixture = {
    tvChannels: ['TNT Sports', 'Sky Sports'],  // Sky Sports is a duplicate
    tvByRegion: [
      { region: 'UK', channel: 'TNT Sports', source: 'TNT' },
      { region: 'UK', channel: 'Sky Sports', source: 'SKY' }  // Duplicate region+channel
    ]
  };
  
  fixturesScraper.mergeTvChannels(existing, newFixture);
  
  // Should have 2 unique channels
  assert.strictEqual(existing.tvChannels.length, 2);
  assert(existing.tvChannels.includes('Sky Sports'));
  assert(existing.tvChannels.includes('TNT Sports'));
  
  // Should have 2 unique region+channel combinations
  assert.strictEqual(existing.tvByRegion.length, 2);
});

test('mergeTvChannels: handles empty arrays', () => {
  const existing = {
    tvChannels: [],
    tvByRegion: []
  };
  
  const newFixture = {
    tvChannels: ['BBC One'],
    tvByRegion: [{ region: 'UK', channel: 'BBC One', source: 'BBC' }]
  };
  
  fixturesScraper.mergeTvChannels(existing, newFixture);
  
  assert.strictEqual(existing.tvChannels.length, 1);
  assert.strictEqual(existing.tvByRegion.length, 1);
  assert.strictEqual(existing.tvChannels[0], 'BBC One');
});

test('mergeTvChannels: preserves source attribution', () => {
  const existing = {
    tvChannels: [],
    tvByRegion: []
  };
  
  const newFixture = {
    tvChannels: ['Sky Sports Main Event'],
    tvByRegion: [{ region: 'UK', channel: 'Sky Sports Main Event', source: 'SKY' }]
  };
  
  fixturesScraper.mergeTvChannels(existing, newFixture);
  
  assert.strictEqual(existing.tvByRegion[0].source, 'SKY');
});

// ---------- Constants Tests ----------

console.log('\n--- Constants Tests ---\n');

test('DEFAULT_DAYS_AHEAD: is defined and reasonable', () => {
  assert(typeof fixturesScraper.DEFAULT_DAYS_AHEAD === 'number');
  assert(fixturesScraper.DEFAULT_DAYS_AHEAD > 0);
  assert(fixturesScraper.DEFAULT_DAYS_AHEAD <= 30);
});

// ---------- Integration Tests ----------

console.log('\n--- Integration Tests ---\n');

async function runIntegrationTests() {
  // Test getFixturesFromScrapers with missing team name
  await asyncTest('getFixturesFromScrapers: handles missing teamName gracefully', async () => {
    const result = await fixturesScraper.getFixturesFromScrapers({});
    
    assert(Array.isArray(result));
    assert.strictEqual(result.length, 0);
  });
  
  // Test getFixturesFromScrapers with valid team name
  await asyncTest('getFixturesFromScrapers: returns correct structure', async () => {
    const result = await fixturesScraper.getFixturesFromScrapers({
      teamName: 'Arsenal',
      daysAhead: 14,
      useTSDB: true,
      useBBC: false,  // Skip BBC to avoid network issues in tests
      useLFOTV: false  // Skip LFOTV to avoid network issues in tests
    });
    
    assert(Array.isArray(result));
    
    // Each fixture should have required fields
    for (const fixture of result) {
      assert('homeTeam' in fixture);
      assert('awayTeam' in fixture);
      assert('summary' in fixture);
      assert('source' in fixture);
      assert('tvChannels' in fixture);
      assert(Array.isArray(fixture.tvChannels));
    }
  });
  
  // Test getFixturesForTeams with empty teams
  await asyncTest('getFixturesForTeams: handles empty teams array', async () => {
    const result = await fixturesScraper.getFixturesForTeams({ teams: [] });
    
    assert(Array.isArray(result));
    assert.strictEqual(result.length, 0);
  });
  
  // Test health check
  await asyncTest('healthCheck: returns correct structure', async () => {
    const result = await fixturesScraper.healthCheck();
    
    assert('ok' in result);
    assert(typeof result.ok === 'boolean');
    assert('sources' in result);
    assert(typeof result.sources === 'object');
    assert('tsdb' in result.sources);
    assert('bbc' in result.sources);
    assert('lfotv' in result.sources);
  });
}

// Run integration tests
runIntegrationTests().then(() => {
  console.log(`\n======================\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
