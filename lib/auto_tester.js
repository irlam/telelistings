// lib/auto_tester.js
// Automated test runner for all scrapers.
/**
 * Telegram Sports TV Bot – Automated Scraper Tester
 *
 * This module provides automated testing for all scrapers.
 * It runs health checks and functional tests, stores results,
 * and generates reports.
 *
 * Features:
 * - Auto-discover and test all scrapers
 * - Run health checks for each scraper
 * - Run functional tests with real fixtures
 * - Store and persist results
 * - Generate summary reports
 *
 * Usage:
 *   const { runAllTests, runScraperTest } = require('./lib/auto_tester');
 *   const results = await runAllTests();
 */

const fs = require('fs');
const path = require('path');
const scrapeStore = require('./scrape_store');

// ---------- Scraper Registry ----------

// Define all available scrapers with their test configurations
const SCRAPER_REGISTRY = {
  lstv: {
    id: 'lstv',
    name: 'LiveSoccerTV',
    description: 'TV channel information from LiveSoccerTV.com',
    module: '../scrapers/lstv',
    hasHealthCheck: true,
    testMethod: 'fetchLSTVFixtures',
    // Fetch all fixtures for UK region
    testParams: { region: 'UK' },
    requiresVPS: true
  },
  tsdb: {
    id: 'tsdb',
    name: 'TheSportsDB',
    description: 'Fixture data from TheSportsDB API',
    module: '../scrapers/thesportsdb',
    hasHealthCheck: true,
    testMethod: 'fetchTSDBFixtures',
    // Fetch all fixtures for today (no team-specific filter)
    testParams: { date: new Date(), region: 'UK' },
    requiresVPS: false
  },
  wiki: {
    id: 'wiki',
    name: 'Wikipedia Broadcasters',
    description: 'League broadcasting info from Wikipedia',
    module: '../scrapers/wiki_broadcasters',
    hasHealthCheck: false,
    testMethod: 'fetchWikiBroadcasters',
    testParams: { leagueName: 'Premier League' },
    requiresVPS: false
  },
  bbc: {
    id: 'bbc',
    name: 'BBC Sport',
    description: 'Fixture data from BBC Sport',
    module: '../scrapers/bbc_fixtures',
    hasHealthCheck: true,
    testMethod: 'fetchBBCFixtures',
    // Empty params fetches all fixtures from main football page
    testParams: {},
    requiresVPS: false
  },
  sky: {
    id: 'sky',
    name: 'Sky Sports',
    description: 'Sky Sports fixtures and channels',
    module: '../scrapers/skysports',
    hasHealthCheck: true,
    testMethod: 'fetchSkyFixtures',
    testParams: {},
    requiresVPS: false
  },
  tnt: {
    id: 'tnt',
    name: 'TNT Sports',
    description: 'TNT Sports fixtures and channels',
    module: '../scrapers/tnt',
    hasHealthCheck: true,
    testMethod: 'fetchTNTFixtures',
    testParams: {},
    requiresVPS: false
  },
  lfotv: {
    id: 'lfotv',
    name: 'LiveFootballOnTV',
    description: 'UK TV listings from LiveFootballOnTV',
    module: '../scrapers/livefootballontv',
    hasHealthCheck: true,
    testMethod: 'fetchLFOTVFixtures',
    testParams: {},
    requiresVPS: false
  },
  footballdata: {
    id: 'footballdata',
    name: 'FootballData.org',
    description: 'Fixture data from FootballData.org API',
    module: '../scrapers/footballdata',
    hasHealthCheck: true,
    testMethod: 'fetchFootballData',
    // General fixtures (no team-specific filter)
    testParams: {},
    requiresVPS: false
  },
  // ---------- VPS Scrapers ----------
  // These scrapers run on the VPS using Puppeteer for browser automation
  'vps-lstv': {
    id: 'vps-lstv',
    name: 'VPS LiveSoccerTV',
    description: 'LiveSoccerTV scraper using Puppeteer (VPS)',
    module: '/opt/vps-scrapers/scrapers/lstv',
    hasHealthCheck: true,
    testMethod: 'scrapeLSTVFixtures',
    testParams: { region: 'UK' },
    requiresVPS: true
  },
  'vps-bbc': {
    id: 'vps-bbc',
    name: 'VPS BBC Sport',
    description: 'BBC Sport scraper using Puppeteer (VPS)',
    module: '/opt/vps-scrapers/scrapers/bbc',
    hasHealthCheck: true,
    testMethod: 'fetchBBCFixtures',
    testParams: {},
    requiresVPS: true
  },
  'vps-sky': {
    id: 'vps-sky',
    name: 'VPS Sky Sports',
    description: 'Sky Sports scraper using Puppeteer (VPS)',
    module: '/opt/vps-scrapers/scrapers/skysports',
    hasHealthCheck: true,
    testMethod: 'fetchSkyFixtures',
    testParams: {},
    requiresVPS: true
  },
  'vps-tnt': {
    id: 'vps-tnt',
    name: 'VPS TNT Sports',
    description: 'TNT Sports scraper using Puppeteer (VPS)',
    module: '/opt/vps-scrapers/scrapers/tnt',
    hasHealthCheck: true,
    testMethod: 'fetchTNTFixtures',
    testParams: {},
    requiresVPS: true
  },
  'vps-lfotv': {
    id: 'vps-lfotv',
    name: 'VPS LiveFootballOnTV',
    description: 'LiveFootballOnTV scraper using Puppeteer (VPS)',
    module: '/opt/vps-scrapers/scrapers/livefootballontv',
    hasHealthCheck: true,
    testMethod: 'fetchLFOTVFixtures',
    testParams: {},
    requiresVPS: true
  },
  'vps-prosoccertv': {
    id: 'vps-prosoccertv',
    name: 'VPS ProSoccer.TV',
    description: 'ProSoccer.TV scraper using Puppeteer (VPS)',
    module: '/opt/vps-scrapers/scrapers/prosoccertv',
    hasHealthCheck: true,
    testMethod: 'fetchProSoccerFixtures',
    testParams: {},
    requiresVPS: true
  },
  'vps-oddalerts': {
    id: 'vps-oddalerts',
    name: 'VPS OddAlerts',
    description: 'OddAlerts TV Guide scraper using Puppeteer (VPS)',
    module: '/opt/vps-scrapers/scrapers/oddalerts',
    hasHealthCheck: true,
    testMethod: 'fetchOddAlertsFixtures',
    testParams: {},
    requiresVPS: true
  },
  'vps-sporteventz': {
    id: 'vps-sporteventz',
    name: 'VPS SportEventz',
    description: 'SportEventz scraper using Puppeteer (VPS)',
    module: '/opt/vps-scrapers/scrapers/sporteventz',
    hasHealthCheck: true,
    testMethod: 'fetchSportEventzFixtures',
    testParams: {},
    requiresVPS: true
  },
  'vps-wheresthematch': {
    id: 'vps-wheresthematch',
    name: 'VPS Where\'s The Match',
    description: 'Where\'s The Match scraper using Puppeteer (VPS)',
    module: '/opt/vps-scrapers/scrapers/wheresthematch',
    hasHealthCheck: true,
    testMethod: 'fetchWheresTheMatchFixtures',
    testParams: {},
    requiresVPS: true
  },
  'vps-worldsoccertalk': {
    id: 'vps-worldsoccertalk',
    name: 'VPS World Soccer Talk',
    description: 'World Soccer Talk scraper using Puppeteer (VPS)',
    module: '/opt/vps-scrapers/scrapers/worldsoccertalk',
    hasHealthCheck: true,
    testMethod: 'fetchWorldSoccerTalkFixtures',
    testParams: {},
    requiresVPS: true
  }
};

