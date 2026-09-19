// autopost.js
// UK-first football TV autoposter.
/**
 * Telegram Sports TV Bot – Autoposter
 *
 * UK Daily mode collects cached schedules from the VPS, merges independent
 * sources, sends a full daily digest and creates branded fixture posters.
 * Runtime configuration is local and post state is file-backed; no database or
 * paid API is required.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const theSportsDb = require('./thesportsdb');
const liveSoccerTv = require('./livesoccertv');
const lstv = require('./scrapers/lstv');
const tsdb = require('./scrapers/thesportsdb');
const wiki = require('./scrapers/wiki_broadcasters');
const { getUkDailyListings } = require('./lib/daily_listings');
const { resolveFixtureImages } = require('./lib/image_cache');
const {
  dateKeyInZone,
  localDateTimeToUtc,
  sortTvRegions
} = require('./lib/fixture_normalizer');
const postState = require('./lib/post_state');

// Import the universal aggregator
let tvAggregator = null;
try {
  tvAggregator = require('./aggregators/tv_channels');
} catch (err) {
  // Aggregator not available - will use legacy enrichment
}

// Try to load canvas - optional dependency for image generation
let canvas = null;
try {
  canvas = require('@napi-rs/canvas');
} catch (err) {
  // Canvas not available - will fall back to text posters
}

const CONFIG_PATH = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, 'autopost.log');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const TMP_DIR = path.join(__dirname, 'tmp');

// ---------- Image poster constants ----------
const MAX_DISPLAYED_TV_REGIONS = 10;
const POSTER_OVERLAY_OPACITY = 0.88; // Semi-transparent overlay to show background while ensuring readability
const MIN_FONT_SIZE = 10; // Absolute minimum font size in pixels (ensures text remains readable)
const TEXT_PADDING_PERCENT = 0.1; // 10% padding on each side (total 20% of canvas width reserved for margins)
const DEFAULT_POSTER_WIDTH = 1080;
const DEFAULT_POSTER_HEIGHT = 1350;
const DEFAULT_POSTER_SUBTITLE = 'FREE • UK TIMES • UPDATED DAILY';
const TELEGRAM_MESSAGE_LIMIT = 3900;
const DEFAULT_TELEGRAM_CHAT_DELAY_MS = 3200;
const TELEGRAM_MAX_ATTEMPTS = 3;
const TELEGRAM_DELETE_LIMIT_MS = 48 * 60 * 60 * 1000;
const TELEGRAM_SAFE_DELETE_LIMIT_MS = 47 * 60 * 60 * 1000;
const MINIMUM_MESSAGE_LIFETIME_MS = 5 * 60 * 1000;
const TEAM_ARTWORK_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
const TEAM_ARTWORK_MISS_TTL_MS = 5 * 60 * 1000;
const teamArtworkCache = new Map();

async function resolveMissingTeamBadges(fixture) {
  async function badgeFor(teamName) {
    const key = String(teamName || '').trim().toLowerCase();
    if (!key) return null;
    const now = Date.now();
    const cached = teamArtworkCache.get(key);
    if (cached && cached.expiresAt > now) return cached.promise;

    const entry = {
      expiresAt: now + TEAM_ARTWORK_MISS_TTL_MS,
      promise: tsdb.fetchTeamArtwork(teamName)
        .then((result) => result.badgeUrl || null)
        .catch(() => null)
    };
    teamArtworkCache.set(key, entry);
    entry.promise.then((badgeUrl) => {
      if (teamArtworkCache.get(key) === entry) {
        entry.expiresAt = Date.now() + (badgeUrl ? TEAM_ARTWORK_SUCCESS_TTL_MS : TEAM_ARTWORK_MISS_TTL_MS);
      }
    });
    return entry.promise;
  }

  const [homeBadgeUrl, awayBadgeUrl] = await Promise.all([
    fixture.homeBadgeUrl || badgeFor(fixture.homeTeam),
    fixture.awayBadgeUrl || badgeFor(fixture.awayTeam)
  ]);
  return { ...fixture, homeBadgeUrl, awayBadgeUrl };
}

async function resolveFixtureBadges(fixtures, options = {}) {
  const input = Array.isArray(fixtures) ? fixtures : [];
  const output = new Array(input.length);
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 4, 8));
  let index = 0;

  async function worker() {
    while (index < input.length) {
      const currentIndex = index;
      index += 1;
      output[currentIndex] = await resolveMissingTeamBadges(input[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, () => worker()));
  const missing = new Set();
  for (const fixture of output) {
    if (!fixture?.homeBadgeUrl && fixture?.homeTeam) missing.add(fixture.homeTeam);
    if (!fixture?.awayBadgeUrl && fixture?.awayTeam) missing.add(fixture.awayTeam);
  }
  if (missing.size && typeof options.logger === 'function') {
    options.logger(`[IMAGE] No badge found for: ${[...missing].join(', ')}`);
  }
  return output;
}

// ---------- Team parsing patterns ----------
// Regex patterns for parsing "Home v Away" from fixture summaries
// Each pattern captures home team (group 1) and away team (group 2)
// Patterns are ordered by specificity (most specific first)
const TEAM_SEPARATOR_PATTERNS = [
  { name: 'vs_dot', pattern: /^(.+?)\s*vs\.\s*(.+)$/i },       // "vs." with optional spaces around dot
  { name: 'vs_spaced', pattern: /^(.+?)\s+vs\s+(.+)$/i },      // "vs" with required spaces
  { name: 'v_spaced', pattern: /^(.+?)\s+v\s+(.+)$/i },        // "v" with required spaces
  { name: 'hyphen_left', pattern: /^(.+?)\s+-\s*(.+)$/ },      // hyphen with space on left
  { name: 'hyphen_right', pattern: /^(.+?)\s*-\s+(.+)$/ },     // hyphen with space on right
  { name: 'at_left', pattern: /^(.+?)\s+@\s*(.+)$/ },          // @ with space on left
  { name: 'at_right', pattern: /^(.+?)\s*@\s+(.+)$/ }          // @ with space on right
];

// ---------- logging helpers ----------

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    now.getFullYear() +
    '-' +
    pad(now.getMonth() + 1) +
    '-' +
    pad(now.getDate()) +
    ' ' +
    pad(now.getHours()) +
    ':' +
    pad(now.getMinutes()) +
    ':' +
    pad(now.getSeconds())
  );
}

function logLine(msg) {
  const line = `[${timestamp()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (_) {
    // ignore file errors
  }
  console.log(line.trim());
}

// ---------- config helpers ----------

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`config.json not found at ${CONFIG_PATH}. Copy config.example.json and configure the channel first.`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

// ---------- Telegram helper ----------

function telegramRetryDelayMs(error, attempt = 0) {
  const status = error?.response?.status;
  if (status !== 429 && !(status >= 500 && status <= 599)) return 0;
  const retryAfter = Number(
    error?.response?.data?.parameters?.retry_after ||
    error?.response?.headers?.['retry-after']
  );
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter, 90) * 1000 + 500;
  }
  return Math.min(2000 * (2 ** attempt), 15000);
}

function telegramChatDelayMs(cfg, channel) {
  const configured = Number(channel?.telegramPostDelayMs ?? cfg?.telegramPostDelayMs);
  if (!Number.isFinite(configured)) return DEFAULT_TELEGRAM_CHAT_DELAY_MS;
  return Math.max(1100, Math.min(configured, 10000));
}

function telegramApiErrorMessage(method, error) {
  const status = error?.response?.status;
  const responseData = error?.response?.data;
  const description = responseData?.description ||
    (typeof responseData === 'string' ? responseData : '') ||
    error?.message ||
    'unknown error';
  return `Telegram ${method} failed${status ? ` (${status})` : ''}: ${description}`;
}

function wrapTelegramApiError(method, error) {
  const wrapped = new Error(telegramApiErrorMessage(method, error));
  wrapped.cause = error;
  wrapped.response = error?.response;
  wrapped.code = error?.code;
  return wrapped;
}

async function sendTelegramMessage(botToken, channelId, text) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(
    botToken
  )}/sendMessage`;

  const payload = {
    chat_id: channelId,
    text: text
    // plain text – no Markdown to avoid escaping headaches
  };

  let lastError;
  for (let attempt = 0; attempt < TELEGRAM_MAX_ATTEMPTS; attempt += 1) {
    try {
      const resp = await axios.post(url, payload, { timeout: 15000 });
      if (!resp.data || !resp.data.ok) {
        throw new Error(`Telegram sendMessage failed: ${resp.data?.description || 'unknown error'}`);
      }
      return resp.data.result;
    } catch (error) {
      lastError = error;
      const delayMs = telegramRetryDelayMs(error, attempt);
      if (!delayMs || attempt === TELEGRAM_MAX_ATTEMPTS - 1) break;
      logLine(`Telegram sendMessage rate-limited; retrying in ${Math.ceil(delayMs / 1000)}s`);
      await sleep(delayMs);
    }
  }
  throw wrapTelegramApiError('sendMessage', lastError);
}

/**
 * Send a photo to Telegram with optional caption.
 * @param {string} botToken - Telegram bot token
 * @param {string} channelId - Telegram channel ID
 * @param {string} photoPath - Path to the image file
 * @param {string} caption - Optional caption text
 */
