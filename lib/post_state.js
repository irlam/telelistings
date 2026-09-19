'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fixtureKey } = require('./fixture_normalizer');

const STATE_PATH = path.join(__dirname, '..', 'storage', 'post-state.json');
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    state.posts = state.posts || {};
    state.deletions = Array.isArray(state.deletions) ? state.deletions : [];
    return state;
  } catch (_) {
    return { posts: {}, deletions: [] };
  }
}

function saveState(state) {
  const now = Date.now();
  state.posts = Object.fromEntries(Object.entries(state.posts || {}).filter(([, entry]) => {
    return entry && now - Number(entry.postedAt || 0) < RETENTION_MS;
  }));
  state.deletions = (state.deletions || []).filter((entry) => {
    return entry && entry.chatId && Number.isInteger(Number(entry.messageId));
  });
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tempPath = `${STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tempPath, STATE_PATH);
}

function fixtureFingerprint(fixture) {
  const channels = (fixture.tvByRegion || [])
    .map((entry) => `${entry.region}:${entry.channel}`.toLowerCase())
    .sort();
  return crypto.createHash('sha256').update(JSON.stringify({
    start: fixture.start ? new Date(fixture.start).toISOString() : null,
    competition: fixture.competition || '',
    channels,
    homeBadgeUrl: fixture.homeBadgeUrl || '',
    awayBadgeUrl: fixture.awayBadgeUrl || '',
    competitionImageUrl: fixture.competitionImageUrl || ''
  })).digest('hex').slice(0, 20);
}

function stateKey(channelId, fixture, timezone) {
  return `${channelId}|${fixtureKey(fixture, timezone)}`;
}

function shouldPostFixture(state, channelId, fixture, timezone = 'Europe/London') {
  const key = stateKey(channelId, fixture, timezone);
  const fingerprint = fixtureFingerprint(fixture);
  const previous = state.posts?.[key];
  return {
    key,
    fingerprint,
    shouldPost: !previous || previous.fingerprint !== fingerprint,
    isUpdate: Boolean(previous && previous.fingerprint !== fingerprint)
  };
}

function markFixturePosted(state, result, metadata = {}) {
  state.posts = state.posts || {};
  state.posts[result.key] = {
    fingerprint: result.fingerprint,
    postedAt: Date.now(),
    ...metadata
  };
}

function queueDeletion(state, entry) {
  const messageId = Number(entry?.messageId);
  const deleteAt = Number(entry?.deleteAt);
  if (!entry?.chatId || !Number.isInteger(messageId) || !Number.isFinite(deleteAt)) return false;
  state.deletions = state.deletions || [];
  const key = `${entry.chatId}|${messageId}`;
  const item = {
    chatId: entry.chatId,
    messageId,
    deleteAt,
    kind: entry.kind || 'message',
    label: entry.label || '',
    queuedAt: Number(entry.queuedAt) || Date.now(),
    attempts: Number(entry.attempts) || 0
  };
  const index = state.deletions.findIndex((candidate) => `${candidate.chatId}|${candidate.messageId}` === key);
  if (index >= 0) state.deletions[index] = item;
  else state.deletions.push(item);
  return true;
}

function removeDeletion(state, chatId, messageId) {
  const before = (state.deletions || []).length;
  state.deletions = (state.deletions || []).filter((entry) => {
    return !(String(entry.chatId) === String(chatId) && Number(entry.messageId) === Number(messageId));
  });
  return state.deletions.length < before;
}

function dueDeletions(state, now = Date.now()) {
  return (state.deletions || [])
    .filter((entry) => Number(entry.deleteAt) <= Number(now))
    .sort((a, b) => Number(a.deleteAt) - Number(b.deleteAt));
}

module.exports = {
  STATE_PATH,
  loadState,
  saveState,
  fixtureFingerprint,
  stateKey,
  shouldPostFixture,
  markFixturePosted,
  queueDeletion,
  removeDeletion,
  dueDeletions
};
