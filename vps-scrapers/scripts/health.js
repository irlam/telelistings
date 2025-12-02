#!/usr/bin/env node
/**
 * Health Check Script
 * 
 * Tests if the VPS scraper service is running and responding correctly.
 * Usage: node scripts/health.js [url]
 * 
 * Examples:
 *   node scripts/health.js                    # Check localhost:3333
 *   node scripts/health.js http://myserver:3333  # Check custom URL
 */

const http = require('http');

const url = process.argv[2] || 'http://localhost:3333/health';

console.log(`Checking health: ${url}`);

const req = http.get(url, (res) => {
  let data = '';
  
  res.on('data', chunk => {
    data += chunk;
  });
  
  res.on('end', () => {
    try {
      const result = JSON.parse(data);
      
      if (result.ok) {
        console.log('✓ Service is healthy');
        console.log(`  Latency: ${result.latencyMs}ms`);
        if (result.title) {
          console.log(`  Title: ${result.title}`);
        }
        process.exit(0);
      } else {
        console.log('✗ Service is unhealthy');
        console.log(`  Error: ${result.error || 'Unknown error'}`);
        process.exit(1);
      }
    } catch (e) {
      console.log('✗ Invalid response');
      console.log(`  Response: ${data}`);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.log('✗ Connection failed');
  console.log(`  Error: ${err.message}`);
  process.exit(1);
});

req.setTimeout(10000, () => {
  console.log('✗ Request timed out');
  req.destroy();
  process.exit(1);
});