async function sendTelegramPhoto(botToken, channelId, photoPath, caption = '') {
  const url = `https://api.telegram.org/bot${encodeURIComponent(
    botToken
  )}/sendPhoto`;

  let lastError;
  for (let attempt = 0; attempt < TELEGRAM_MAX_ATTEMPTS; attempt += 1) {
    const photoStat = fs.statSync(photoPath);
    if (!photoStat.isFile() || photoStat.size <= 0) {
      throw new Error('Telegram sendPhoto failed: generated poster file is empty');
    }
    if (photoStat.size > 10 * 1024 * 1024) {
      throw new Error(`Telegram sendPhoto failed: generated poster is ${(photoStat.size / 1024 / 1024).toFixed(1)} MB (10 MB maximum)`);
    }

    const form = new FormData();
    form.append('chat_id', channelId);
    form.append('photo', fs.createReadStream(photoPath), {
      filename: path.basename(photoPath),
      contentType: 'image/png',
      knownLength: photoStat.size
    });
    if (caption) form.append('caption', caption);

    try {
      const resp = await axios.post(url, form, {
        timeout: 30000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        headers: {
          ...form.getHeaders(),
          'Content-Length': form.getLengthSync()
        }
      });
      if (!resp.data || !resp.data.ok) {
        throw new Error(`Telegram sendPhoto failed: ${resp.data?.description || 'unknown error'}`);
      }
      return resp.data.result;
    } catch (error) {
      lastError = error;
      const delayMs = telegramRetryDelayMs(error, attempt);
      if (!delayMs || attempt === TELEGRAM_MAX_ATTEMPTS - 1) break;
      logLine(`Telegram sendPhoto rate-limited; retrying in ${Math.ceil(delayMs / 1000)}s`);
      await sleep(delayMs);
    }
  }
  throw wrapTelegramApiError('sendPhoto', lastError);
}

function messageExpirySettings(cfg = {}) {
  const configured = cfg.messageExpiry || {};
  return {
    enabled: configured.enabled !== false,
    posterHoursAfterKickoff: Math.max(0, Math.min(Number(configured.posterHoursAfterKickoff ?? 3), 24)),
    digestExpiryHour: Math.max(0, Math.min(Number(configured.digestExpiryHour ?? 6), 23))
  };
}

function clampTelegramDeletionTime(desiredAt, sentAt = Date.now()) {
  const earliest = sentAt + MINIMUM_MESSAGE_LIFETIME_MS;
  const latest = sentAt + TELEGRAM_SAFE_DELETE_LIMIT_MS;
  return Math.min(Math.max(Number(desiredAt) || earliest, earliest), latest);
}

function fixtureDeletionTimestamp(fixture, settings, sentAt = Date.now()) {
  const kickoff = fixture?.start ? new Date(fixture.start).getTime() : NaN;
  const desired = Number.isFinite(kickoff)
    ? kickoff + settings.posterHoursAfterKickoff * 60 * 60 * 1000
    : sentAt + settings.posterHoursAfterKickoff * 60 * 60 * 1000;
  return clampTelegramDeletionTime(desired, sentAt);
}

function digestDeletionTimestamp(dates, settings, timezone = 'Europe/London', sentAt = Date.now()) {
  const firstDate = Array.isArray(dates) && /^\d{4}-\d{2}-\d{2}$/.test(dates[0] || '')
    ? dates[0]
    : dateKeyInZone(new Date(sentAt), timezone);
  const midday = new Date(`${firstDate}T12:00:00Z`);
  const nextDate = new Date(midday.getTime() + 86400000).toISOString().slice(0, 10);
  const hour = String(settings.digestExpiryHour).padStart(2, '0');
  const desired = localDateTimeToUtc(nextDate, `${hour}:00`, timezone)?.getTime();
  return clampTelegramDeletionTime(desired, sentAt);
}

