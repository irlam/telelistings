// tests/lstv.test.js
// Test suite for TV data scrapers: LSTV, TSDB, and Wikipedia.

const assert = require('assert');
const path = require('path');

// Import the scrapers
const lstv = require('../scrapers/lstv');
const tsdb = require('../scrapers/thesportsdb');
const wiki = require('../scrapers/wiki_broadcasters');

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

console.log('LSTV Scraper Tests\n==================\n');

// ---------- Unit Tests ----------

test('normalizeTeamName: basic normalization', () => {
  assert.strictEqual(lstv.normalizeTeamName('Arsenal'), 'arsenal');
  assert.strictEqual(lstv.normalizeTeamName('Manchester United'), 'manchester-united');
  assert.strictEqual(lstv.normalizeTeamName('Man City'), 'man-city');
  assert.strictEqual(lstv.normalizeTeamName('  Tottenham  '), 'tottenham');
});

test('normalizeTeamName: special characters', () => {
  assert.strictEqual(lstv.normalizeTeamName("Queen's Park Rangers"), 'queen-s-park-rangers');
  assert.strictEqual(lstv.normalizeTeamName('FC Bayern München'), 'fc-bayern-m-nchen');
});

test('normalizeTeamName: empty/null input', () => {
  assert.strictEqual(lstv.normalizeTeamName(''), '');
  assert.strictEqual(lstv.normalizeTeamName(null), '');
  assert.strictEqual(lstv.normalizeTeamName(undefined), '');
});

test('buildSearchUrls: generates correct URLs', () => {
  const urls = lstv.buildSearchUrls('Arsenal', 'Chelsea');
  
  // Should include direct match page URLs
  assert(urls.some(url => url.includes('/match/arsenal-vs-chelsea/')), 'Should include vs format');
  assert(urls.some(url => url.includes('/match/arsenal-v-chelsea/')), 'Should include v format');
  
  // Should include team schedule URLs
  assert(urls.some(url => url.includes('/teams/england/arsenal/')), 'Should include England team URL');
});

test('buildSearchUrls: handles team names with spaces', () => {
  const urls = lstv.buildSearchUrls('Manchester United', 'Manchester City');
  
  assert(urls.some(url => url.includes('manchester-united-vs-manchester-city')), 'Should handle spaces as hyphens');
});

test('findChromePath: returns string or null', () => {
  const chromePath = lstv.findChromePath();
  assert(chromePath === null || typeof chromePath === 'string', 'Should return string or null');
});

test('BASE_URL: is correct', () => {
  assert.strictEqual(lstv.BASE_URL, 'https://www.livesoccertv.com');
});

// ---------- Match Scoring Tests ----------

console.log('\n--- Match Scoring Tests ---\n');

test('normalizeForComparison: strips common suffixes', () => {
  assert.strictEqual(lstv.normalizeForComparison('Arsenal FC'), 'arsenal');
  assert.strictEqual(lstv.normalizeForComparison('Manchester United'), 'manchester');
  assert.strictEqual(lstv.normalizeForComparison('AFC Bournemouth'), 'bournemouth');
  // Test actual behavior - normalize removes "albion" but keeps other words
  const brightonResult = lstv.normalizeForComparison('Brighton & Hove Albion');
  assert(brightonResult.includes('brighton'), `Expected "brighton" in result, got "${brightonResult}"`);
  assert(brightonResult.includes('hove'), `Expected "hove" in result, got "${brightonResult}"`);
});

test('teamNameSimilarity: exact match returns 100', () => {
  assert.strictEqual(lstv.teamNameSimilarity('Arsenal', 'Arsenal'), 100);
  assert.strictEqual(lstv.teamNameSimilarity('Arsenal FC', 'Arsenal'), 100);
});

test('teamNameSimilarity: substring match returns high score', () => {
  const score = lstv.teamNameSimilarity('Arsenal', 'Arsenal FC');
  assert(score >= 80, `Expected score >= 80 for substring match, got ${score}`);
});

