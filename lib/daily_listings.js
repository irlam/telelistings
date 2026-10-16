'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const {
  dateKeyInZone,
  normalizeFixture,
  mergeFixtures,
  isTelevised,
  isUkRelevant
} = require('./fixture_normalizer');

const DEFAULT_SOURCES = [
  'liveonsat',
  'lstv',
  'skysports',
  'premiersports'
];

const ACTIVE_DAILY_SOURCES = new Set(DEFAULT_SOURCES);

const DATE_AWARE_SOURCES = new Set([
  'liveonsat',
  'lstv'
]);

const CACHE_DIR = path.join(__dirname, '..', 'storage', 'daily-listings');
const DEFAULT_CACHE_TTL_MS = 20 * 60 * 1000;
const DEFAULT_SOURCE_DELAY_MS = 800;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cachePathFor(value) {
  const hash = crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
  return path.join(CACHE_DIR, `${hash}.json`);
}

function readCache(filePath, ttlMs) {
  try {
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs > ttlMs) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    parsed.fixtures = (parsed.fixtures || []).map((fixture) => ({
      ...fixture,
      start: fixture.start ? new Date(fixture.start) : null
    }));
    return parsed;
  } catch (_) {
    return null;
  }
}

function writeCache(filePath, data) {
  ensureCacheDir();
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function londonDateKeys(now, daysAhead) {
  const startKey = dateKeyInZone(now, 'Europe/London');
  const midday = new Date(`${startKey}T12:00:00Z`);
  const keys = [];
  for (let index = 0; index < daysAhead; index += 1) {
    keys.push(new Date(midday.getTime() + index * 86400000).toISOString().slice(0, 10));
  }
  return keys;
}

function isCurrentLondonFixture(fixture, now = new Date()) {
  if (!fixture?.start || Number.isNaN(new Date(fixture.start).getTime())) return false;
  const start = new Date(fixture.start);
  const earliest = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  return start >= earliest && dateKeyInZone(start, 'Europe/London') === dateKeyInZone(now, 'Europe/London');
}

function buildRequests(sources, dates, maxEvents) {
  const requests = [];
  for (const source of sources) {
    const sourceDates = DATE_AWARE_SOURCES.has(source) ? dates : [dates[0]];
    for (const date of sourceDates) {
      requests.push({
        source,
        date,
        payload: {
          date,
          maxEvents
        }
      });
    }
  }
  return requests;
}

async function callSource({ baseUrl, apiKey, source, payload, timeoutMs, logger }) {
  const url = `${baseUrl.replace(/\/$/, '')}/scrape/${encodeURIComponent(source)}`;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await axios.post(url, payload, {
        timeout: timeoutMs,
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
          'user-agent': 'Telelistings/2.0 (+https://github.com/irlam/telelistings)'
        },
        maxContentLength: 10 * 1024 * 1024
      });
      const fixtures = Array.isArray(response.data?.fixtures) ? response.data.fixtures : [];
      return { source, date: payload.date, fixtures, cacheHit: Boolean(response.data?._meta?.cacheHit) };
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (attempt === 0 && (status === 429 || status >= 500)) {
        const retryAfter = Math.min(Number(error.response?.headers?.['retry-after']) || 2, 30);
        await sleep(retryAfter * 1000);
        continue;
      }
      break;
    }
  }
  logger(`[DAILY] ${source} failed: ${lastError?.message || 'unknown error'}`);
  return { source, date: payload.date, fixtures: [], error: lastError?.message || 'unknown error' };
}

