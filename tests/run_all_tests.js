#!/usr/bin/env node
// tests/run_all_tests.js
// Unified test runner for all test suites.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Test files to run
const testFiles = [
  'lstv.test.js',
  'fixtures_scraper.test.js',
  'auto_tester.test.js'
];

const testsDir = __dirname;
let totalPassed = 0;
let totalFailed = 0;
let filesRun = 0;

console.log('====================================');
console.log('  Telegram Sports TV Bot - Tests');
console.log('====================================\n');

async function runTestFile(file) {
  return new Promise((resolve, reject) => {
    const testPath = path.join(testsDir, file);
    
    if (!fs.existsSync(testPath)) {
      console.log(`⚠ Skipping ${file} (file not found)`);
      resolve({ passed: 0, failed: 0 });
      return;
    }
    
    console.log(`\n▶ Running ${file}...\n`);
    
    const child = spawn('node', [testPath], {
      cwd: path.join(testsDir, '..'),
      stdio: 'inherit'
    });
    
    child.on('close', (code) => {
      filesRun++;
      resolve({ code });
    });
    
    child.on('error', (err) => {
      console.error(`Error running ${file}: ${err.message}`);
      resolve({ code: 1 });
    });
  });
}

async function runAllTests() {
  const results = [];
  
  for (const file of testFiles) {
    const result = await runTestFile(file);
    results.push({ file, ...result });
  }
  
  console.log('\n====================================');
  console.log('  Test Summary');
  console.log('====================================\n');
  
  let allPassed = true;
  for (const result of results) {
    const status = result.code === 0 ? '✓' : '✗';
    const statusText = result.code === 0 ? 'PASS' : 'FAIL';
    console.log(`${status} ${result.file}: ${statusText}`);
    if (result.code !== 0) allPassed = false;
  }
  
  console.log('\n------------------------------------');
  console.log(`Total test files run: ${filesRun}`);
  console.log(`Overall result: ${allPassed ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log('====================================\n');
  
  process.exit(allPassed ? 0 : 1);
}

runAllTests();
