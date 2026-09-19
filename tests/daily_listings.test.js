'use strict';

const assert = require('assert');
const daily = require('../lib/daily_listings');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (error) { console.error(`✗ ${name}\n  ${error.message}`); failed += 1; }
}

console.log('Daily Listings Pipeline Tests\n=============================\n');

test('builds consecutive London date keys', () => {
  assert.deepStrictEqual(daily.londonDateKeys(new Date('2026-08-30T10:00:00Z'), 3), ['2026-08-30', '2026-08-31', '2026-09-01']);
});

test('keeps fixtures on the current London date only', () => {
  const now = new Date('2026-08-30T07:00:00Z'); // 08:00 BST
  assert.strictEqual(daily.isCurrentLondonFixture({ start: '2026-08-30T18:00:00Z' }, now), true);
  assert.strictEqual(daily.isCurrentLondonFixture({ start: '2026-08-30T23:30:00Z' }, now), false);
});

test('keeps a recently started fixture but rejects older matches', () => {
  const now = new Date('2026-08-30T18:00:00Z');
  assert.strictEqual(daily.isCurrentLondonFixture({ start: '2026-08-30T17:00:00Z' }, now), true);
  assert.strictEqual(daily.isCurrentLondonFixture({ start: '2026-08-30T14:00:00Z' }, now), false);
});

test('requests dated feeds daily and whole-guide feeds once', () => {
  const requests = daily.buildRequests(daily.DEFAULT_SOURCES, ['2026-08-30', '2026-08-31'], 200);
  assert.strictEqual(requests.length, 6);
  assert.deepStrictEqual(requests.filter((request) => request.source === 'liveonsat').map((request) => request.date), ['2026-08-30', '2026-08-31']);
  assert.deepStrictEqual(requests.filter((request) => request.source === 'lstv').map((request) => request.date), ['2026-08-30', '2026-08-31']);
  assert.strictEqual(requests.filter((request) => request.source === 'skysports').length, 1);
  assert.strictEqual(requests.filter((request) => request.source === 'premiersports').length, 1);
  assert(requests.every((request) => request.payload.maxEvents === 200));
});

test('default production feed contains only retained VPS sources', () => {
  assert.deepStrictEqual(daily.DEFAULT_SOURCES, ['liveonsat', 'lstv', 'skysports', 'premiersports']);
  assert.deepStrictEqual([...daily.ACTIVE_DAILY_SOURCES], daily.DEFAULT_SOURCES);
});

process.exitCode = failed ? 1 : 0;
