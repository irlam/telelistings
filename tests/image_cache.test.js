'use strict';

const assert = require('assert');
const fs = require('fs');
const imageCache = require('../lib/image_cache');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); passed += 1; }
  catch (error) { console.error(`✗ ${name}\n  ${error.message}`); failed += 1; }
}

async function main() {
  console.log('Badge Image Cache Tests\n=======================\n');

  await test('accepts TheSportsDB badge hosts and rejects obsolete hosts', async () => {
    assert(imageCache.validateImageUrl('https://r2.thesportsdb.com/images/media/team/badge/example.png'));
    assert.strictEqual(imageCache.validateImageUrl('https://api.sofascore.app/api/v1/team/123/image'), null);
  });

  await test('follows redirects only within the approved host list', async () => {
    const requested = [];
    const response = await imageCache.fetchAllowedImage('https://www.thesportsdb.com/images/badge.png', {
      request: async (url) => {
        requested.push(url);
        if (requested.length === 1) return { status: 302, headers: { location: 'https://r2.thesportsdb.com/images/badge.png' } };
        return { status: 200, headers: { 'content-type': 'image/png' }, data: Buffer.from([137, 80, 78, 71]) };
      }
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual(requested.length, 2);
  });

  await test('rejects redirects to private or unapproved hosts', async () => {
    await assert.rejects(imageCache.fetchAllowedImage('https://www.thesportsdb.com/images/badge.png', {
      request: async () => ({ status: 302, headers: { location: 'http://127.0.0.1/private.png' } })
    }), /approved host list/);
  });

  await test('caches a valid TheSportsDB image', async () => {
    const id = `${Date.now()}${process.pid}`;
    const outputPath = await imageCache.cacheRemoteImage(`https://r2.thesportsdb.com/images/media/team/badge/${id}.png`, {
      request: async () => ({ status: 200, headers: { 'content-type': 'image/png' }, data: Buffer.from([137, 80, 78, 71]) })
    });
    assert(outputPath && fs.existsSync(outputPath));
    fs.unlinkSync(outputPath);
  });

  console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  process.exitCode = failed ? 1 : 0;
}

main();