// ---------- Logging ----------

const LOG_PATH = path.join(__dirname, '..', 'autopost.log');

/**
 * Log a message with [AUTOTEST] prefix.
 * @param {string} msg - Message to log
 */
function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [AUTOTEST] ${msg}`;
  console.log(line);
  
  try {
    fs.appendFileSync(LOG_PATH, line + '\n', 'utf8');
  } catch (err) {
    // Ignore file errors
  }
}

// ---------- Module Loading ----------

/**
 * Safely load a scraper module.
 * @param {string} modulePath - Path to module
 * @returns {Object | null} Module or null if not found
 */
function loadModule(modulePath) {
  try {
    return require(modulePath);
  } catch (err) {
    return null;
  }
}

// ---------- Test Functions ----------

/**
 * Run health check for a scraper.
 *
 * @param {string} scraperId - Scraper identifier
 * @returns {Promise<{ok: boolean, latencyMs: number, error: string | null}>}
 */
async function runHealthCheck(scraperId) {
  const config = SCRAPER_REGISTRY[scraperId];
  if (!config) {
    return { ok: false, latencyMs: 0, error: `Unknown scraper: ${scraperId}` };
  }
  
  if (!config.hasHealthCheck) {
    return { ok: true, latencyMs: 0, error: null, skipped: true };
  }
  
  const module = loadModule(config.module);
  if (!module) {
    return { ok: false, latencyMs: 0, error: `Module not found: ${config.module}` };
  }
  
  if (typeof module.healthCheck !== 'function') {
    return { ok: false, latencyMs: 0, error: 'healthCheck function not found' };
  }
  
  try {
    const result = await module.healthCheck();
    return result;
  } catch (err) {
    return { ok: false, latencyMs: 0, error: err.message };
  }
}

/**
 * Run functional test for a scraper.
 *
 * @param {string} scraperId - Scraper identifier
 * @param {Object} [customParams] - Override default test parameters
 * @returns {Promise<{success: boolean, result: Object | null, error: string | null, durationMs: number}>}
 */
async function runFunctionalTest(scraperId, customParams = null) {
  const config = SCRAPER_REGISTRY[scraperId];
  if (!config) {
    return { success: false, result: null, error: `Unknown scraper: ${scraperId}`, durationMs: 0 };
  }
  
  const module = loadModule(config.module);
  if (!module) {
    return { success: false, result: null, error: `Module not found: ${config.module}`, durationMs: 0 };
  }
  
  const testMethod = module[config.testMethod];
  if (typeof testMethod !== 'function') {
    return { success: false, result: null, error: `Test method not found: ${config.testMethod}`, durationMs: 0 };
  }
  
  const params = customParams || config.testParams;
  const startTime = Date.now();
  
  try {
    const result = await testMethod(params);
    const durationMs = Date.now() - startTime;
    
    // Determine success based on result content
    let success = false;
    if (result) {
      if (Array.isArray(result)) {
        success = result.length > 0;
      } else if (result.matches) {
        success = result.matches.length > 0;
      } else if (result.fixtures) {
        success = result.fixtures.length > 0;
      } else if (result.regionChannels) {
        success = result.regionChannels.length > 0;
      } else if (result.broadcasters) {
        success = result.broadcasters.length > 0;
      } else if (result.matched !== undefined) {
        success = result.matched;
      } else if (result.kickoffUtc) {
        success = true;
      }
    }
    
    return { success, result, error: null, durationMs };
    
  } catch (err) {
    const durationMs = Date.now() - startTime;
    return { success: false, result: null, error: err.message, durationMs };
  }
}

/**
 * Run complete test for a scraper (health + functional).
 *
 * @param {string} scraperId - Scraper identifier
 * @param {Object} [options] - Test options
 * @param {Object} [options.customParams] - Custom test parameters
 * @param {boolean} [options.storeResults=true] - Store results to file
 * @returns {Promise<Object>} Test result object
 */
async function runScraperTest(scraperId, options = {}) {
  const { customParams = null, storeResults = true } = options;
  
  const config = SCRAPER_REGISTRY[scraperId];
  if (!config) {
    return {
      scraperId,
      name: scraperId,
      success: false,
      error: `Unknown scraper: ${scraperId}`,
      timestamp: new Date().toISOString()
    };
  }
  
  log(`Starting test for ${config.name} (${scraperId})`);
  const startTime = Date.now();
  
  // Run health check
  const healthResult = await runHealthCheck(scraperId);
  
  // Run functional test
  const functionalResult = await runFunctionalTest(scraperId, customParams);
  
  const totalDurationMs = Date.now() - startTime;
  
  // Build result object
  const result = {
    scraperId,
    name: config.name,
    description: config.description,
    requiresVPS: config.requiresVPS,
    timestamp: new Date().toISOString(),
    totalDurationMs,
    health: healthResult,
    functional: functionalResult,
    success: (healthResult.ok || healthResult.skipped) && functionalResult.success
  };
  
  // Log result
  const status = result.success ? 'PASS' : 'FAIL';
  log(`${config.name}: ${status} (health=${healthResult.ok}, functional=${functionalResult.success}, ${totalDurationMs}ms)`);
  
  // Store results
  if (storeResults) {
    scrapeStore.storeAutoTestResult(scraperId, result);
    
    // Also store the functional test result data if successful
    if (functionalResult.success && functionalResult.result) {
      scrapeStore.storeResults(scraperId, functionalResult.result, {
        duration_ms: functionalResult.durationMs,
        testMode: true
      });
    }
  }
  
  return result;
}

/**
 * Run tests for all registered scrapers.
 *
 * @param {Object} [options] - Test options
 * @param {boolean} [options.storeResults=true] - Store results to file
 * @param {boolean} [options.stopOnError=false] - Stop on first error
 * @param {string[]} [options.scraperIds] - Only test these scrapers
 * @returns {Promise<Object>} Summary of all test results
 */
async function runAllTests(options = {}) {
  const { storeResults = true, stopOnError = false, scraperIds = null } = options;
  
  log('Starting auto-test run for all scrapers');
  const startTime = Date.now();
  
  // Determine which scrapers to test
  const scrapersToTest = scraperIds || Object.keys(SCRAPER_REGISTRY);
  
  const results = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  
  for (const scraperId of scrapersToTest) {
    try {
      const result = await runScraperTest(scraperId, { storeResults });
      results.push(result);
      
      if (result.success) {
        passed++;
      } else {
        failed++;
        if (stopOnError) {
          log(`Stopping on error: ${scraperId}`);
          break;
        }
      }
    } catch (err) {
      results.push({
        scraperId,
        name: SCRAPER_REGISTRY[scraperId]?.name || scraperId,
        success: false,
        error: err.message,
        timestamp: new Date().toISOString()
      });
      failed++;
      if (stopOnError) break;
    }
    
    // Small delay between tests
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  const totalDurationMs = Date.now() - startTime;
  
  // Build summary
  const summary = {
    timestamp: new Date().toISOString(),
    totalDurationMs,
    total: results.length,
    passed,
    failed,
    skipped,
    allPassed: failed === 0,
    results
  };
  
  log(`Auto-test complete: ${passed}/${results.length} passed in ${totalDurationMs}ms`);
  
  // Store summary
  if (storeResults) {
    scrapeStore.storeResults('auto_test_summary', summary, {
      passed,
      failed,
      total: results.length
    });
  }
  
  return summary;
}

/**
 * Get list of all registered scrapers.
 *
 * @returns {Array<Object>} Scraper configurations
 */
function listScrapers() {
  return Object.values(SCRAPER_REGISTRY).map(config => ({
    id: config.id,
    name: config.name,
    description: config.description,
    hasHealthCheck: config.hasHealthCheck,
    requiresVPS: config.requiresVPS
  }));
}

/**
 * Get scraper configuration by ID.
 *
 * @param {string} scraperId - Scraper identifier
 * @returns {Object | null} Scraper configuration or null
 */
function getScraperConfig(scraperId) {
  return SCRAPER_REGISTRY[scraperId] || null;
}

/**
 * Get health status for all scrapers.
 *
 * @returns {Promise<Object>} Health status summary
 */
async function getHealthStatus() {
  const scrapers = Object.keys(SCRAPER_REGISTRY);
  const results = {};
  
  for (const scraperId of scrapers) {
    results[scraperId] = await runHealthCheck(scraperId);
  }
  
  const healthy = Object.values(results).filter(r => r.ok).length;
  const total = scrapers.length;
  
  return {
    timestamp: new Date().toISOString(),
    healthy,
    total,
    allHealthy: healthy === total,
    scrapers: results
  };
}

// ---------- Module Exports ----------

module.exports = {
  runScraperTest,
  runAllTests,
  runHealthCheck,
  runFunctionalTest,
  listScrapers,
  getScraperConfig,
  getHealthStatus,
  SCRAPER_REGISTRY
};