async function runRequests(requests, options) {
  const results = [];
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 2, 3));
  let index = 0;

  async function worker() {
    while (index < requests.length) {
      const currentIndex = index;
      index += 1;
      const request = requests[currentIndex];
      results[currentIndex] = await callSource({ ...request, ...options });
      if (currentIndex < requests.length - 1) await sleep(options.sourceDelayMs);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function sourceOptions(config = {}, channel = {}) {
  const configured = channel.dailySources || config.dailyListings?.sources;
  const sources = Array.isArray(configured) && configured.length ? configured : DEFAULT_SOURCES;
  const active = sources
    .map((source) => String(source).trim().toLowerCase())
    .filter((source) => ACTIVE_DAILY_SOURCES.has(source));
  return [...new Set(active.length ? active : DEFAULT_SOURCES)];
}

async function getUkDailyListings(options = {}) {
  const config = options.config || {};
  const channel = options.channel || {};
  const logger = options.logger || (() => {});
  const now = options.now instanceof Date ? options.now : new Date();
  // Telelistings intentionally publishes the current UK calendar day only.
  // Do not read the old daysAhead settings: deployed config files may still
  // contain them from the retired ICS/multi-day modes.
  const dates = londonDateKeys(now, 1);
  const sources = sourceOptions(config, channel);
  const maxEvents = Math.max(20, Math.min(Number(channel.maxEventsPerSource || 250), 500));
  const requireTv = channel.requireTv !== false;
  const includeNonUk = channel.includeNonUk === true;

  const baseUrl = process.env.LSTV_SCRAPER_URL || config.envVars?.LSTV_SCRAPER_URL || '';
  const apiKey = process.env.LSTV_SCRAPER_KEY || '';
  if (!baseUrl || !apiKey) {
    throw new Error('UK daily listings require LSTV_SCRAPER_URL and LSTV_SCRAPER_KEY environment variables');
  }

  const cacheTtlMs = Math.max(
    5 * 60 * 1000,
    Number(config.dailyListings?.cacheMinutes || 20) * 60 * 1000
  );
  // Bump the cache schema when normalisation rules change so stale, already
  // normalised channel text is never reused after a deployment.
  const cacheIdentity = JSON.stringify({ schemaVersion: 9, dates, sources, maxEvents, requireTv, includeNonUk });
  const cachePath = cachePathFor(cacheIdentity);
  const cached = readCache(cachePath, cacheTtlMs);
  if (cached) {
    logger(`[DAILY] Using cached UK listings (${cached.fixtures.length} fixtures)`);
    return { ...cached, cacheHit: true };
  }

  const requests = buildRequests(sources, dates, maxEvents);
  logger(`[DAILY] Collecting ${requests.length} schedule feeds for ${dates.join(', ')}`);
  const results = await runRequests(requests, {
    baseUrl,
    apiKey,
    logger,
    concurrency: config.dailyListings?.concurrency || 2,
    sourceDelayMs: Math.max(
      DEFAULT_SOURCE_DELAY_MS,
      Number(config.dailyListings?.sourceDelayMs || DEFAULT_SOURCE_DELAY_MS)
    ),
    timeoutMs: Math.max(30000, Number(config.dailyListings?.timeoutMs || 90000))
  });

  const normalized = [];
  for (const result of results) {
    for (const rawFixture of result.fixtures) {
      const fixture = normalizeFixture(rawFixture, result.source, result.date, {
        timezone: config.timezone || 'Europe/London'
      });
      if (fixture) normalized.push(fixture);
    }
  }

  let fixtures = mergeFixtures(normalized, config.timezone || 'Europe/London');
  fixtures = fixtures.filter((fixture) => includeNonUk || isUkRelevant(fixture, []));
  if (requireTv) fixtures = fixtures.filter(isTelevised);

  fixtures = fixtures.filter((fixture) => isCurrentLondonFixture(fixture, now));

  const sourceStatus = {};
  for (const result of results) {
    const current = sourceStatus[result.source] || { ok: true, fixtures: 0, requests: 0, errors: [] };
    current.requests += 1;
    current.fixtures += result.fixtures.length;
    if (result.error) {
      current.ok = false;
      current.errors.push(result.error);
    }
    sourceStatus[result.source] = current;
  }
  const data = { fixtures, dates, sources, sourceStatus, generatedAt: new Date().toISOString() };
  writeCache(cachePath, data);
  logger(`[DAILY] Merged ${normalized.length} source rows into ${fixtures.length} UK TV fixtures`);
  return { ...data, cacheHit: false };
}

module.exports = {
  DEFAULT_SOURCES,
  ACTIVE_DAILY_SOURCES,
  DATE_AWARE_SOURCES,
  londonDateKeys,
  isCurrentLondonFixture,
  buildRequests,
  getUkDailyListings
};