async function deleteTelegramMessage(botToken, chatId, messageId) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(botToken)}/deleteMessage`;
  const response = await axios.post(url, { chat_id: chatId, message_id: messageId }, { timeout: 15000 });
  if (!response.data?.ok) {
    throw new Error(`Telegram deleteMessage failed: ${response.data?.description || 'unknown error'}`);
  }
  return true;
}

async function runMessageCleanup(options = {}) {
  const cfg = options.cfg || loadConfig();
  const settings = messageExpirySettings(cfg);
  if (!settings.enabled) return { deleted: 0, pending: 0 };
  const botToken = options.botToken || process.env.TELEGRAM_BOT_TOKEN || cfg.botToken;
  if (!botToken) return { deleted: 0, pending: 0 };

  const state = options.state || postState.loadState();
  const now = Number(options.now) || Date.now();
  const due = postState.dueDeletions(state, now);
  let deleted = 0;

  for (const entry of due) {
    try {
      await deleteTelegramMessage(botToken, entry.chatId, entry.messageId);
      postState.removeDeletion(state, entry.chatId, entry.messageId);
      deleted += 1;
      logLine(`[CLEANUP] Deleted expired ${entry.kind} ${entry.messageId}${entry.label ? ` (${entry.label})` : ''}`);
    } catch (error) {
      const status = error.response?.status;
      const description = String(error.response?.data?.description || error.message || error);
      const terminal = status === 400 || now - Number(entry.queuedAt || now) >= TELEGRAM_DELETE_LIMIT_MS;
      if (terminal) {
        postState.removeDeletion(state, entry.chatId, entry.messageId);
        logLine(`[CLEANUP] Dropped undeletable message ${entry.messageId}: ${description}`);
      } else {
        entry.attempts = Number(entry.attempts || 0) + 1;
        entry.deleteAt = now + Math.min(5 * 60 * 1000 * entry.attempts, 30 * 60 * 1000);
        entry.lastError = description.slice(0, 300);
        logLine(`[CLEANUP] Will retry message ${entry.messageId}: ${description}`);
      }
    }
  }

  postState.saveState(state);
  return { deleted, pending: (state.deletions || []).length };
}

// ---------- Background Image helpers ----------

/**
 * Get the path to the uploaded background image, if it exists.
 * Checks for poster-background.{jpg,jpeg,png,gif} in the uploads directory.
 * @returns {string|null} Path to background image, or null if not found
 */
function getBackgroundImagePath() {
  const extensions = ['jpg', 'jpeg', 'png', 'gif'];
  for (const ext of extensions) {
    const imgPath = path.join(UPLOADS_DIR, `poster-background.${ext}`);
    if (fs.existsSync(imgPath)) {
      return imgPath;
    }
  }
  return null;
}

/**
 * Ensure the tmp directory exists for temporary files.
 */
function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
}

/**
 * Calculate the font size needed to fit text within a maximum width.
 * Uses binary search to find the optimal font size efficiently.
 * 
 * @param {CanvasRenderingContext2D} ctx - Canvas 2D context
 * @param {string} text - Text to measure
 * @param {number} maxWidth - Maximum allowed width in pixels
 * @param {string} fontStyle - Font style prefix (e.g., 'bold', 'italic', '')
 * @param {number} baseFontSize - Starting font size
 * @param {string} fontFamily - Font family (e.g., 'Arial, sans-serif')
 * @returns {number} Optimal font size that fits within maxWidth
 */
function calculateFittingFontSize(ctx, text, maxWidth, fontStyle, baseFontSize, fontFamily) {
  if (!text || maxWidth <= 0) return baseFontSize;
  
  // Use absolute minimum font size to ensure text always fits
  const minFontSize = MIN_FONT_SIZE;
  
  // Start with base font size and check if it fits
  ctx.font = `${fontStyle} ${baseFontSize}px ${fontFamily}`.trim();
  let textWidth = ctx.measureText(text).width;
  
  if (textWidth <= maxWidth) {
    return baseFontSize; // Text fits at base size
  }
  
  // Binary search for optimal font size
  let low = minFontSize;
  let high = baseFontSize;
  let optimalSize = minFontSize;
  
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    ctx.font = `${fontStyle} ${mid}px ${fontFamily}`.trim();
    textWidth = ctx.measureText(text).width;
    
    if (textWidth <= maxWidth) {
      optimalSize = mid;
      low = mid + 1; // Try larger sizes
    } else {
      high = mid - 1; // Try smaller sizes
    }
  }
  
  return optimalSize;
}

/**
 * Draw text that auto-scales to fit within the available width.
 * The font size is reduced if necessary to prevent text from overflowing.
 * 
 * @param {CanvasRenderingContext2D} ctx - Canvas 2D context
 * @param {string} text - Text to draw
 * @param {number} x - X position for text
 * @param {number} y - Y position for text
 * @param {number} maxWidth - Maximum allowed width in pixels
 * @param {Object} options - Drawing options
 * @param {string} options.fontStyle - Font style prefix (e.g., 'bold', 'italic', '')
 * @param {number} options.fontSize - Base font size
 * @param {string} options.fontFamily - Font family
 * @param {string} options.fillStyle - Fill color
 * @param {string} options.textAlign - Text alignment ('left', 'center', 'right')
 * @returns {number} The actual font size used
 */
function drawAutoScaledText(ctx, text, x, y, maxWidth, options = {}) {
  const {
    fontStyle = '',
    fontSize = 24,
    fontFamily = 'Arial, sans-serif',
    fillStyle = '#ffffff',
    textAlign = 'center'
  } = options;
  
  if (!text) return fontSize;
  
  // Calculate the fitting font size
  const fittingSize = calculateFittingFontSize(ctx, text, maxWidth, fontStyle, fontSize, fontFamily);
  
  // Set up context and draw
  ctx.font = `${fontStyle} ${fittingSize}px ${fontFamily}`.trim();
  ctx.fillStyle = fillStyle;
  ctx.textAlign = textAlign;
  ctx.fillText(text, x, y);
  
  return fittingSize;
}

/**
 * Build a poster image for a fixture using the background image.
 * Returns the path to the generated image file, or null if image generation fails.
 * 
 * @param {Object} fixture - Fixture object with poster fields
 * @param {Object} options - Options for poster generation
 * @param {string} options.backgroundPath - Path to background image
 * @param {string} options.footerText - Footer text to display
 * @returns {Promise<string|null>} Path to generated image, or null on failure
 */
function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawImageCover(ctx, image, width, height) {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawBadge(ctx, image, x, y, size) {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
  ctx.shadowBlur = 24;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  ctx.beginPath();
  ctx.arc(x, y, size / 2 + 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(x, y, size / 2, 0, Math.PI * 2);
  ctx.clip();
  const scale = Math.min(size / image.width, size / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  ctx.drawImage(image, x - width / 2, y - height / 2, width, height);
  ctx.restore();
}

function drawTeamMark(ctx, image, teamName, x, y, size) {
  if (image) return drawBadge(ctx, image, x, y, size);
  const initials = String(teamName || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  ctx.save();
  const gradient = ctx.createLinearGradient(x - size / 2, y - size / 2, x + size / 2, y + size / 2);
  gradient.addColorStop(0, '#38e8c6');
  gradient.addColorStop(1, '#1678a8');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, size / 2, 0, Math.PI * 2);
  ctx.fill();
  drawAutoScaledText(ctx, initials, x, y + 22, size * 0.72, {
    fontStyle: 'bold', fontSize: Math.round(size * 0.36), fontFamily: 'Arial, sans-serif',
    fillStyle: '#061525', textAlign: 'center'
  });
  ctx.restore();
}

async function buildPosterImageForFixture(fixture, options = {}) {
  if (!canvas) {
    logLine('  [Image] Canvas library not available, falling back to text');
    return null;
  }

  const {
    backgroundPath,
    footerText = '',
    brandName = 'UK FOOTBALL ON TV',
    subtitleText = DEFAULT_POSTER_SUBTITLE
  } = options;
  try {
    ensureTmpDir();
    const canvasWidth = DEFAULT_POSTER_WIDTH;
    const canvasHeight = DEFAULT_POSTER_HEIGHT;
    const cvs = canvas.createCanvas(canvasWidth, canvasHeight);
    const ctx = cvs.getContext('2d');
    const fontFamily = 'Arial, sans-serif';

    if (backgroundPath && fs.existsSync(backgroundPath)) {
      const bgImage = await canvas.loadImage(backgroundPath);
      drawImageCover(ctx, bgImage, canvasWidth, canvasHeight);
      ctx.fillStyle = `rgba(5, 12, 24, ${POSTER_OVERLAY_OPACITY})`;
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    } else {
      const gradient = ctx.createLinearGradient(0, 0, canvasWidth, canvasHeight);
      gradient.addColorStop(0, '#071a2f');
      gradient.addColorStop(0.52, '#102b46');
      gradient.addColorStop(1, '#07111f');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      ctx.fillStyle = 'rgba(56, 232, 198, 0.08)';
      ctx.beginPath();
      ctx.arc(940, 120, 330, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(70, 1260, 420, 0, Math.PI * 2);
      ctx.fill();
    }

    const fixtureWithBadges = await resolveMissingTeamBadges(fixture);
    const images = await resolveFixtureImages(fixtureWithBadges, { logger: logLine });
    const loadOptional = async (filePath) => {
      try { return filePath ? await canvas.loadImage(filePath) : null; } catch (_) { return null; }
    };
    const [homeBadge, awayBadge, competitionLogo] = await Promise.all([
      loadOptional(images.homeBadgePath),
      loadOptional(images.awayBadgePath),
      loadOptional(images.competitionImagePath)
    ]);

    ctx.fillStyle = '#38e8c6';
    ctx.fillRect(0, 0, canvasWidth, 14);
    drawAutoScaledText(ctx, brandName.toUpperCase(), 70, 92, 760, {
      fontStyle: 'bold', fontSize: 54, fontFamily, fillStyle: '#ffffff', textAlign: 'left'
    });
    if (subtitleText) {
      drawAutoScaledText(ctx, subtitleText.toUpperCase(), 72, 137, 760, {
        fontStyle: 'bold', fontSize: 25, fontFamily, fillStyle: '#38e8c6', textAlign: 'left'
      });
    }
    if (competitionLogo) drawBadge(ctx, competitionLogo, 965, 90, 78);

    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    drawRoundedRect(ctx, 70, 180, 940, 130, 26);
    ctx.fill();
    drawAutoScaledText(ctx, (fixture.dateUk || 'DATE TBC').toUpperCase(), canvasWidth / 2, 235, 860, {
      fontStyle: 'bold', fontSize: 42, fontFamily, fillStyle: '#ffd166', textAlign: 'center'
    });
    const timeLine = [fixture.timeUk ? `${fixture.timeUk} UK` : '', fixture.timeEt ? `${fixture.timeEt} ET` : '']
      .filter(Boolean).join('  •  ');
    drawAutoScaledText(ctx, timeLine || 'KICK-OFF TBC', canvasWidth / 2, 287, 800, {
      fontStyle: 'bold', fontSize: 34, fontFamily, fillStyle: '#ffffff', textAlign: 'center'
    });

    drawTeamMark(ctx, homeBadge, fixture.homeTeam, 270, 455, 180);
    drawTeamMark(ctx, awayBadge, fixture.awayTeam, 810, 455, 180);
    drawAutoScaledText(ctx, 'V', canvasWidth / 2, 475, 100, {
      fontStyle: 'bold', fontSize: 56, fontFamily, fillStyle: '#38e8c6', textAlign: 'center'
    });

    drawAutoScaledText(ctx, (fixture.homeTeam || '').toUpperCase(), 270, 610, 400, {
      fontStyle: 'bold', fontSize: 48, fontFamily, fillStyle: '#ffffff', textAlign: 'center'
    });
    drawAutoScaledText(ctx, (fixture.awayTeam || '').toUpperCase(), 810, 610, 400, {
      fontStyle: 'bold', fontSize: 48, fontFamily, fillStyle: '#ffffff', textAlign: 'center'
    });
    drawAutoScaledText(ctx, fixture.competition || 'Competition TBC', canvasWidth / 2, 682, 850, {
      fontStyle: 'italic', fontSize: 32, fontFamily, fillStyle: '#b9c7d6', textAlign: 'center'
    });

    ctx.fillStyle = 'rgba(4, 12, 24, 0.78)';
    drawRoundedRect(ctx, 70, 730, 940, 470, 30);
    ctx.fill();
    drawAutoScaledText(ctx, 'WHERE TO WATCH', 110, 792, 820, {
      fontStyle: 'bold', fontSize: 36, fontFamily, fillStyle: '#38e8c6', textAlign: 'left'
    });

    const tvByRegion = sortTvRegions(fixture.tvByRegion || []).slice(0, 7);
    let rowY = 852;
    if (tvByRegion.length) {
      for (const entry of tvByRegion) {
        drawAutoScaledText(ctx, (entry.region || 'TV').toUpperCase(), 110, rowY, 210, {
          fontStyle: 'bold', fontSize: 27, fontFamily, fillStyle: '#ffd166', textAlign: 'left'
        });
        drawAutoScaledText(ctx, entry.channel || '', 340, rowY, 625, {
          fontStyle: '', fontSize: 29, fontFamily, fillStyle: '#ffffff', textAlign: 'left'
        });
        rowY += 48;
      }
      if ((fixture.tvByRegion || []).length > tvByRegion.length) {
        drawAutoScaledText(ctx, `+ ${(fixture.tvByRegion || []).length - tvByRegion.length} more channels in the caption`, 110, rowY, 820, {
          fontStyle: 'italic', fontSize: 24, fontFamily, fillStyle: '#9eb0c2', textAlign: 'left'
        });
      }
    } else {
      drawAutoScaledText(ctx, 'TV DETAILS TO BE CONFIRMED', canvasWidth / 2, 955, 760, {
        fontStyle: 'bold', fontSize: 38, fontFamily, fillStyle: '#b9c7d6', textAlign: 'center'
      });
    }

    drawAutoScaledText(ctx, footerText || 'Fixtures and channels can change — check before kick-off.', canvasWidth / 2, 1275, 900, {
      fontStyle: '', fontSize: 24, fontFamily, fillStyle: '#9eb0c2', textAlign: 'center'
    });
    drawAutoScaledText(ctx, 'Listings only • No streams hosted or linked', canvasWidth / 2, 1315, 900, {
      fontStyle: 'bold', fontSize: 22, fontFamily, fillStyle: '#38e8c6', textAlign: 'center'
    });

    const teamName = (fixture.homeTeam || 'fixture').replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const outputPath = path.join(TMP_DIR, `poster-${teamName.slice(0, 20)}-${Date.now()}.png`);
    fs.writeFileSync(outputPath, cvs.toBuffer('image/png'));
    return outputPath;
  } catch (err) {
    logLine(`  [Image] Error generating poster image: ${err.message || String(err)}`);
    return null;
  }
}

/**
 * Clean up a temporary poster image file.
 * @param {string} imagePath - Path to the image to delete
 */
function cleanupTempPoster(imagePath) {
  try {
    if (imagePath && fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }
  } catch (err) {
    // Ignore cleanup errors
  }
}

// ---------- Poster-style formatting helpers ----------

/**
 * Format a time in a given timezone.
 * @param {Date} date - The date to format
 * @param {string} timezone - IANA timezone string (e.g., 'Europe/London')
 * @returns {string} Formatted time string (e.g., "3:00pm")
 */
function formatTimeInZone(date, timezone) {
  try {
    const options = {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone
    };
    return date.toLocaleTimeString('en-US', options).toLowerCase().replace(' ', '');
  } catch (err) {
    // Fallback if timezone is invalid
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).toLowerCase().replace(' ', '');
  }
}

/**
 * Format a date in a given timezone.
 * @param {Date} date - The date to format
 * @param {string} timezone - IANA timezone string (e.g., 'Europe/London')
 * @returns {string} Formatted date string (e.g., "Saturday 11 January 2026")
 */
function formatDateInZone(date, timezone) {
  try {
    const options = {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: timezone
    };
    return date.toLocaleDateString('en-GB', options).replace(',', '');
  } catch (err) {
    // Fallback if timezone is invalid
    return date.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    }).replace(',', '');
  }
}

/**
 * Clean a team name by removing common annotations like (HOME), (AWAY), (H), (A), etc.
 * @param {string} name - Team name that may have annotations
 * @returns {string} Cleaned team name
 */
function cleanTeamName(name) {
  if (!name) return '';
  // Remove common annotations: (HOME), (AWAY), (H), (A), [HOME], [AWAY], [H], [A]
  // Parentheses/brackets are required to avoid matching team names ending in these letters
  return name
    .replace(/\s*\(\s*HOME\s*\)\s*$/i, '')
    .replace(/\s*\(\s*AWAY\s*\)\s*$/i, '')
    .replace(/\s*\(\s*H\s*\)\s*$/i, '')
    .replace(/\s*\(\s*A\s*\)\s*$/i, '')
    .replace(/\s*\[\s*HOME\s*\]\s*$/i, '')
    .replace(/\s*\[\s*AWAY\s*\]\s*$/i, '')
    .replace(/\s*\[\s*H\s*\]\s*$/i, '')
    .replace(/\s*\[\s*A\s*\]\s*$/i, '')
    .trim();
}

/**
 * Parse team names from a fixture summary.
 * Handles common fixture summary formats:
 * - "Team A v Team B"
 * - "Team A vs Team B"
 * - "Team A - Team B"
 * - "Team A @ Team B"
 * - "Team AvTeam B" (no spaces)
 * - "Team A (HOME) v Team B (AWAY)"
 * - "Team A vs.Team B"
 * 
 * @param {string} summary - Fixture summary (e.g., "Arsenal v Chelsea")
 * @returns {{ homeTeam: string, awayTeam: string }}
 */
function parseTeamsFromSummary(summary) {
  const text = (summary || '').trim();
  
  if (!text) {
    return { homeTeam: '', awayTeam: '' };
  }
  
  // Try each separator pattern in order of specificity
  for (const { pattern } of TEAM_SEPARATOR_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1] && match[2]) {
      const homeRaw = match[1].trim();
      const awayRaw = match[2].trim();
      
      // Skip if either side is empty after trimming
      if (!homeRaw || !awayRaw) continue;
      
      // Clean team names to remove (HOME)/(AWAY) annotations
      const homeTeam = cleanTeamName(homeRaw);
      const awayTeam = cleanTeamName(awayRaw);
      
      // Only return if we actually have two valid team names
      if (homeTeam && awayTeam) {
        return { homeTeam, awayTeam };
      }
    }
  }
  
  // Fallback: return the whole summary as homeTeam (after cleaning)
  return {
    homeTeam: cleanTeamName(text),
    awayTeam: ''
  };
}

/**
 * Adapt a basic fixture object to the poster data model.
 * Adds/updates timeUk, timeEt, homeTeam, awayTeam, matchTitle fields.
 * Also sets competition, venue, and tvByRegion if not already present.
 * 
 * @param {Object} fixture - Basic fixture object with start, summary and TV information.
 * @returns {Object} Adapted fixture with poster fields
 */
function adaptFixtureForPoster(fixture) {
  const start = fixture.start instanceof Date ? fixture.start : new Date(fixture.start);
  
  // Format date and times in UK and US Eastern timezones
  const dateUk = formatDateInZone(start, 'Europe/London');
  const timeUk = formatTimeInZone(start, 'Europe/London');
  const timeEt = formatTimeInZone(start, 'America/New_York');
  
  // Parse home and away teams from "Home v Away" style summaries.
  let homeTeam = fixture.homeTeam || '';
  let awayTeam = fixture.awayTeam || '';
  if (!homeTeam) {
    const parsed = parseTeamsFromSummary(fixture.summary);
    homeTeam = parsed.homeTeam;
    awayTeam = parsed.awayTeam;
  }
  
  // Build matchTitle from home and away teams
  let matchTitle = '';
  if (homeTeam && awayTeam) {
    matchTitle = `${homeTeam.toUpperCase()} v ${awayTeam.toUpperCase()}`;
  } else if (homeTeam) {
    matchTitle = homeTeam.toUpperCase();
  }
  
  // Build tvByRegion from tvChannel if available (simple conversion)
  // For now, if we have a single tvChannel, put it under a default region
  let tvByRegion = sortTvRegions(fixture.tvByRegion || []);
  
  if (tvByRegion.length === 0 && fixture.tvChannel) {
    // Single channel - assume UK region
    tvByRegion = [{ region: 'UK', channel: fixture.tvChannel }];
  }
  
  return {
    ...fixture,
    date: start,
    dateUk,
    timeUk,
    timeEt,
    homeTeam,
    awayTeam,
    matchTitle,
    competition: fixture.competition || '',
    venue: fixture.location || fixture.venue || '',
    tvByRegion
  };
}

/**
 * Format a fixture in poster-style layout for Telegram.
 * 
 * Layout:
 * ═══════════════════════════
 * SPORTS LISTINGS ON TV
 * ═══════════════════════════
 * 
 * 3:00pm UK    10:00am ET
 * 
 * BRENTFORD v BURNLEY
 * Premier League
 * 
 * Australia     Stan Sport
 * Canada        Fubo Sports 4
 * Caribbean     ESPN on Disney+
 * ...
 * 
 * Support the listings by subscribing.
 * 
 * @param {Object} fixture - Fixture object with poster fields
 * @param {Object} options - Options for formatting
 * @param {boolean} options.showFooter - Whether to show the footer (default true)
 * @param {string} options.footerText - Custom footer text (default: "Please support the listings by subscribing.")
 * @returns {string} Formatted poster message
 */
const DEFAULT_FOOTER_TEXT = 'Please support the listings by subscribing.';

function formatFixturePoster(fixture, options = {}) {
  const { showFooter = true, footerText = DEFAULT_FOOTER_TEXT } = options;
  
  const lines = [];
  
  // Banner
  lines.push('═══════════════════════════');
  lines.push('   SPORTS LISTINGS ON TV   ');
  lines.push('═══════════════════════════');
  lines.push('');
  
  // Date
  if (fixture.dateUk) {
    lines.push(fixture.dateUk);
    lines.push('');
  }
  
  // Times in two zones
  const timeUk = fixture.timeUk || '';
  const timeEt = fixture.timeEt || '';
  if (timeUk || timeEt) {
    const timeLine = [];
    if (timeUk) timeLine.push(`${timeUk} UK`);
    if (timeEt) timeLine.push(`${timeEt} ET`);
    lines.push(timeLine.join('    '));
    lines.push('');
  }
  
  // Fixture title - prefer matchTitle, fall back to constructing from home/away teams
  if (fixture.matchTitle) {
    lines.push(fixture.matchTitle);
  } else {
    const homeTeam = (fixture.homeTeam || '').toUpperCase();
    const awayTeam = (fixture.awayTeam || '').toUpperCase();
    if (homeTeam && awayTeam) {
      lines.push(`${homeTeam} v ${awayTeam}`);
    } else if (homeTeam) {
      lines.push(homeTeam);
    }
  }
  
  // Competition (optional)
  if (fixture.competition) {
    lines.push(fixture.competition);
  }
  
  lines.push('');
  
  // TV by Region list
  const tvByRegion = fixture.tvByRegion || [];
  if (tvByRegion.length > 0) {
    // Calculate max region width for alignment
    const maxRegionLen = Math.max(...tvByRegion.map(r => (r.region || '').length));
    
    for (const { region, channel } of tvByRegion) {
      const paddedRegion = (region || '').padEnd(maxRegionLen, ' ');
      lines.push(`${paddedRegion}  ${channel || ''}`);
    }
  } else {
    lines.push('TV details TBC');
  }
  
  // Wikipedia broadcasters as fallback or supplement
  // Show if LSTV returned no results but wiki has data
  const wikiBroadcasters = fixture.wikiBroadcasters || [];
  const wikiUkChannels = fixture.wikiUkChannels || [];
  if (tvByRegion.length === 0 && wikiUkChannels.length > 0) {
    // Use wiki data as fallback when LSTV has no results
    lines.push(`(Wikipedia: ${wikiUkChannels.slice(0, 4).join(', ')}${wikiUkChannels.length > 4 ? '...' : ''})`);
  } else if (wikiUkChannels.length > 0 && tvByRegion.length < 3) {
    // Supplement sparse LSTV data with wiki reference
    lines.push('');
    lines.push(`(UK broadcasters: ${wikiUkChannels.slice(0, 3).join(', ')})`);
  }
  
  // Footer (optional)
  if (showFooter && footerText) {
    lines.push('');
    lines.push(footerText);
  }
  
  return lines.join('\n');
}

function buildPhotoCaption(fixture, options = {}) {
  const prefix = options.isUpdate ? '🔄 LISTING UPDATED' : '⚽ UK FOOTBALL ON TV';
  const lines = [prefix];
  if (fixture.dateUk) lines.push(`📅 ${fixture.dateUk}`);
  if (fixture.timeUk) lines.push(`🕒 ${fixture.timeUk} UK kick-off`);
  lines.push(`🏟 ${fixture.homeTeam || ''} v ${fixture.awayTeam || ''}`);
  if (fixture.competition) lines.push(`🏆 ${fixture.competition}`);

  const regions = sortTvRegions(fixture.tvByRegion || []).slice(0, 12);
  if (regions.length) {
    lines.push('');
    for (const entry of regions) lines.push(`📡 ${entry.region}: ${entry.channel}`);
  } else {
    lines.push('', '📡 TV details to be confirmed');
  }
  lines.push('', 'Listings can change. Check your TV guide before kick-off.');
  lines.push('Listings only — no streams hosted or linked.');
  return lines.join('\n').slice(0, 1024);
}

function splitTelegramText(text, limit = TELEGRAM_MESSAGE_LIMIT) {
  if (text.length <= limit) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function buildUkDailyDigest(fixtures, channel, cfg) {
  const timezone = cfg.timezone || 'Europe/London';
  const byDate = new Map();
  for (const fixture of fixtures) {
    const date = fixture.start instanceof Date ? fixture.start : new Date(fixture.start);
    const key = dateKeyInZone(date, timezone);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(fixture);
  }

  const messages = [];
  for (const dayFixtures of byDate.values()) {
    const date = new Date(dayFixtures[0].start);
    const lines = [
      '⚽ UK FOOTBALL ON TV',
      `📅 ${formatDateInZone(date, timezone).toUpperCase()}`,
      '',
      `${dayFixtures.length} televised fixture${dayFixtures.length === 1 ? '' : 's'} currently listed`,
      ''
    ];
    for (const fixture of dayFixtures) {
      const adapted = adaptFixtureForPoster(fixture);
      const uk = (adapted.tvByRegion || []).filter((entry) => entry.region === 'UK');
      const fallback = (adapted.tvByRegion || []).slice(0, 2);
      const channels = (uk.length ? uk : fallback).map((entry) => entry.channel);
      lines.push(`🕒 ${adapted.timeUk || 'TBC'}  ${adapted.homeTeam} v ${adapted.awayTeam}`);
      if (adapted.competition) lines.push(`🏆 ${adapted.competition}`);
      lines.push(`📡 ${channels.length ? channels.join(' • ') : 'TV details TBC'}`, '');
    }
    lines.push('Times shown in the UK timezone.', 'Listings only — no streams hosted or linked.');
    messages.push(...splitTelegramText(lines.join('\n')));
  }
  return messages;
}

function channelOutputSettings(channel = {}) {
  return {
    postDailyDigest: channel.postDailyDigest !== false,
    postFixtureCards: channel.posterStyle !== false
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- TV channel helpers ----------

/**
 * Look up a TV channel for a fixture based on channel's tvChannelOverrides config.
 *
 * @param {Object} fixture - Fixture object with at least `summary` and optionally `tvChannel`
 * @param {Object} channel - Channel config object with optional `tvChannelOverrides`
 * @returns {string|null} The TV channel name if matched, or null if no match
 */
function getTvChannelForFixture(fixture, channel) {
  // If a source already supplied a TV channel, return it.
  if (fixture.tvChannel) {
    return fixture.tvChannel;
  }

  // Check channel's tvChannelOverrides
  const overrides = channel && channel.tvChannelOverrides;
  if (!overrides || typeof overrides !== 'object') {
    return null;
  }

  const summary = (fixture.summary || '').toLowerCase();
  if (!summary) {
    return null;
  }

  // Iterate over override keys and check for case-insensitive match in summary
  for (const key of Object.keys(overrides)) {
    const needle = key.toLowerCase();
    if (summary.includes(needle)) {
      return overrides[key];
    }
  }

  return null;
}

/**
 * Try to enrich a fixture with TV channel info from TheSportsDB API.
 * Falls back gracefully if API key not set or if no TV info found.
 *
 * @param {Object} cfg - Config object with theSportsDbApiKey
 * @param {Object} fixture - Fixture object
 * @param {string} teamLabel - Team name to search for
 * @returns {Promise<Object>} Fixture object (possibly with tvChannel enriched)
 */
async function enrichFixtureWithTheSportsDb(cfg, fixture, teamLabel) {
  const apiKey = cfg.theSportsDbApiKey;
  
  // Skip if no API key configured
  if (!apiKey) {
    return fixture;
  }
  
  // Skip if fixture already has TV channel info
  if (fixture.tvChannel) {
    return fixture;
  }
  
  try {
    const enriched = await theSportsDb.enrichFixtureWithTvInfo(
      apiKey,
      fixture,
      teamLabel,
      'UK'
    );
    return enriched;
  } catch (err) {
    // Log but don't fail - TV enrichment is optional
    logLine(`  [TheSportsDB] Warning: ${err.message}`);
    return fixture;
  }
}

/**
 * Try to enrich a fixture with TV channel info from LiveSoccerTV scraper.
 * This provides worldwide TV channel listings by region.
 * Falls back gracefully if scraping fails.
 *
 * @param {Object} cfg - Config object with liveSoccerTvEnabled flag
 * @param {Object} fixture - Fixture object with homeTeam, awayTeam, start
 * @returns {Promise<Object>} Fixture object (possibly with tvByRegion enriched)
 */
async function enrichFixtureWithLiveSoccerTv(cfg, fixture) {
  // Skip if LiveSoccerTV is disabled in config
  if (cfg.liveSoccerTvEnabled === false) {
    return fixture;
  }
  
  // Skip if fixture already has TV regions populated
  if (fixture.tvByRegion && fixture.tvByRegion.length > 0) {
    return fixture;
  }
  
  // Need home and away teams to search
  const homeTeam = fixture.homeTeam || '';
  const awayTeam = fixture.awayTeam || '';
  
  if (!homeTeam || !awayTeam) {
    return fixture;
  }
  
  try {
    // Use the new Puppeteer-based LSTV scraper if enabled
    if (cfg.liveSoccerTvUsePuppeteer === true) {
      logLine(`    [LSTV] Fetching TV info for ${homeTeam} v ${awayTeam}`);
      
      const lstvResult = await lstv.fetchLSTV({
        home: homeTeam,
        away: awayTeam,
        date: fixture.start || fixture.date || new Date(),
        // Pass enhanced info from TSDB if available
        kickoffUtc: fixture.tsdbKickoffUtc || null,
        league: fixture.tsdbLeague || fixture.competition || null
      });
      
      if (lstvResult.regionChannels && lstvResult.regionChannels.length > 0) {
        fixture.tvByRegion = lstvResult.regionChannels;
        fixture.tvSource = 'lstv';
        fixture.tvSourceUrl = lstvResult.url;
        fixture.tvMatchScore = lstvResult.matchScore;
        logLine(`    [LSTV] Found ${lstvResult.regionChannels.length} TV channels for ${homeTeam} v ${awayTeam} (score=${lstvResult.matchScore || 'N/A'})`);
        return fixture;
      }
      
      // Fall through to HTTP-based scraper if Puppeteer found nothing
      logLine(`    [LSTV] No results from Puppeteer, trying HTTP fallback`);
    }
    
    // Use HTTP-based scraper (original livesoccertv module) as fallback
    // Note: Always disable Puppeteer here since we either:
    // 1. Already tried Puppeteer above (if liveSoccerTvUsePuppeteer was true)
    // 2. Or the user explicitly wants HTTP-only mode (if liveSoccerTvUsePuppeteer was false)
    const enriched = await liveSoccerTv.enrichFixtureWithTvInfo(fixture, {
      usePuppeteer: false
    });
    
    if (enriched.tvByRegion && enriched.tvByRegion.length > 0) {
      logLine(`    [LiveSoccerTV] Found ${enriched.tvByRegion.length} TV channels for ${homeTeam} v ${awayTeam}`);
    }
    
    return enriched;
  } catch (err) {
    // Log but don't fail - TV enrichment is optional
    logLine(`  [LiveSoccerTV] Warning: ${err.message}`);
    return fixture;
  }
}

/**
 * Enrich a fixture with data from TheSportsDB API.
 * This provides kickoff time, league, venue, and optionally TV stations.
 * Falls back gracefully if API call fails.
 *
 * @param {Object} fixture - Fixture object with homeTeam, awayTeam, start
 * @returns {Promise<Object>} Fixture object with TSDB data added
 */
async function enrichFixtureWithTSDB(fixture) {
  const homeTeam = fixture.homeTeam || '';
  const awayTeam = fixture.awayTeam || '';
  
  if (!homeTeam || !awayTeam) {
    return fixture;
  }
  
  try {
    logLine(`    [TSDB] Looking up ${homeTeam} v ${awayTeam}`);
    
    const tsdbResult = await tsdb.fetchTSDBFixture({
      home: homeTeam,
      away: awayTeam,
      date: fixture.start || fixture.date || new Date()
    });
    
    if (tsdbResult.matched) {
      // Store TSDB data for use by LSTV
      fixture.tsdbMatched = true;
      fixture.tsdbKickoffUtc = tsdbResult.kickoffUtc;
      fixture.tsdbLeague = tsdbResult.league;
      fixture.tsdbVenue = tsdbResult.venue;
      fixture.tsdbEventId = tsdbResult.eventId;
      
      // Use TSDB league/venue if not already set
      if (!fixture.competition && tsdbResult.league) {
        fixture.competition = tsdbResult.league;
      }
      if (!fixture.venue && tsdbResult.venue) {
        fixture.venue = tsdbResult.venue;
      }
      
      // Merge TV stations from TSDB (if any) as a flat list
      if (tsdbResult.tvStations && tsdbResult.tvStations.length > 0) {
        fixture.tsdbTvStations = tsdbResult.tvStations;
        logLine(`    [TSDB] Matched: ${tsdbResult.league || 'unknown league'}, ${tsdbResult.tvStations.length} TV stations`);
      } else {
        logLine(`    [TSDB] Matched: ${tsdbResult.league || 'unknown league'}, kickoff=${tsdbResult.kickoffUtc || 'unknown'}`);
      }
    } else {
      fixture.tsdbMatched = false;
      logLine(`    [TSDB] No match found`);
    }
    
    return fixture;
  } catch (err) {
    fixture.tsdbMatched = false;
    logLine(`    [TSDB] Warning: ${err.message}`);
    return fixture;
  }
}

/**
 * Enrich a fixture with TV data from TSDB, LSTV, and Wikipedia sources.
 * First calls TSDB to get reliable kickoff/league info, then passes that to LSTV.
 * Finally, fetches Wikipedia broadcaster info based on the league.
 * Merges results from all sources.
 *
 * @param {Object} cfg - Config object
 * @param {Object} fixture - Fixture object with homeTeam, awayTeam, start
 * @returns {Promise<Object>} Fixture object with merged TV data
 */
async function enrichFixtureWithAllSources(cfg, fixture) {
  // Step 1: Try TSDB first to get reliable kickoff/league info
  fixture = await enrichFixtureWithTSDB(fixture);
  
  // Step 2: Use LSTV with enriched data from TSDB
  fixture = await enrichFixtureWithLiveSoccerTv(cfg, fixture);
  
  // Step 3: Try Wikipedia for broadcaster info based on league
  fixture = await enrichFixtureWithWiki(fixture);
  
  // Step 4: Log summary
  const tsdbStatus = fixture.tsdbMatched ? 'yes' : 'no';
  const lstvStatus = fixture.tvByRegion && fixture.tvByRegion.length > 0 ? 'yes' : 'no';
  const wikiStatus = fixture.wikiBroadcasters && fixture.wikiBroadcasters.length > 0 ? 'yes' : 'no';
  const regionCount = fixture.tvByRegion ? fixture.tvByRegion.length : 0;
  const tsdbStationCount = fixture.tsdbTvStations ? fixture.tsdbTvStations.length : 0;
  const wikiCount = fixture.wikiBroadcasters ? fixture.wikiBroadcasters.length : 0;
  
  logLine(`    [Summary] TSDB=${tsdbStatus}, LSTV=${lstvStatus}, WIKI=${wikiStatus}, regions=${regionCount}, tsdb_stations=${tsdbStationCount}, wiki_broadcasters=${wikiCount}`);
  
  return fixture;
}

/**
 * Enrich a fixture with Wikipedia broadcaster information.
 * Uses the league name from TSDB or fixture competition field.
 *
 * @param {Object} fixture - Fixture object
 * @returns {Promise<Object>} Fixture object with wikiBroadcasters added
 */
async function enrichFixtureWithWiki(fixture) {
  // Get league name from TSDB result or fixture competition field
  const leagueName = fixture.tsdbLeague || fixture.competition || fixture.league || null;
  
  if (!leagueName) {
    // No league info available, skip wiki lookup
    return fixture;
  }
  
  try {
    logLine(`    [WIKI] Looking up broadcasters for ${leagueName}`);
    
    const wikiResult = await wiki.fetchWikiBroadcasters({
      leagueName,
      season: null, // Auto-detect current season
      country: 'UK' // Default to UK broadcasters
    });
    
    if (wikiResult.broadcasters && wikiResult.broadcasters.length > 0) {
      fixture.wikiBroadcasters = wikiResult.broadcasters;
      fixture.wikiSourceUrl = wikiResult.sourceUrl;
      
      // Get unique UK channel names for summary
      const ukChannels = wiki.getUniqueChannels(wikiResult.broadcasters, 'UK');
      if (ukChannels.length > 0) {
        fixture.wikiUkChannels = ukChannels;
        logLine(`    [WIKI] Found ${wikiResult.broadcasters.length} broadcasters, UK channels: ${ukChannels.slice(0, 5).join(', ')}${ukChannels.length > 5 ? '...' : ''}`);
      } else {
        logLine(`    [WIKI] Found ${wikiResult.broadcasters.length} broadcasters (no UK-specific)`);
      }
    } else {
      fixture.wikiBroadcasters = [];
      logLine(`    [WIKI] No broadcasters found for ${leagueName}`);
    }
    
    return fixture;
  } catch (err) {
    fixture.wikiBroadcasters = [];
    logLine(`    [WIKI] Warning: ${err.message}`);
    return fixture;
  }
}

/**
 * Enrich a fixture with TV data using the universal aggregator.
 * This is the preferred method when the aggregator is available.
 * Falls back to legacy enrichment if aggregator is not available or fails.
 *
 * @param {Object} cfg - Config object
 * @param {Object} fixture - Fixture object with homeTeam, awayTeam, start
 * @returns {Promise<Object>} Fixture object with TV data from aggregator
 */
async function enrichFixtureWithAggregator(cfg, fixture) {
  // Check if aggregator is available
  if (!tvAggregator || !tvAggregator.getTvDataForFixture) {
    logLine('    [AGG] Aggregator not available, falling back to legacy enrichment');
    return enrichFixtureWithAllSources(cfg, fixture);
  }
  
  const homeTeam = fixture.homeTeam || '';
  const awayTeam = fixture.awayTeam || '';
  
  if (!homeTeam || !awayTeam) {
    logLine('    [AGG] Missing team names, skipping aggregator');
    return fixture;
  }
  
  try {
    logLine(`    [AGG] Getting TV data for ${homeTeam} v ${awayTeam}`);
    
    const tvData = await tvAggregator.getTvDataForFixture({
      homeTeam,
      awayTeam,
      dateUtc: fixture.start || fixture.date || new Date(),
      leagueHint: fixture.competition || fixture.league || null
    }, {
      timezone: cfg.timezone || 'Europe/London',
      debug: false
    });
    
    // Merge aggregator results into fixture
    if (tvData) {
      // Use aggregator's league/venue if not already set
      if (!fixture.competition && tvData.league) {
        fixture.competition = tvData.league;
      }
      if (!fixture.venue && tvData.venue) {
        fixture.venue = tvData.venue;
      }
      
      // Use aggregator's kickoff if available
      if (tvData.kickoffUtc) {
        fixture.aggregatorKickoffUtc = tvData.kickoffUtc;
        fixture.aggregatorKickoffLocal = tvData.kickoffLocal;
      }
      
      // Use aggregator's TV regions (converted to expected format)
      if (tvData.tvRegions && tvData.tvRegions.length > 0) {
        fixture.tvByRegion = tvData.tvRegions.map(r => ({
          region: r.region,
          channel: r.channel
        }));
        fixture.tvSource = 'aggregator';
      }
      
      // Store flat station list
      if (tvData.tvStationsFlat && tvData.tvStationsFlat.length > 0) {
        fixture.tvStationsFlat = tvData.tvStationsFlat;
      }
      
      // Store sources used for debugging
      fixture.sourcesUsed = tvData.sourcesUsed;
      
      // Log summary
      const sourcesStr = Object.entries(tvData.sourcesUsed || {})
        .filter(([, used]) => used)
        .map(([name]) => name.toUpperCase())
        .join(',') || 'none';
      const regionCount = tvData.tvRegions?.length || 0;
      const stationCount = tvData.tvStationsFlat?.length || 0;
      
      logLine(`    [AGG] Result: league=${tvData.league || 'unknown'}, regions=${regionCount}, stations=${stationCount}, sources={${sourcesStr}}`);
    }
    
    return fixture;
  } catch (err) {
    logLine(`    [AGG] Error: ${err.message}, falling back to legacy enrichment`);
    // Fall back to legacy enrichment on error
    return enrichFixtureWithAllSources(cfg, fixture);
  }
}

// ---------- build message for a channel ----------

async function buildChannelMessage(cfg, channel) {
  const daily = await getUkDailyListings({
    config: cfg,
    channel,
    logger: logLine
  });
  const maxFixtures = Math.max(1, Math.min(Number(channel.maxFixturesPerRun || 80), 150));
  let fixtures = daily.fixtures.slice(0, maxFixtures);
  if (!fixtures.length) {
    return { text: '', matchCount: 0, mode: 'uk-daily', sourceStatus: daily.sourceStatus };
  }

  const output = channelOutputSettings(channel);
  // Resolve artwork before duplicate detection. This makes a later successful
  // lookup change the fixture fingerprint and produces a corrected poster,
  // instead of permanently keeping the initials-only version.
  if (output.postFixtureCards) {
    fixtures = await resolveFixtureBadges(fixtures, { logger: logLine });
  }
  return {
    text: '',
    digestMessages: output.postDailyDigest ? buildUkDailyDigest(fixtures, channel, cfg) : [],
    matchCount: fixtures.length,
    fixtures,
    posterStyle: output.postFixtureCards,
    mode: 'uk-daily',
    sourceStatus: daily.sourceStatus,
    dates: daily.dates
  };
}

// ---------- main runner ----------

async function runOnce(options = {}) {
  const cfg = loadConfig();
  const force = options.force === true;

  const botToken = process.env.TELEGRAM_BOT_TOKEN || cfg.botToken;
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable or botToken in config.json is required');
  }

  const channels = cfg.channels || [];
  if (!channels.length) {
    throw new Error('No channels configured in config.json');
  }

  try {
    await runMessageCleanup({ cfg, botToken });
  } catch (error) {
    logLine(`[CLEANUP] Cleanup run failed without blocking listings: ${error.message || String(error)}`);
  }

  const results = [];
  let totalMatches = 0;
  let sendCount = 0;
  const state = postState.loadState();

  for (const channel of channels) {
    const label = channel.label || channel.id || '(unknown channel)';

    try {
      const buildResult = await buildChannelMessage(cfg, channel);
      const { text, matchCount, posterStyle, fixtures, digestMessages, mode, dates } = buildResult;

      if (!matchCount) {
        logLine(
          `Channel "${label}": no fixtures found for current window (matches=0).`
        );
        results.push({
          channelLabel: label,
          sent: false,
          matchCount: 0
        });
        continue;
      }

      let digestCount = 0;
      const telegramDelayMs = telegramChatDelayMs(cfg, channel);
      const expiry = messageExpirySettings(cfg);
      if (mode === 'uk-daily' && Array.isArray(digestMessages) && digestMessages.length) {
        const digestKey = `${channel.id}|digest|${(dates || []).join(',')}`;
        if (force || !state.posts?.[digestKey]) {
          const digestMessageIds = [];
          for (const digest of digestMessages) {
            const sentMessage = await sendTelegramMessage(botToken, channel.id, digest);
            if (sentMessage?.message_id) {
              digestMessageIds.push(sentMessage.message_id);
              if (expiry.enabled) {
                postState.queueDeletion(state, {
                  chatId: channel.id,
                  messageId: sentMessage.message_id,
                  deleteAt: digestDeletionTimestamp(dates, expiry, cfg.timezone || 'Europe/London'),
                  kind: 'daily digest',
                  label
                });
              }
            }
            digestCount += 1;
            await sleep(telegramDelayMs);
          }
          state.posts = state.posts || {};
          state.posts[digestKey] = {
            fingerprint: 'daily-digest',
            postedAt: Date.now(),
            messageIds: digestMessageIds
          };
          postState.saveState(state);
        }
      }

      // Handle poster-style messages (one message per fixture)
      if (posterStyle && fixtures && fixtures.length > 0) {
        const fixtureStates = new Map();
        let postingFixtures = fixtures;
        if (mode === 'uk-daily' && !force) {
          postingFixtures = fixtures.filter((fixture) => {
            const result = postState.shouldPostFixture(state, channel.id, fixture, cfg.timezone || 'Europe/London');
            fixtureStates.set(fixture, result);
            return result.shouldPost;
          });
        }
        const maxPosters = Math.max(0, Math.min(Number(channel.maxPostersPerRun ?? 20), 50));
        postingFixtures = postingFixtures.slice(0, maxPosters);

        if (!postingFixtures.length) {
          logLine(`Channel "${label}": no new or changed fixture posters to send.`);
          results.push({
            channelLabel: label,
            sent: digestCount > 0,
            matchCount,
            digestCount,
            posterCount: 0,
            skippedAsDuplicate: fixtures.length
          });
          totalMatches += matchCount;
          if (digestCount) sendCount += 1;
          continue;
        }
        logLine(
          `Channel "${label}": posting ${postingFixtures.length} of ${fixtures.length} fixture posters.`
        );
        
        // Get footer text from config (empty/whitespace-only means no footer)
        const posterFooterText = (cfg.posterFooterText || '').trim();
        const showFooter = Boolean(posterFooterText);
        
        // Check if we should use image posters
        const backgroundPath = getBackgroundImagePath();
        const useImagePosters = Boolean(canvas);
        
        if (backgroundPath) {
          logLine(`  Using uploaded poster background: ${path.basename(backgroundPath)}`);
        }
        
        let postersSent = 0;
        for (const fixture of postingFixtures) {
          let posterImagePath = null;
          
          try {
            // Adapt the fixture for poster format
            const posterFixture = adaptFixtureForPoster(fixture);
            
            // Log the fixture being posted (use already parsed team names)
            const tvRegionCount = posterFixture.tvByRegion ? posterFixture.tvByRegion.length : 0;
            const fixtureLabel = posterFixture.awayTeam 
              ? `${posterFixture.homeTeam.toUpperCase()} v ${posterFixture.awayTeam.toUpperCase()}`
              : posterFixture.homeTeam.toUpperCase();
            logLine(
              `  Poster for ${fixtureLabel} – TV regions: ${tvRegionCount}`
            );
            
            // Try image poster first if background is available
            if (useImagePosters) {
              posterImagePath = await buildPosterImageForFixture(posterFixture, {
                backgroundPath,
                footerText: posterFooterText,
                brandName: channel.brandName || channel.label || 'UK FOOTBALL ON TV',
                subtitleText: channel.posterSubtitle === undefined
                  ? DEFAULT_POSTER_SUBTITLE
                  : String(channel.posterSubtitle).trim()
              });
            }

            const stateResult = fixtureStates.get(fixture) || postState.shouldPostFixture(
              state, channel.id, fixture, cfg.timezone || 'Europe/London'
            );
            
            let sentMessage;
            if (posterImagePath) {
              const caption = buildPhotoCaption(posterFixture, { isUpdate: stateResult.isUpdate });
              try {
                sentMessage = await sendTelegramPhoto(botToken, channel.id, posterImagePath, caption);
                logLine(`    -> Sent as image poster`);
              } catch (photoError) {
                logLine(`    -> Image upload rejected: ${photoError.message || String(photoError)}`);
                logLine('    -> Retrying this fixture as a text poster');
                sentMessage = await sendTelegramMessage(botToken, channel.id, caption);
                logLine('    -> Sent as text poster fallback');
              }
            } else {
              // Fall back to text poster
              const posterText = formatFixturePoster(posterFixture, {
                showFooter: showFooter,
                footerText: posterFooterText || DEFAULT_FOOTER_TEXT
              });
              sentMessage = await sendTelegramMessage(botToken, channel.id, posterText);
              logLine(`    -> Sent as text poster`);
            }

            const deleteAt = expiry.enabled && sentMessage?.message_id
              ? fixtureDeletionTimestamp(fixture, expiry)
              : null;
            if (deleteAt) {
              postState.queueDeletion(state, {
                chatId: channel.id,
                messageId: sentMessage.message_id,
                deleteAt,
                kind: 'fixture poster',
                label: fixture.summary || fixtureLabel
              });
            }
            
            postersSent++;
            if (mode === 'uk-daily') {
              postState.markFixturePosted(state, stateResult, {
                messageId: sentMessage?.message_id || null,
                deleteAt
              });
              postState.saveState(state);
            }
            
            // Small delay between messages to avoid rate limiting
            if (postersSent < postingFixtures.length) {
              await sleep(telegramDelayMs);
            }
          } catch (posterErr) {
            logLine(
              `  ERROR sending poster for "${fixture.summary}": ${posterErr.message || String(posterErr)}`
            );
          } finally {
            // Clean up temporary poster image
            if (posterImagePath) {
              cleanupTempPoster(posterImagePath);
            }
          }
        }
        
        logLine(
          `Channel "${label}": sent ${postersSent} poster messages.`
        );
        
        results.push({
          channelLabel: label,
          sent: digestCount > 0 || postersSent > 0,
          matchCount,
          digestCount,
          posterCount: postersSent
        });
        
        totalMatches += matchCount;
        if (digestCount || postersSent > 0) sendCount += 1;
        continue;
      }

      if (mode === 'uk-daily') {
        results.push({
          channelLabel: label,
          sent: digestCount > 0,
          matchCount,
          digestCount,
          posterCount: 0
        });
        totalMatches += matchCount;
        if (digestCount) sendCount += 1;
        continue;
      }

      // Standard list-style message
      if (!text) {
        logLine(
          `Channel "${label}": no text to send (matches=0).`
        );
        results.push({
          channelLabel: label,
          sent: false,
          matchCount: 0
        });
        continue;
      }

      for (const chunk of splitTelegramText(text)) {
        await sendTelegramMessage(botToken, channel.id, chunk);
        await sleep(telegramDelayMs);
      }
      logLine(
        `Channel "${label}": sent message with ${matchCount} fixtures.`
      );

      results.push({
        channelLabel: label,
        sent: true,
        matchCount
      });

      totalMatches += matchCount;
      sendCount += 1;
    } catch (err) {
      logLine(
        `ERROR for channel "${label}": ${err.message || String(err)}`
      );
      results.push({
        channelLabel: label,
        sent: false,
        matchCount: 0,
        error: err.message || String(err)
      });
    }
  }

  postState.saveState(state);
  const summary = `Channels=${channels.length}, sent=${sendCount}, totalMatches=${totalMatches}`;
  logLine(`Run summary: ${summary}`);

  return { summary, results };
}

// allow manual CLI run
if (require.main === module) {
  runOnce()
    .then(({ summary }) => {
      console.log('Done:', summary);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Fatal error in runOnce:', err);
      process.exit(1);
    });
}

module.exports = {
  runOnce,
  getTvChannelForFixture,
  formatFixturePoster,
  buildPhotoCaption,
  buildUkDailyDigest,
  channelOutputSettings,
  splitTelegramText,
  adaptFixtureForPoster,
  parseTeamsFromSummary,
  cleanTeamName,
  formatTimeInZone,
  formatDateInZone,
  getBackgroundImagePath,
  buildPosterImageForFixture,
  sendTelegramPhoto,
  deleteTelegramMessage,
  runMessageCleanup,
  messageExpirySettings,
  fixtureDeletionTimestamp,
  digestDeletionTimestamp,
  telegramRetryDelayMs,
  telegramChatDelayMs,
  telegramApiErrorMessage,
  resolveMissingTeamBadges,
  resolveFixtureBadges,
  enrichFixtureWithLiveSoccerTv,
  enrichFixtureWithAggregator,
  enrichFixtureWithAllSources,
  DEFAULT_FOOTER_TEXT,
  DEFAULT_POSTER_SUBTITLE,
  CONFIG_PATH,
  LOG_PATH
};
