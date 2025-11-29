// tests/lstv.test.js
// Minimal test suite for the LSTV (LiveSoccerTV) Puppeteer scraper.

const assert = require('assert');
const path = require('path');

// Import the LSTV scraper
const lstv = require('../scrapers/lstv');

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
  
  await asyncTest('fetchLSTV: returns correct structure', async () => {
    const result = await lstv.fetchLSTV({ 
      home: 'Test Team A', 
      away: 'Test Team B',
      date: new Date() 
    });
    
    // Verify structure
    assert('url' in result, 'Should have url property');
    assert('kickoffUtc' in result, 'Should have kickoffUtc property');
    assert('regionChannels' in result, 'Should have regionChannels property');
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
}

// Run integration tests
runIntegrationTests().then(() => {
  console.log(`\n==================\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
