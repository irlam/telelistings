'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFeed, MAX_POSTS } = require('../lib/malri_feed');

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(process.env.MALRI_TEST_TMP || os.tmpdir(), 'malri-feed-test-'));
  t.after(() => {
    assert.ok(path.basename(directory).startsWith('malri-feed-test-'));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(process.env.MALRI_TEST_TMP || os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { feed: createFeed(directory), directory };
}
const now = Date.UTC(2026, 9, 31, 12);
const channel = { id: '-10012345', label: 'UK Football', malriFeed: true, botToken: 'DO-NOT-EXPOSE' };
function post(extra = {}) {
  return { channel, messageId: 100, title: 'Bolton v Reading', caption: '<b>Bolton v Reading</b>',
    fixture: { homeTeam: 'Bolton', awayTeam: 'Reading', start: '2026-10-31T15:00:00Z',
      tvByRegion: [{ region: 'UK', channel: 'Sky Sports+' }], credentials: 'DO-NOT-EXPOSE' },
    expiresAt: now + 3600000, ...extra };
}
test('only opted-in successful posts enter the feed; secrets and internal IDs stay private', t => {
  const { feed } = sandbox(t);
  assert.equal(feed.save(post({ channel: { ...channel, malriFeed: false } }), now), null);
  assert.throws(() => feed.save(post({ messageId: null }), now), /successfully published/);
  feed.save(post(), now);
  const result = feed.list(now);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].caption, '<b>Bolton v Reading</b>');
  assert.equal(result.posts[0].channels[0].channel, 'Sky Sports+');
  const output = JSON.stringify(result);
  for (const secret of ['DO-NOT-EXPOSE', channel.id, 'messageId', 'channelKey', 'credentials', 'botToken']) {
    assert.equal(output.includes(secret), false, secret);
  }
  assert.equal(feed.list(now, new Set()).posts.length, 0, 'Opt-out hides existing archived posts');
});
test('archive survives source-image cleanup; expired or disabled images cannot be read', t => {
  const { feed, directory } = sandbox(t);
  const imagePath = path.join(directory, 'generated.png');
  fs.writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
  const saved = feed.save(post({ imagePath }), now);
  fs.unlinkSync(imagePath);
  assert.ok(feed.image(saved.id, now));
  assert.equal(feed.image(saved.id, now + 3600001), null);
  assert.equal(feed.image(saved.id, now, new Set()), null);
  assert.equal(feed.image('../posts.json', now), null);
  assert.equal(feed.list(now + 3600001).posts.length, 0);
});
test('updated listings preserve the actual published caption and text fallback has no poster', t => {
  const { feed } = sandbox(t);
  feed.save(post(), now);
  feed.save(post({ messageId: 101, updated: true, caption: 'LISTING UPDATED: 16:00', imagePath: null }), now + 10);
  const result = feed.list(now + 20);
  assert.equal(result.posts[0].updated, true);
  assert.equal(result.posts[0].caption, 'LISTING UPDATED: 16:00');
  assert.equal(result.posts[0].image, null);
  assert.equal(result.posts.length, 2);
});
test('the archive is bounded, duplicate message IDs are idempotent, corrupt indexes are not overwritten', t => {
  const { feed, directory } = sandbox(t);
  for (let i = 1; i <= MAX_POSTS + 2; i++) feed.save(post({ messageId: i }), now + i);
  assert.equal(feed.list(now + 1000).posts.length, MAX_POSTS);
  feed.save(post({ messageId: MAX_POSTS + 2 }), now + 1001);
  assert.equal(feed.list(now + 1002).posts.length, MAX_POSTS);
  const index = path.join(directory, 'posts.json');
  fs.writeFileSync(index, '{broken');
  assert.throws(() => feed.save(post(), now));
  assert.equal(fs.readFileSync(index, 'utf8'), '{broken');
});