test('teamNameSimilarity: word match returns reasonable score', () => {
  // Man City vs Manchester City - should get some match due to "city"
  const score = lstv.teamNameSimilarity('Manchester City', 'Man City');
  assert(score >= 20, `Expected score >= 20 for partial word match, got ${score}`);
});

test('teamNameSimilarity: no match returns low score', () => {
  const score = lstv.teamNameSimilarity('Arsenal', 'Chelsea');
  assert(score < 50, `Expected score < 50 for no match, got ${score}`);
});

test('scoreCandidate: good match scores high', () => {
  const score = lstv.scoreCandidate(
    { homeTeam: 'Arsenal', awayTeam: 'Chelsea', dateTime: new Date() },
    { home: 'Arsenal', away: 'Chelsea', date: new Date() }
  );
  assert(score >= 50, `Expected score >= 50 for good match, got ${score}`);
});

test('scoreCandidate: wrong teams score lower than correct teams', () => {
  const correctScore = lstv.scoreCandidate(
    { homeTeam: 'Arsenal', awayTeam: 'Chelsea', dateTime: new Date() },
    { home: 'Arsenal', away: 'Chelsea', date: new Date() }
  );
  const wrongScore = lstv.scoreCandidate(
    { homeTeam: 'Liverpool', awayTeam: 'Manchester City', dateTime: new Date() },
    { home: 'Arsenal', away: 'Chelsea', date: new Date() }
  );
  assert(wrongScore < correctScore, `Wrong teams (${wrongScore}) should score lower than correct teams (${correctScore})`);
});

test('SCORE_THRESHOLD: is defined', () => {
  assert(typeof lstv.SCORE_THRESHOLD === 'number', 'SCORE_THRESHOLD should be a number');
  assert(lstv.SCORE_THRESHOLD > 0 && lstv.SCORE_THRESHOLD < 100, 'SCORE_THRESHOLD should be between 0 and 100');
});

// ---------- TSDB Module Tests ----------

console.log('\n--- TheSportsDB Module Tests ---\n');

test('TSDB normalizeTeamName: basic normalization', () => {
  assert.strictEqual(tsdb.normalizeTeamName('Arsenal FC'), 'arsenal');
  assert.strictEqual(tsdb.normalizeTeamName('Manchester United'), 'manchester');
  assert.strictEqual(tsdb.normalizeTeamName('Chelsea'), 'chelsea');
});

test('TSDB teamsMatch: exact match', () => {
  assert.strictEqual(tsdb.teamsMatch('Arsenal', 'Arsenal'), true);
  assert.strictEqual(tsdb.teamsMatch('Arsenal FC', 'Arsenal'), true);
});

test('TSDB teamsMatch: no match', () => {
  assert.strictEqual(tsdb.teamsMatch('Arsenal', 'Chelsea'), false);
});

test('TSDB getApiKey: returns string', () => {
  const key = tsdb.getApiKey();
  assert(typeof key === 'string', 'API key should be string');
  assert(key.length > 0, 'API key should not be empty');
});

test('TSDB BASE_URL: is correct', () => {
  assert.strictEqual(tsdb.BASE_URL, 'https://www.thesportsdb.com/api/v1/json');
});

// ---------- Wikipedia Module Tests ----------

console.log('\n--- Wikipedia Broadcaster Module Tests ---\n');

test('WIKI getCurrentSeason: returns valid season format', () => {
  const season = wiki.getCurrentSeason();
  assert(typeof season === 'string', 'Season should be string');
  // Should match format like "2024–25"
  assert(/^\d{4}–\d{2}$/.test(season), `Season should match format YYYY–YY, got "${season}"`);
});

test('WIKI getCurrentSeason: handles date in August', () => {
  const augDate = new Date('2024-08-15');
  const season = wiki.getCurrentSeason(augDate);
  assert.strictEqual(season, '2024–25', 'August should be start of new season');
});

test('WIKI getCurrentSeason: handles date in January', () => {
  const janDate = new Date('2025-01-15');
  const season = wiki.getCurrentSeason(janDate);
  assert.strictEqual(season, '2024–25', 'January should be second half of season');
});

test('WIKI buildWikiTitle: Premier League', () => {
  const title = wiki.buildWikiTitle('Premier League', '2024–25');
  assert.strictEqual(title, '2024–25 Premier League');
});

