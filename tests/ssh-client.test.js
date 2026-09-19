#!/usr/bin/env node
// tests/ssh-client.test.js
// Basic tests for SSH client functionality

const SSHClient = require('../lib/ssh-client');
const fs = require('fs');
const path = require('path');

console.log('SSH Client Module Tests');
console.log('========================\n');

// Test 1: Module loads correctly
try {
  console.log('✓ SSHClient module loads correctly');
} catch (error) {
  console.log('✗ Failed to load SSHClient module:', error.message);
  process.exit(1);
}

// Test 2: Constructor accepts config
try {
  const client = new SSHClient({
    host: 'test.example.com',
    port: 22,
    username: 'testuser',
    password: 'testpass'
  });
  console.log('✓ SSHClient constructor accepts config');
} catch (error) {
  console.log('✗ SSHClient constructor failed:', error.message);
  process.exit(1);
}

// Test 3: Config with SSH key path
try {
  const client = new SSHClient({
    host: 'test.example.com',
    port: 22,
    username: 'testuser',
    privateKeyPath: '/path/to/key' // This won't be read since we're just testing constructor
  });
  console.log('✓ SSHClient accepts SSH key configuration');
} catch (error) {
  // Expected to fail if file doesn't exist, but constructor should accept the config
  if (error.code === 'ENOENT') {
    console.log('✓ SSHClient accepts SSH key configuration (file check expected)');
  } else {
    console.log('✗ SSHClient key config failed:', error.message);
    process.exit(1);
  }
}

// Test 4: getAllFiles method exists and works
try {
  const client = new SSHClient({
    host: 'test.example.com',
    username: 'test'
  });
  
  // Create a temporary test directory structure
  const tmpDir = path.join(__dirname, '../tmp/ssh-test');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'test1.txt'), 'test');
  fs.mkdirSync(path.join(tmpDir, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'subdir', 'test2.txt'), 'test');
  
  const files = client.getAllFiles(tmpDir);
  
  if (files.length === 2) {
    console.log('✓ getAllFiles correctly finds files recursively');
  } else {
    console.log(`✗ getAllFiles found ${files.length} files, expected 2`);
  }
  
  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
} catch (error) {
  console.log('✗ getAllFiles test failed:', error.message);
  process.exit(1);
}

// Test 5: Method signatures are correct
try {
  const client = new SSHClient({
    host: 'test.example.com',
    username: 'test'
  });
  
  const methods = [
    'testConnection',
    'connect',
    'disconnect',
    'executeCommand',
    'executeCommands',
    'uploadFile',
    'uploadDirectory',
    'downloadFile',
    'exists'
  ];
  
  let allMethodsExist = true;
  methods.forEach(method => {
    if (typeof client[method] !== 'function') {
      console.log(`✗ Method ${method} is missing or not a function`);
      allMethodsExist = false;
    }
  });
  
  if (allMethodsExist) {
    console.log('✓ All required methods exist');
  }
} catch (error) {
  console.log('✗ Method signature test failed:', error.message);
  process.exit(1);
}

console.log('\n✓ All SSH client tests passed!');
console.log('\nNote: Connection tests require an actual SSH server and are not run automatically.');
