'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const CACHE_DIR = path.join(__dirname, '..', 'storage', 'images');
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_IMAGE_REDIRECTS = 3;
const ALLOWED_IMAGE_HOSTS = new Set([
  'upload.wikimedia.org',
  'www.thesportsdb.com',
  'r2.thesportsdb.com',
  'images.thesportsdb.com'
]);

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function validateImageUrl(value) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function imageUrlCandidates(value) {
  const initial = validateImageUrl(value);
  if (!initial) return [];
  const candidates = [initial];
  return candidates;
}

function resolveImageRedirect(currentUrl, location) {
  if (!location) return null;
  try {
    return validateImageUrl(new URL(location, currentUrl).toString());
  } catch (_) {
    return null;
  }
}

async function fetchAllowedImage(initialUrl, options = {}) {
  const request = options.request || axios.get;
  let currentUrl = initialUrl;

  for (let redirects = 0; redirects <= MAX_IMAGE_REDIRECTS; redirects += 1) {
    const response = await request(currentUrl, {
      responseType: 'arraybuffer',
      timeout: options.timeoutMs || 12000,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
      maxContentLength: MAX_IMAGE_BYTES,
      maxBodyLength: MAX_IMAGE_BYTES,
      headers: {
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
        'user-agent': 'Telelistings/2.0 (+https://github.com/irlam/telelistings)'
      }
    });
    const status = Number(response.status || 200);

    if (status >= 300 && status < 400) {
      if (redirects >= MAX_IMAGE_REDIRECTS) throw new Error('too many image redirects');
      const nextUrl = resolveImageRedirect(currentUrl, response.headers?.location);
      if (!nextUrl) throw new Error('image redirect left the approved host list');
      currentUrl = nextUrl;
      continue;
    }
    if (status < 200 || status >= 300) throw new Error(`image request returned HTTP ${status}`);
    return response;
  }

  throw new Error('image redirect limit reached');
}

function extensionFor(contentType) {
  if (/png/i.test(contentType)) return 'png';
  if (/webp/i.test(contentType)) return 'webp';
  if (/gif/i.test(contentType)) return 'gif';
  return 'jpg';
}

function findCached(hash) {
  if (!fs.existsSync(CACHE_DIR)) return null;
  const found = fs.readdirSync(CACHE_DIR).find((name) => name.startsWith(`${hash}.`));
  if (!found) return null;
  const filePath = path.join(CACHE_DIR, found);
  try {
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs <= CACHE_TTL_MS) return filePath;
  } catch (_) {
    return null;
  }
  return null;
}

async function cacheRemoteImage(value, options = {}) {
  const candidates = imageUrlCandidates(value);
  if (!candidates.length) return null;
  const url = candidates[0];
  ensureCacheDir();
  const hash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);
  const cached = findCached(hash);
  if (cached) return cached;

  const errors = [];
  for (const candidate of candidates) {
    try {
      const response = await fetchAllowedImage(candidate, options);
      const contentType = String(response.headers['content-type'] || '');
      const data = Buffer.from(response.data);
      if (!contentType.toLowerCase().startsWith('image/') || !data.length || data.length > MAX_IMAGE_BYTES) {
        throw new Error('response was not a valid image');
      }

      const outputPath = path.join(CACHE_DIR, `${hash}.${extensionFor(contentType)}`);
      fs.writeFileSync(outputPath, data);
      return outputPath;
    } catch (error) {
      errors.push(`${new URL(candidate).hostname}: ${error.message}`);
    }
  }

  if (typeof options.logger === 'function') {
    options.logger(`[IMAGE] Badge/logo download failed (${errors.join('; ')})`);
  }
  return null;
}

async function resolveFixtureImages(fixture, options = {}) {
  const [homeBadgePath, awayBadgePath, competitionImagePath] = await Promise.all([
    cacheRemoteImage(fixture.homeBadgeUrl, options),
    cacheRemoteImage(fixture.awayBadgeUrl, options),
    cacheRemoteImage(fixture.competitionImageUrl, options)
  ]);
  return { homeBadgePath, awayBadgePath, competitionImagePath };
}

module.exports = {
  ALLOWED_IMAGE_HOSTS,
  validateImageUrl,
  imageUrlCandidates,
  resolveImageRedirect,
  fetchAllowedImage,
  cacheRemoteImage,
  resolveFixtureImages
};
