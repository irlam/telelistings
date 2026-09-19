'use strict';

const assert = require('assert');
const postState = require('../lib/post_state');

const baseFixture = {
  homeTeam: 'Sutton United',
  awayTeam: 'Wealdstone',
  start: new Date('2026-08-31T15:00:00Z'),
  competition: 'National League',
  tvByRegion: [{ region: 'UK', channel: 'DAZN UK' }]
};

const withoutBadges = postState.fixtureFingerprint(baseFixture);
const withBadges = postState.fixtureFingerprint({
  ...baseFixture,
  homeBadgeUrl: 'https://r2.thesportsdb.com/images/media/team/badge/home.png',
  awayBadgeUrl: 'https://r2.thesportsdb.com/images/media/team/badge/away.png'
});

assert.notStrictEqual(withoutBadges, withBadges);
console.log('✓ newly available badges trigger a corrected poster update');

const state = { posts: {}, deletions: [] };
assert.strictEqual(postState.queueDeletion(state, {
  chatId: '@FootballOnTvUK', messageId: 123, deleteAt: 1000, kind: 'fixture poster'
}), true);
assert.strictEqual(postState.queueDeletion(state, {
  chatId: '@FootballOnTvUK', messageId: 123, deleteAt: 2000, kind: 'fixture poster'
}), true);
assert.strictEqual(state.deletions.length, 1);
assert.strictEqual(postState.dueDeletions(state, 1999).length, 0);
assert.strictEqual(postState.dueDeletions(state, 2000).length, 1);
assert.strictEqual(postState.removeDeletion(state, '@FootballOnTvUK', 123), true);
assert.strictEqual(state.deletions.length, 0);
console.log('✓ Telegram deletion queue is idempotent and returns due messages');
