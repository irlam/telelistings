// tests/auto_tester.test.js
// Test suite for the auto-tester module.

const assert = require('assert');

// Import the auto-tester
const autoTester = require('../lib/auto_tester');
const scrapeStore = require('../lib/scrape_store');

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

console.log('Auto-Tester Module Tests\n========================\n');

// ---------- Unit Tests ----------

console.log('--- Scraper Registry Tests ---\n');

test('listScrapers: returns array of scrapers', () => {
  const scrapers = autoTester.listScrapers();
  assert(Array.isArray(scrapers));
  assert(scrapers.length > 0);
});

test('listScrapers: each scraper has required fields', () => {
  const scrapers = autoTester.listScrapers();
  for (const scraper of scrapers) {
    assert('id' in scraper);
    assert('name' in scraper);
    assert('description' in scraper);
    assert('hasHealthCheck' in scraper);
  }
});

test('getScraperConfig: returns config for valid scraper', () => {
  const config = autoTester.getScraperConfig('lstv');
  assert(config !== null);
  assert.strictEqual(config.id, 'lstv');
  assert.strictEqual(config.name, 'LiveSoccerTV');
});

test('getScraperConfig: returns null for invalid scraper', () => {
  const config = autoTester.getScraperConfig('nonexistent');
  assert.strictEqual(config, null);
});

test('SCRAPER_REGISTRY: has expected scrapers', () => {
  const registry = autoTester.SCRAPER_REGISTRY;
  assert('lstv' in registry);
  assert('tsdb' in registry);
  assert('bbc' in registry);
  assert('sky' in registry);
  assert('tnt' in registry);
  assert('lfotv' in registry);
});

// ---------- Scrape Store Tests ----------

console.log('\n--- Scrape Store Tests ---\n');

test('getTimestamp: returns correct format', () => {
  const timestamp = scrapeStore.getTimestamp();
  assert(typeof timestamp === 'string');
  // Should match YYYY-MM-DD_HHMMSS format
  assert(/^\d{4}-\d{2}-\d{2}_\d{6}$/.test(timestamp));
});

test('getDateString: returns correct format', () => {
  const dateStr = scrapeStore.getDateString();
  assert(typeof dateStr === 'string');
  // Should match YYYY-MM-DD format
  assert(/^\d{4}-\d{2}-\d{2}$/.test(dateStr));
});

test('getDateString: accepts custom date', () => {
  const date = new Date('2024-12-15T10:00:00Z');
  const dateStr = scrapeStore.getDateString(date);
  assert.strictEqual(dateStr, '2024-12-15');
});

test('storeResults: stores and retrieves results', () => {
  const testResult = { test: true, data: [1, 2, 3] };
  const storeResult = scrapeStore.storeResults('test_scraper', testResult);
  assert(storeResult.success);
  
  const retrieved = scrapeStore.getLatestResults('test_scraper');
  assert(retrieved !== null);
  assert.strictEqual(retrieved.scraperId, 'test_scraper');
  assert.deepStrictEqual(retrieved.results.data, [1, 2, 3]);
});

test('getResultHistory: returns array', () => {
  const history = scrapeStore.getResultHistory('test_scraper', 10);
  assert(Array.isArray(history));
});

test('listStoredScrapers: returns array', () => {
  const scrapers = scrapeStore.listStoredScrapers();
  assert(Array.isArray(scrapers));
});

test('storeAutoTestResult: stores test result', () => {
  const testResult = { success: true, durationMs: 100 };
  const result = scrapeStore.storeAutoTestResult('test_scraper', testResult);
  assert(result.success);
});

test('getAutoTestResult: retrieves stored result', () => {
  const result = scrapeStore.getAutoTestResult('test_scraper');
  assert(result !== null);
  assert.strictEqual(result.scraperId, 'test_scraper');
});

// ---------- Integration Tests ----------

console.log('\n--- Integration Tests ---\n');

async function runIntegrationTests() {
  await asyncTest('runHealthCheck: returns correct structure', async () => {
    const result = await autoTester.runHealthCheck('lstv');
    assert('ok' in result);
    assert(typeof result.ok === 'boolean');
  });
  
  await asyncTest('runHealthCheck: handles unknown scraper', async () => {
    const result = await autoTester.runHealthCheck('nonexistent');
    assert.strictEqual(result.ok, false);
    assert('error' in result);
  });
  
  await asyncTest('runFunctionalTest: returns correct structure', async () => {
    const result = await autoTester.runFunctionalTest('lstv');
    assert('success' in result);
    assert('result' in result);
    assert('durationMs' in result);
  });
  
  await asyncTest('runScraperTest: returns complete test result', async () => {
    const result = await autoTester.runScraperTest('lstv', { storeResults: false });
    assert('scraperId' in result);
    assert('name' in result);
    assert('health' in result);
    assert('functional' in result);
    assert('success' in result);
    assert('timestamp' in result);
  });
  
  await asyncTest('getHealthStatus: returns health for all scrapers', async () => {
    const status = await autoTester.getHealthStatus();
    assert('timestamp' in status);
    assert('healthy' in status);
    assert('total' in status);
    assert('scrapers' in status);
    assert(typeof status.scrapers === 'object');
  });
}

// Run integration tests
runIntegrationTests().then(() => {
  console.log(`\n========================\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  // Use process.exitCode for graceful exit (allows cleanup handlers to run)
  process.exitCode = failed > 0 ? 1 : 0;
}).catch(err => {
  console.error('Test runner error:', err);
  process.exitCode = 1;
});
