'use strict';

const assert = require('assert');
const autopost = require('../autopost');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); }
  catch (error) { console.error(`✗ ${name}\n  ${error.message}`); failed += 1; }
}

console.log('Telegram Poster Format Tests\n============================\n');

test('poster subtitle retains the existing default', () => {
  assert.strictEqual(autopost.DEFAULT_POSTER_SUBTITLE, 'FREE • UK TIMES • UPDATED DAILY');
});

const fixture = autopost.adaptFixtureForPoster({
  homeTeam: 'Manchester City',
  awayTeam: 'Liverpool',
  summary: 'Manchester City v Liverpool',
  start: new Date('2026-08-30T15:30:00Z'),
  competition: 'Premier League',
  tvByRegion: [
    { region: 'USA', channel: 'Peacock' },
    { region: 'UK', channel: 'Sky Sports Main Event' }
  ],
  confidenceLabel: 'Confirmed by 3 sources'
});

test('full date including year is included', () => {
  assert.strictEqual(fixture.dateUk, 'Sunday 30 August 2026');
  const text = autopost.formatFixturePoster(fixture);
  assert(text.includes('Sunday 30 August 2026'));
  assert(text.includes('4:30pm UK'));
  assert(!text.includes(' ET'));
});

test('photo caption contains date, UK time and channel', () => {
  const caption = autopost.buildPhotoCaption(fixture);
  assert(caption.includes('📅 Sunday 30 August 2026'));
  assert(caption.includes('4:30pm UK kick-off'));
  assert(caption.includes('UK: Sky Sports Main Event'));
  assert(caption.includes('📡 UK: Sky Sports Main Event'));
  assert(!caption.includes('Confirmed by'));
  assert(caption.length <= 1024);
});

test('daily digest puts UK channel first', () => {
  const messages = autopost.buildUkDailyDigest([fixture], {}, { timezone: 'Europe/London' });
  assert.strictEqual(messages.length, 1);
  assert(messages[0].includes('SUNDAY 30 AUGUST 2026'));
  assert(messages[0].includes('Sky Sports Main Event'));
  assert(messages[0].includes('📡 Sky Sports Main Event'));
  assert(!messages[0].includes('Confirmed by'));
});

test('channel output can independently select list, cards or both', () => {
  assert.deepStrictEqual(autopost.channelOutputSettings({}), {
    postDailyDigest: true,
    postFixtureCards: true
  });
  assert.deepStrictEqual(autopost.channelOutputSettings({ postDailyDigest: false, posterStyle: true }), {
    postDailyDigest: false,
    postFixtureCards: true
  });
  assert.deepStrictEqual(autopost.channelOutputSettings({ postDailyDigest: true, posterStyle: false }), {
    postDailyDigest: true,
    postFixtureCards: false
  });
});

test('long Telegram messages are safely split', () => {
  const chunks = autopost.splitTelegramText(Array.from({ length: 300 }, (_, i) => `Fixture line ${i}`).join('\n'), 500);
  assert(chunks.length > 1);
  assert(chunks.every((chunk) => chunk.length <= 500));
});

test('Telegram retry delay honours API retry_after', () => {
  const delay = autopost.telegramRetryDelayMs({
    response: { status: 429, data: { parameters: { retry_after: 12 } }, headers: {} }
  });
  assert.strictEqual(delay, 12500);
});

test('Telegram API errors retain the response description', () => {
  const message = autopost.telegramApiErrorMessage('sendPhoto', {
    message: 'Request failed with status code 400',
    response: {
      status: 400,
      data: { ok: false, error_code: 400, description: 'Bad Request: chat not found' }
    }
  });
  assert.strictEqual(message, 'Telegram sendPhoto failed (400): Bad Request: chat not found');
});

test('poster pacing defaults below Telegram group limits', () => {
  assert.strictEqual(autopost.telegramChatDelayMs({}, {}), 3200);
  assert.strictEqual(autopost.telegramChatDelayMs({}, { telegramPostDelayMs: 100 }), 1100);
});

test('message expiry defaults to three hours after kick-off', () => {
  const settings = autopost.messageExpirySettings({});
  const sentAt = new Date('2026-09-01T10:00:00Z').getTime();
  const deleteAt = autopost.fixtureDeletionTimestamp({ start: '2026-09-01T15:00:00Z' }, settings, sentAt);
  assert.strictEqual(new Date(deleteAt).toISOString(), '2026-09-01T18:00:00.000Z');
});

test('message expiry stays within Telegram deletion window', () => {
  const settings = autopost.messageExpirySettings({});
  const sentAt = new Date('2026-09-01T10:00:00Z').getTime();
  const deleteAt = autopost.fixtureDeletionTimestamp({ start: '2026-09-05T15:00:00Z' }, settings, sentAt);
  assert.strictEqual(deleteAt, sentAt + 47 * 60 * 60 * 1000);
});

test('daily digest expires at six the following UK morning', () => {
  const settings = autopost.messageExpirySettings({});
  const sentAt = new Date('2026-09-01T10:00:00Z').getTime();
  const deleteAt = autopost.digestDeletionTimestamp(['2026-09-01', '2026-09-02'], settings, 'Europe/London', sentAt);
  assert.strictEqual(new Date(deleteAt).toISOString(), '2026-09-02T05:00:00.000Z');
});

process.exitCode = failed ? 1 : 0;