test('WIKI buildWikiTitle: Champions League', () => {
  const title = wiki.buildWikiTitle('UEFA Champions League', '2024–25');
  assert.strictEqual(title, '2024–25 UEFA Champions League');
});

test('WIKI buildWikiTitle: FA Cup', () => {
  const title = wiki.buildWikiTitle('FA Cup', '2024–25');
  assert.strictEqual(title, '2024–25 FA Cup');
});

test('WIKI buildWikiTitle: unknown league uses fallback', () => {
  const title = wiki.buildWikiTitle('Some Random League', '2024–25');
  assert(typeof title === 'string', 'Should return string for unknown league');
  assert(title.includes('2024–25'), 'Should include season');
});

test('WIKI buildWikiUrl: builds correct URL', () => {
  const url = wiki.buildWikiUrl('2024–25 Premier League');
  assert(url.includes('wikipedia.org'), 'Should include wikipedia.org');
  assert(url.includes('Premier_League'), 'Should have underscores for spaces');
});

test('WIKI cleanChannelName: removes citations', () => {
  assert.strictEqual(wiki.cleanChannelName('Sky Sports[1]'), 'Sky Sports');
  assert.strictEqual(wiki.cleanChannelName('TNT Sports[2][3]'), 'TNT Sports');
});

test('WIKI cleanChannelName: removes parenthetical notes', () => {
  assert.strictEqual(wiki.cleanChannelName('Sky Sports (Main Event)'), 'Sky Sports');
});

test('WIKI cleanRegionName: removes citations', () => {
  assert.strictEqual(wiki.cleanRegionName('United Kingdom[1]'), 'United Kingdom');
});

test('WIKI getUniqueChannels: returns unique values', () => {
  const broadcasters = [
    { region: 'UK', channel: 'Sky Sports' },
    { region: 'UK', channel: 'TNT Sports' },
    { region: 'UK', channel: 'Sky Sports' }, // duplicate
    { region: 'USA', channel: 'NBC' }
  ];
  const unique = wiki.getUniqueChannels(broadcasters);
  assert.strictEqual(unique.length, 3, 'Should have 3 unique channels');
  assert(unique.includes('Sky Sports'), 'Should include Sky Sports');
  assert(unique.includes('TNT Sports'), 'Should include TNT Sports');
  assert(unique.includes('NBC'), 'Should include NBC');
});

test('WIKI getUniqueChannels: filters by region', () => {
  const broadcasters = [
    { region: 'United Kingdom', channel: 'Sky Sports' },
    { region: 'United Kingdom', channel: 'TNT Sports' },
    { region: 'United States', channel: 'NBC' }
  ];
  const ukChannels = wiki.getUniqueChannels(broadcasters, 'UK');
  assert.strictEqual(ukChannels.length, 2, 'Should have 2 UK channels');
  assert(!ukChannels.includes('NBC'), 'Should not include NBC');
});

test('WIKI LEAGUE_PATTERNS: has expected leagues', () => {
  assert('premier league' in wiki.LEAGUE_PATTERNS, 'Should have Premier League');
  assert('champions league' in wiki.LEAGUE_PATTERNS, 'Should have Champions League');
  assert('fa cup' in wiki.LEAGUE_PATTERNS, 'Should have FA Cup');
});

// ---------- Integration Tests (require network/browser) ----------

console.log('\n--- Integration Tests ---\n');

