#!/usr/bin/env node
// scripts/health_check.js
// Quick health check for all scrapers (designed for cron/monitoring).
/**
 * Usage:
 *   node scripts/health_check.js          # Check all scrapers
 *   node scripts/health_check.js --json   # Output as JSON
 *   node scripts/health_check.js --quiet  # Only output on failure
 */

const autoTester = require('../lib/auto_tester');

const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const quietMode = args.includes('--quiet');

async function main() {
  const startTime = Date.now();
  const status = await autoTester.getHealthStatus();
  const duration = Date.now() - startTime;
  
  if (jsonOutput) {
    // JSON output for programmatic use
    console.log(JSON.stringify({
      ...status,
      checkDurationMs: duration
    }, null, 2));
    process.exitCode = status.allHealthy ? 0 : 1;
    return;
  }
  
  if (quietMode && status.allHealthy) {
    // In quiet mode, don't output anything if all healthy
    process.exitCode = 0;
    return;
  }
  
  // Human-readable output
  const statusIcon = status.allHealthy ? '✓' : '✗';
  console.log(`Health Check: ${status.healthy}/${status.total} healthy ${statusIcon}`);
  
  // Show details if not all healthy or not in quiet mode
  if (!status.allHealthy || !quietMode) {
    for (const [scraperId, result] of Object.entries(status.scrapers)) {
      if (!result.ok && !result.skipped) {
        console.log(`  ✗ ${scraperId}: ${result.error || 'Unknown error'}`);
      }
    }
  }
  
  process.exitCode = status.allHealthy ? 0 : 1;
}

main().catch(err => {
  if (jsonOutput) {
    console.log(JSON.stringify({ ok: false, error: err.message }));
  } else {
    console.error('Health check error:', err.message);
  }
  process.exitCode = 1;
});
