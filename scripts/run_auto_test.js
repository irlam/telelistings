#!/usr/bin/env node
// scripts/run_auto_test.js
// Command-line utility to run automated tests for all scrapers.
/**
 * Usage:
 *   node scripts/run_auto_test.js             # Run all scrapers
 *   node scripts/run_auto_test.js lstv tsdb   # Run specific scrapers
 *   node scripts/run_auto_test.js --health    # Health check only
 */

const autoTester = require('../lib/auto_tester');
const scrapeStore = require('../lib/scrape_store');

// Parse command line arguments
const args = process.argv.slice(2);
const healthOnly = args.includes('--health');
const scraperIds = args.filter(a => !a.startsWith('--'));

async function main() {
  console.log('====================================');
  console.log('  Telegram Sports TV Bot');
  console.log('  Automated Scraper Test Runner');
  console.log('====================================\n');
  
  if (healthOnly) {
    // Health check mode
    console.log('Running health checks for all scrapers...\n');
    
    const status = await autoTester.getHealthStatus();
    
    console.log(`Timestamp: ${status.timestamp}`);
    console.log(`Healthy: ${status.healthy}/${status.total}`);
    console.log(`All Healthy: ${status.allHealthy ? 'YES ✓' : 'NO ✗'}`);
    console.log('\nIndividual Results:');
    console.log('-------------------');
    
    for (const [scraperId, result] of Object.entries(status.scrapers)) {
      const icon = result.ok ? '✓' : (result.skipped ? '○' : '✗');
      const status = result.ok ? 'OK' : (result.skipped ? 'SKIP' : 'FAIL');
      const latency = result.latencyMs ? `${result.latencyMs}ms` : 'N/A';
      console.log(`${icon} ${scraperId.padEnd(10)} ${status.padEnd(6)} ${latency}`);
      if (result.error) {
        console.log(`  Error: ${result.error}`);
      }
    }
    
    process.exit(status.allHealthy ? 0 : 1);
  }
  
  // Full test mode
  const options = {
    storeResults: true,
    stopOnError: false
  };
  
  if (scraperIds.length > 0) {
    options.scraperIds = scraperIds;
    console.log(`Running tests for: ${scraperIds.join(', ')}\n`);
  } else {
    console.log('Running tests for all scrapers...\n');
  }
  
  const startTime = Date.now();
  const summary = await autoTester.runAllTests(options);
  const totalTime = Date.now() - startTime;
  
  // Print summary
  console.log('\n====================================');
  console.log('  Test Results Summary');
  console.log('====================================\n');
  
  console.log(`Timestamp: ${summary.timestamp}`);
  console.log(`Duration: ${totalTime}ms`);
  console.log(`Total: ${summary.total}`);
  console.log(`Passed: ${summary.passed}`);
  console.log(`Failed: ${summary.failed}`);
  console.log(`All Passed: ${summary.allPassed ? 'YES ✓' : 'NO ✗'}`);
  
  console.log('\nIndividual Results:');
  console.log('-------------------');
  
  for (const result of summary.results) {
    const icon = result.success ? '✓' : '✗';
    const status = result.success ? 'PASS' : 'FAIL';
    const duration = result.totalDurationMs ? `${result.totalDurationMs}ms` : 'N/A';
    console.log(`${icon} ${result.name.padEnd(20)} ${status.padEnd(6)} ${duration}`);
    
    if (result.health?.error) {
      console.log(`  Health: ${result.health.error}`);
    }
    if (result.functional?.error) {
      console.log(`  Functional: ${result.functional.error}`);
    }
  }
  
  // Show stored results location
  console.log('\n------------------------------------');
  console.log('Results stored in:');
  console.log(`  ${scrapeStore.LATEST_DIR}/`);
  console.log(`  ${scrapeStore.AUTO_TESTS_DIR}/`);
  console.log('====================================\n');
  
  process.exit(summary.allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