async function runIntegrationTests() {
  // Test fetchLSTV with invalid input - should never throw
  await asyncTest('fetchLSTV: handles missing team names gracefully', async () => {
    const result = await lstv.fetchLSTV({ home: '', away: '' });
    
    assert(result !== null, 'Should return object, not null');
    assert(Array.isArray(result.regionChannels), 'Should have regionChannels array');
    assert.strictEqual(result.regionChannels.length, 0, 'Should have empty array for invalid input');
  });
  
  await asyncTest('fetchLSTV: returns correct structure with matchScore', async () => {
    const result = await lstv.fetchLSTV({ 
      home: 'Test Team A', 
      away: 'Test Team B',
      date: new Date() 
    });
    
    // Verify structure
    assert('url' in result, 'Should have url property');
    assert('kickoffUtc' in result, 'Should have kickoffUtc property');
    assert('regionChannels' in result, 'Should have regionChannels property');
    assert('matchScore' in result, 'Should have matchScore property');
    assert(Array.isArray(result.regionChannels), 'regionChannels should be array');
    
    // Each channel entry should have region and channel
    for (const rc of result.regionChannels) {
      assert('region' in rc, 'Each entry should have region');
      assert('channel' in rc, 'Each entry should have channel');
    }
  });
  
  // Test health check - may fail if Chrome not available but should not throw
  await asyncTest('healthCheck: returns correct structure', async () => {
    const result = await lstv.healthCheck();
    
    assert('ok' in result, 'Should have ok property');
    assert(typeof result.ok === 'boolean', 'ok should be boolean');
    assert('latencyMs' in result, 'Should have latencyMs property');
    assert(typeof result.latencyMs === 'number', 'latencyMs should be number');
    
    if (!result.ok) {
      assert('error' in result, 'Failed result should have error property');
    }
  });
  
  // Test TSDB fetchTSDBFixture with invalid input
  await asyncTest('TSDB fetchTSDBFixture: handles missing team names gracefully', async () => {
    const result = await tsdb.fetchTSDBFixture({ home: '', away: '' });
    
    assert(result !== null, 'Should return object, not null');
    assert.strictEqual(result.matched, false, 'Should not match with invalid input');
    assert(Array.isArray(result.tvStations), 'Should have tvStations array');
  });
  
  await asyncTest('TSDB fetchTSDBFixture: returns correct structure', async () => {
    const result = await tsdb.fetchTSDBFixture({
      home: 'Arsenal',
      away: 'Chelsea',
      date: new Date()
    });
    
    // Verify structure (may or may not find a match depending on fixtures)
    assert('matched' in result, 'Should have matched property');
    assert(typeof result.matched === 'boolean', 'matched should be boolean');
    assert('kickoffUtc' in result, 'Should have kickoffUtc property');
    assert('league' in result, 'Should have league property');
    assert('venue' in result, 'Should have venue property');
    assert('tvStations' in result, 'Should have tvStations property');
    assert(Array.isArray(result.tvStations), 'tvStations should be array');
  });
  
  // Test TSDB health check
  await asyncTest('TSDB healthCheck: returns correct structure', async () => {
    const result = await tsdb.healthCheck();
    
    assert('ok' in result, 'Should have ok property');
    assert(typeof result.ok === 'boolean', 'ok should be boolean');
    assert('latencyMs' in result, 'Should have latencyMs property');
    assert(typeof result.latencyMs === 'number', 'latencyMs should be number');
  });
  
  // Test WIKI fetchWikiBroadcasters with invalid input
  await asyncTest('WIKI fetchWikiBroadcasters: handles missing league name', async () => {
    const result = await wiki.fetchWikiBroadcasters({ leagueName: '' });
    
    assert(result !== null, 'Should return object, not null');
    assert(Array.isArray(result.broadcasters), 'Should have broadcasters array');
    assert.strictEqual(result.broadcasters.length, 0, 'Should have empty array for invalid input');
  });
  
  await asyncTest('WIKI fetchWikiBroadcasters: returns correct structure', async () => {
    const result = await wiki.fetchWikiBroadcasters({
      leagueName: 'Premier League',
      season: '2024–25',
      country: 'UK'
    });
    
    // Verify structure (may or may not find data depending on network/Wikipedia)
    assert('sourceUrl' in result, 'Should have sourceUrl property');
    assert('broadcasters' in result, 'Should have broadcasters property');
    assert(Array.isArray(result.broadcasters), 'broadcasters should be array');
    
    // Each broadcaster entry should have region and channel
    for (const b of result.broadcasters) {
      assert('region' in b, 'Each entry should have region');
      assert('channel' in b, 'Each entry should have channel');
    }
  });
}

// Run integration tests
runIntegrationTests().then(() => {
  console.log(`\n==================\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
