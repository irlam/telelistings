// autopost.js
// Autoposter that can:
//  - In "TheFishy multi" mode: pull fixtures from multiple team ICS feeds (one per team, capped & throttled).
//  - In default mode: pull from a single ICS URL and filter by team names.
/**
 * Telegram Sports TV Bot – Autoposter
 *
 * Reads config.json and posts “what’s on” football fixtures into Telegram channels.
 * Two modes per channel:
 *  1) TheFishy multi-ICS mode (useTheFishyMulti: true):
 *     - Each team has an ICS at https://thefishy.co.uk/calendar/<Team+Name>.
 *     - Only fetch up to multiMaxTeams per run, with multiIcsDelayMs between requests.
 *     - Merge fixtures across teams, dedupe, sort, and post one combined message.
 *     - Be polite: stop fetching if we hit HTTP 429 (rate limit).
 *  2) Single-ICS mode:
 *     - Use cfg.icsUrl or channel.icsUrl.
 *     - Optionally filter fixtures by team names.
 *
 * Uses getFixturesFromIcs(...) from ics_source.js.
 * Sends messages via Telegram Bot API (sendMessage).
 * Logs to autopost.log using logLine().
 *
 * Constraints:
 * - No DB, config from config.json.
 * - Plain text messages (no Markdown formatting).
 * - Keep logic small and testable; add good logging for ops.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { getFixturesFromIcs } = require('./ics_source');
const theSportsDb = require('./thesportsdb');
const liveSoccerTv = require('./livesoccertv');
const lstv = require('./scrapers/lstv');
const tsdb = require('./scrapers/thesportsdb');
const wiki = require('./scrapers/wiki_broadcasters');

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
    throw new Error(`config.json not found at ${CONFIG_PATH}`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

// ---------- Telegram helper ----------

async function sendTelegramMessage(botToken, channelId, text) {
  const url = `https://api.telegram.org/bot${encodeURIComponent(
    botToken
  )}/sendMessage`;

  const payload = {
    chat_id: channelId,
    text: text
    // plain text – no Markdown to avoid escaping headaches
  };

  const resp = await axios.post(url, payload, {
    timeout: 15000
  });

  if (!resp.data || !resp.data.ok) {
    const desc = resp.data && resp.data.description;
    throw new Error(`Telegram sendMessage failed: ${desc || 'unknown error'}`);
  }
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

  const form = new FormData();
  form.append('chat_id', channelId);
  form.append('photo', fs.createReadStream(photoPath));
  if (caption) {
    form.append('caption', caption);
  }

  const resp = await axios.post(url, form, {
    timeout: 30000,
    headers: form.getHeaders()
  });

  if (!resp.data || !resp.data.ok) {
    const desc = resp.data && resp.data.description;
    throw new Error(`Telegram sendPhoto failed: ${desc || 'unknown error'}`);
  }
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
async function buildPosterImageForFixture(fixture, options = {}) {
  // Check if canvas is available
  if (!canvas) {
    logLine('  [Image] Canvas library not available, falling back to text');
    return null;
  }

  const { backgroundPath, footerText = '' } = options;
  
  if (!backgroundPath || !fs.existsSync(backgroundPath)) {
    logLine('  [Image] Background image not found, falling back to text');
    return null;
  }

  try {
    ensureTmpDir();
    
    // Load the background image
    const bgImage = await canvas.loadImage(backgroundPath);
    
    // Create canvas with background dimensions
    const canvasWidth = bgImage.width;
    const canvasHeight = bgImage.height;
    const cvs = canvas.createCanvas(canvasWidth, canvasHeight);
    const ctx = cvs.getContext('2d');
    
    // Draw background
    ctx.drawImage(bgImage, 0, 0, canvasWidth, canvasHeight);
    
    // Add semi-transparent dark overlay for text readability while showing background
    ctx.fillStyle = `rgba(18, 18, 18, ${POSTER_OVERLAY_OPACITY})`;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    
    // Calculate responsive font sizes based on canvas dimensions
    const baseSize = Math.min(canvasWidth, canvasHeight) / 15;
    const titleSize = Math.round(baseSize * 1.2);
    const timeSize = Math.round(baseSize * 1.1);
    const fixtureSize = Math.round(baseSize * 1.5);
    const competitionSize = Math.round(baseSize * 0.9);
    const tvSize = Math.round(baseSize * 0.7);
    const footerSize = Math.round(baseSize * 0.6);
    
    // Calculate maximum text width (canvas width minus padding on both sides)
    const maxTextWidth = canvasWidth * (1 - 2 * TEXT_PADDING_PERCENT);
    const fontFamily = 'Arial, sans-serif';
    
    // Starting Y position
    let y = canvasHeight * 0.12;
    const lineHeight = baseSize * 1.6;
    
    // Title: "SPORTS LISTINGS ON TV"
    drawAutoScaledText(ctx, 'SPORTS LISTINGS ON TV', canvasWidth / 2, y, maxTextWidth, {
      fontStyle: 'bold',
      fontSize: titleSize,
      fontFamily,
      fillStyle: '#ffffff',
      textAlign: 'center'
    });
    
    // Decorative lines under title
    y += lineHeight * 0.3;
    ctx.strokeStyle = '#80cbc4';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(canvasWidth * 0.2, y);
    ctx.lineTo(canvasWidth * 0.8, y);
    ctx.stroke();
    
    y += lineHeight * 1.2;
    
    // Times: "3:00pm UK    10:00am ET"
    const timeUk = fixture.timeUk || '';
    const timeEt = fixture.timeEt || '';
    if (timeUk || timeEt) {
      let timeLine = '';
      if (timeUk) timeLine += `${timeUk} UK`;
      if (timeUk && timeEt) timeLine += '    ';
      if (timeEt) timeLine += `${timeEt} ET`;
      drawAutoScaledText(ctx, timeLine, canvasWidth / 2, y, maxTextWidth, {
        fontStyle: '',
        fontSize: timeSize,
        fontFamily,
        fillStyle: '#80cbc4',
        textAlign: 'center'
      });
      y += lineHeight * 1.3;
    }
    
    // Fixture title - prefer matchTitle, fall back to constructing from home/away teams
    let fixtureText = '';
    if (fixture.matchTitle) {
      fixtureText = fixture.matchTitle;
    } else {
      const homeTeam = (fixture.homeTeam || '').toUpperCase();
      const awayTeam = (fixture.awayTeam || '').toUpperCase();
      if (homeTeam && awayTeam) {
        fixtureText = `${homeTeam} v ${awayTeam}`;
      } else if (homeTeam) {
        fixtureText = homeTeam;
      }
    }
    if (fixtureText) {
      drawAutoScaledText(ctx, fixtureText, canvasWidth / 2, y, maxTextWidth, {
        fontStyle: 'bold',
        fontSize: fixtureSize,
        fontFamily,
        fillStyle: '#ffffff',
        textAlign: 'center'
      });
    }
    y += lineHeight * 1.1;
    
    // Competition
    if (fixture.competition) {
      drawAutoScaledText(ctx, fixture.competition, canvasWidth / 2, y, maxTextWidth, {
        fontStyle: 'italic',
        fontSize: competitionSize,
        fontFamily,
        fillStyle: '#aaaaaa',
        textAlign: 'center'
      });
      y += lineHeight;
    }
    
    y += lineHeight * 0.5;
    
    // TV by Region list
    const tvByRegion = fixture.tvByRegion || [];
    if (tvByRegion.length > 0) {
      // Calculate layout for two-column region/channel display
      const startX = canvasWidth * TEXT_PADDING_PERCENT;
      const availableWidth = maxTextWidth;
      
      // Measure all region names to find the longest one
      ctx.font = `${tvSize}px ${fontFamily}`;
      let maxRegionWidth = 0;
      for (const { region } of tvByRegion.slice(0, MAX_DISPLAYED_TV_REGIONS)) {
        const regionWidth = ctx.measureText(region || '').width;
        if (regionWidth > maxRegionWidth) {
          maxRegionWidth = regionWidth;
        }
      }
      
      // Add padding between region and channel
      const columnGap = tvSize * 1.5;
      const regionColumnWidth = maxRegionWidth + columnGap;
      const channelStartX = startX + regionColumnWidth;
      const channelMaxWidth = availableWidth - regionColumnWidth;
      
      for (const { region, channel } of tvByRegion.slice(0, MAX_DISPLAYED_TV_REGIONS)) {
        // Draw region (left-aligned, auto-scaled if needed)
        drawAutoScaledText(ctx, region || '', startX, y, regionColumnWidth - columnGap, {
          fontStyle: '',
          fontSize: tvSize,
          fontFamily,
          fillStyle: '#80cbc4',
          textAlign: 'left'
        });
        
        // Draw channel (left-aligned after region, auto-scaled if needed)
        drawAutoScaledText(ctx, channel || '', channelStartX, y, channelMaxWidth, {
          fontStyle: '',
          fontSize: tvSize,
          fontFamily,
          fillStyle: '#ffffff',
          textAlign: 'left'
        });
        
        y += lineHeight * 0.85;
      }
      
      if (tvByRegion.length > MAX_DISPLAYED_TV_REGIONS) {
        drawAutoScaledText(ctx, `... and ${tvByRegion.length - MAX_DISPLAYED_TV_REGIONS} more`, startX, y, availableWidth, {
          fontStyle: '',
          fontSize: tvSize,
          fontFamily,
          fillStyle: '#aaaaaa',
          textAlign: 'left'
        });
        y += lineHeight * 0.85;
      }
    } else {
      drawAutoScaledText(ctx, 'TV details TBC', canvasWidth / 2, y, maxTextWidth, {
        fontStyle: '',
        fontSize: tvSize,
        fontFamily,
        fillStyle: '#aaaaaa',
        textAlign: 'center'
      });
    }
    
    // Footer at the bottom
    if (footerText) {
      drawAutoScaledText(ctx, footerText, canvasWidth / 2, canvasHeight - canvasHeight * 0.05, maxTextWidth, {
        fontStyle: '',
        fontSize: footerSize,
        fontFamily,
        fillStyle: '#888888',
        textAlign: 'center'
      });
    }
    
    // Generate unique filename and save
    const timestamp = Date.now();
    const teamName = fixture.homeTeam || 'fixture';
    const sanitizedTeamName = teamName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const homeSlug = sanitizedTeamName.slice(0, 20);
    const outputPath = path.join(TMP_DIR, `poster-${homeSlug}-${timestamp}.png`);
    
    const buffer = cvs.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);
    
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
 * Parse a TheFishy ICS summary to extract home and away teams.
 * TheFishy summaries have formats like:
 * - "Crystal Palace (away)" - our team is playing away at Crystal Palace
 * - "West Ham (home)" - our team is playing at home against West Ham
 * 
 * @param {string} summary - The ICS event summary (e.g., "Crystal Palace (away)")
 * @param {string} ourTeam - The team label for this feed (e.g., "Man Utd")
 * @returns {{ homeTeam: string, awayTeam: string }}
 */
function parseFishySummary(summary, ourTeam) {
  const text = (summary || '').trim();
  const team = (ourTeam || '').trim();
  
  // Handle edge cases when summary or team is missing
  if (!text) {
    return { homeTeam: team, awayTeam: '' };
  }
  if (!team) {
    // No team provided - just clean the summary text
    return { homeTeam: cleanTeamName(text), awayTeam: '' };
  }
  
  // Check for "(away)" or "(a)" at the end - our team is away
  const awayMatch = text.match(/^(.+?)\s*\(\s*(?:away|a)\s*\)\s*$/i);
  if (awayMatch) {
    const opponent = cleanTeamName(awayMatch[1]);
    return {
      homeTeam: opponent,
      awayTeam: team
    };
  }
  
  // Check for "(home)" or "(h)" at the end - our team is home
  const homeMatch = text.match(/^(.+?)\s*\(\s*(?:home|h)\s*\)\s*$/i);
  if (homeMatch) {
    const opponent = cleanTeamName(homeMatch[1]);
    return {
      homeTeam: team,
      awayTeam: opponent
    };
  }
  
  // Fallback: doesn't match TheFishy format, treat summary as opponent with ourTeam as home
  return {
    homeTeam: team,
    awayTeam: cleanTeamName(text)
  };
}

/**
 * Parse team names from a fixture summary.
 * Handles various ICS summary formats:
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
 * @param {Object} fixture - Basic fixture object with start, summary, tvChannel, teamLabel, etc.
 * @returns {Object} Adapted fixture with poster fields
 */
function adaptFixtureForPoster(fixture) {
  const start = fixture.start instanceof Date ? fixture.start : new Date(fixture.start);
  
  // Format times in UK and US Eastern timezones
  const timeUk = formatTimeInZone(start, 'Europe/London');
  const timeEt = formatTimeInZone(start, 'America/New_York');
  
  // Parse home and away teams from summary
  // If teamLabel is present (TheFishy multi-ICS mode), use parseFishySummary
  // Otherwise fall back to parseTeamsFromSummary for "Home v Away" style summaries
  let homeTeam, awayTeam;
  if (fixture.teamLabel) {
    const parsed = parseFishySummary(fixture.summary, fixture.teamLabel);
    homeTeam = parsed.homeTeam;
    awayTeam = parsed.awayTeam;
  } else {
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
  let tvByRegion = fixture.tvByRegion || [];
  
  if (tvByRegion.length === 0 && fixture.tvChannel) {
    // Single channel - assume UK region
    tvByRegion = [{ region: 'UK', channel: fixture.tvChannel }];
  }
  
  return {
    ...fixture,
    date: start,
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

// ---------- TheFishy helpers ----------

// Build a TheFishy ICS URL from a team label, e.g.
//   "Man Utd"  -> https://thefishy.co.uk/calendar/Man+Utd
function buildTheFishyIcsUrl(teamLabel) {
  const trimmed = String(teamLabel || '').trim();
  if (!trimmed) return null;

  // Keep letters/numbers/spaces, drop other punctuation from the label.
  const cleaned = trimmed.replace(/[^A-Za-z0-9\s]/g, '');
  // Spaces => plus
  const plus = cleaned.replace(/\s+/g, '+');

  return `https://thefishy.co.uk/calendar/${plus}`;
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
  // If fixture already has a tvChannel (e.g. from ICS source or TheSportsDB), return it
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
  const timezone = cfg.timezone || 'Europe/London';
  const daysAhead = cfg.icsDaysAhead && Number.isFinite(cfg.icsDaysAhead)
    ? cfg.icsDaysAhead
    : 7;

  // --- MODE 1: TheFishy multi-ICS (one ICS per team, capped & throttled) ---
  if (channel.useTheFishyMulti) {
    const allTeamEntries = channel.teams || [];
    if (!allTeamEntries.length) {
      throw new Error(
        'useTheFishyMulti is true but this channel has no teams configured'
      );
    }

    // Cap how many team ICS feeds we hit in a single run
    const maxTeams = Number.isFinite(channel.multiMaxTeams)
      ? channel.multiMaxTeams
      : 10; // default: 10 teams per run

    const delayMs = Number.isFinite(channel.multiIcsDelayMs)
      ? channel.multiIcsDelayMs
      : 1500; // default: 1.5s between requests

    const teams = allTeamEntries.slice(0, maxTeams);

    logLine(
      `Channel "${channel.label || channel.id}": TheFishy multi-ICS mode – using first ${teams.length} of ${allTeamEntries.length} teams (maxTeams=${maxTeams}, delay=${delayMs}ms)`
    );

    const allFixtures = [];
    let hitRateLimit = false;

    for (let i = 0; i < teams.length; i++) {
      const t = teams[i];
      const teamLabel = t.label || t.slug || '';
      if (!teamLabel) {
        logLine(`  Skipping team with no label: ${JSON.stringify(t)}`);
        continue;
      }

      const icsUrl = buildTheFishyIcsUrl(teamLabel);
      if (!icsUrl) {
        logLine(`  Skipping team "${teamLabel}" – could not build ICS URL`);
        continue;
      }

      try {
        logLine(`  Fetching ICS for team "${teamLabel}" from ${icsUrl}`);
        // No extra filtering here; the feed is already per-team.
        const fixtures = await getFixturesFromIcs(
          icsUrl,
          timezone,
          [],
          daysAhead
        );

        fixtures.forEach((f) => {
          allFixtures.push({
            ...f,
            teamLabel
          });
        });

        logLine(
          `  -> ${fixtures.length} fixtures fetched for team "${teamLabel}"`
        );
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        const status = err && err.response && err.response.status;
        logLine(
          `  ERROR fetching ICS for team "${teamLabel}": ${msg}`
        );

        // If TheFishy / Cloudflare gives us 429, stop hammering them this run.
        if (status === 429) {
          logLine(
            '  Hit HTTP 429 (Too Many Requests) – stopping further ICS requests for this run.'
          );
          hitRateLimit = true;
          break;
        }
      }

      // Be polite: small delay between requests
      if (i < teams.length - 1) {
        await sleep(delayMs);
      }
    }

    if (!allFixtures.length) {
      if (hitRateLimit) {
        logLine(
          `Channel "${channel.label || channel.id}": no fixtures collected because of rate limiting.`
        );
      } else {
        logLine(
          `Channel "${channel.label || channel.id}": no fixtures collected from TheFishy multi-ICS.`
        );
      }
      return { text: '', matchCount: 0 };
    }

    // Deduplicate by (startTime + summary) in case overlaps
    const seen = new Set();
    const merged = [];

    for (const f of allFixtures) {
      const startIso =
        f.start instanceof Date ? f.start.toISOString() : new Date(f.start).toISOString();
      const key = `${startIso}|${f.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(f);
    }

    merged.sort((a, b) => {
      const sa =
        a.start instanceof Date ? a.start.getTime() : new Date(a.start).getTime();
      const sb =
        b.start instanceof Date ? b.start.getTime() : new Date(b.start).getTime();
      return sa - sb;
    });

    // Try to enrich fixtures with TV info from TheSportsDB (if API key configured)
    if (cfg.theSportsDbApiKey) {
      logLine(`  Attempting to enrich fixtures with TheSportsDB TV info...`);
      for (let i = 0; i < merged.length; i++) {
        const f = merged[i];
        if (!f.tvChannel && f.teamLabel) {
          merged[i] = await enrichFixtureWithTheSportsDb(cfg, f, f.teamLabel);
          // Small delay to be polite to TheSportsDB API
          if (i < merged.length - 1) {
            await sleep(300);
          }
        }
      }
    }

    // If posterStyle is enabled, return fixtures array for individual poster messages
    if (channel.posterStyle) {
      // First, parse team names from summaries for fixtures that need it
      for (let i = 0; i < merged.length; i++) {
        const f = merged[i];
        // Parse teams if not already set
        if (!f.homeTeam || !f.awayTeam) {
          if (f.teamLabel) {
            const parsed = parseFishySummary(f.summary, f.teamLabel);
            f.homeTeam = parsed.homeTeam;
            f.awayTeam = parsed.awayTeam;
          } else {
            const parsed = parseTeamsFromSummary(f.summary);
            f.homeTeam = parsed.homeTeam;
            f.awayTeam = parsed.awayTeam;
          }
        }
      }

      // Enrich fixtures with TV info using the aggregator (preferred) or legacy methods
      // The aggregator combines data from all sources: TSDB, LSTV, BBC, Sky, TNT, LFOTV, Wiki
      if (cfg.liveSoccerTvEnabled !== false || cfg.useAggregator !== false) {
        logLine(`  Enriching fixtures with TV data (${tvAggregator ? 'aggregator' : 'legacy'})...`);
        for (let i = 0; i < merged.length; i++) {
          const f = merged[i];
          if ((!f.tvByRegion || f.tvByRegion.length === 0) && f.homeTeam && f.awayTeam) {
            merged[i] = await enrichFixtureWithAggregator(cfg, f);
            // Delay between requests to be polite
            if (i < merged.length - 1) {
              await sleep(1000);
            }
          }
        }
      }

      // Enrich fixtures with TV channel info from overrides (as fallback/override)
      for (let i = 0; i < merged.length; i++) {
        const tvChannel = getTvChannelForFixture(merged[i], channel);
        if (tvChannel) {
          merged[i].tvChannel = tvChannel;
        }
      }
      
      return {
        text: '',
        matchCount: merged.length,
        fixtures: merged,
        posterStyle: true
      };
    }

    const lines = merged.map((f) => {
      const dt = f.start instanceof Date ? f.start : new Date(f.start);
      const when = dt.toLocaleString('en-GB', {
        timeZone: timezone,
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
      });

      let line = `${when} – ${f.summary}`;
      if (f.location) line += ` @ ${f.location}`;
      if (f.teamLabel) line += ` [${f.teamLabel}]`;

      // Add TV channel if available
      const tvChannel = getTvChannelForFixture(f, channel);
      if (tvChannel) line += ` (TV: ${tvChannel})`;

      return line;
    });

    const header = `Upcoming fixtures – ${channel.label || channel.id} (next ${daysAhead} day(s))`;
    const text = `${header}\n\n${lines.join('\n')}`;

    return {
      text,
      matchCount: merged.length
    };
  }

  // --- MODE 2: Single ICS URL (global or per-channel), filtered by teams ----
  const icsUrl = channel.icsUrl || cfg.icsUrl;
  if (!icsUrl) {
    throw new Error(
      `No ICS URL configured (channel "${channel.label || channel.id}")`
    );
  }

  const teamNames = (channel.teams || []).map(
    (t) => t.label || t.slug || ''
  );

  logLine(
    `Channel "${channel.label || channel.id}": single ICS mode, url=${icsUrl}, daysAhead=${daysAhead}, teamFilters=${teamNames.length}`
  );

  const fixtures = await getFixturesFromIcs(
    icsUrl,
    timezone,
    teamNames,
    daysAhead
  );

  if (!fixtures.length) {
    return { text: '', matchCount: 0 };
  }

  // Try to enrich fixtures with TV info from TheSportsDB (if API key configured)
  if (cfg.theSportsDbApiKey && teamNames.length) {
    logLine(`  Attempting to enrich fixtures with TheSportsDB TV info...`);
    for (let i = 0; i < fixtures.length; i++) {
      const f = fixtures[i];
      if (!f.tvChannel) {
        // Try to find a matching team for this fixture using word boundary matching
        const summary = (f.summary || '').toLowerCase();
        const matchedTeam = teamNames.find(t => {
          if (!t || t.length < 3) return false;
          const teamLower = t.toLowerCase();
          // Escape special regex characters
          const escaped = teamLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Match with word boundaries
          const regex = new RegExp(`(?:^|[^a-z])${escaped}(?:$|[^a-z])`, 'i');
          return regex.test(summary);
        });
        if (matchedTeam) {
          fixtures[i] = await enrichFixtureWithTheSportsDb(cfg, f, matchedTeam);
          // Small delay to be polite to TheSportsDB API
          if (i < fixtures.length - 1) {
            await sleep(300);
          }
        }
      }
    }
  }

  // If posterStyle is enabled, return fixtures array for individual poster messages
  if (channel.posterStyle) {
    // First, parse team names from summaries for fixtures that need it
    for (let i = 0; i < fixtures.length; i++) {
      const f = fixtures[i];
      // Parse teams if not already set
      if (!f.homeTeam || !f.awayTeam) {
        const parsed = parseTeamsFromSummary(f.summary);
        f.homeTeam = parsed.homeTeam;
        f.awayTeam = parsed.awayTeam;
      }
    }

    // Enrich fixtures with TV info using the aggregator (preferred) or legacy methods
    if (cfg.liveSoccerTvEnabled !== false || cfg.useAggregator !== false) {
      logLine(`  Enriching fixtures with TV data (${tvAggregator ? 'aggregator' : 'legacy'})...`);
      for (let i = 0; i < fixtures.length; i++) {
        const f = fixtures[i];
        if ((!f.tvByRegion || f.tvByRegion.length === 0) && f.homeTeam && f.awayTeam) {
          fixtures[i] = await enrichFixtureWithAggregator(cfg, f);
          // Delay between requests to be polite
          if (i < fixtures.length - 1) {
            await sleep(1000);
          }
        }
      }
    }

    // Enrich fixtures with TV channel info from overrides (as fallback/override)
    for (let i = 0; i < fixtures.length; i++) {
      const tvChannel = getTvChannelForFixture(fixtures[i], channel);
      if (tvChannel) {
        fixtures[i].tvChannel = tvChannel;
      }
    }
    
    return {
      text: '',
      matchCount: fixtures.length,
      fixtures: fixtures,
      posterStyle: true
    };
  }

  const lines = fixtures.map((f) => {
    const dt = f.start instanceof Date ? f.start : new Date(f.start);
    const when = dt.toLocaleString('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });

    let line = `${when} – ${f.summary}`;
    if (f.location) line += ` @ ${f.location}`;

    // Add TV channel if available
    const tvChannel = getTvChannelForFixture(f, channel);
    if (tvChannel) line += ` (TV: ${tvChannel})`;

    return line;
  });

  const header = `Upcoming fixtures from ICS – ${channel.label || channel.id} (next ${daysAhead} day(s))`;
  const text = `${header}\n\n${lines.join('\n')}`;

  return {
    text,
    matchCount: fixtures.length
  };
}

// ---------- main runner ----------

async function runOnce() {
  const cfg = loadConfig();

  const botToken = cfg.botToken;
  if (!botToken) {
    throw new Error('botToken not set in config.json');
  }

  const channels = cfg.channels || [];
  if (!channels.length) {
    throw new Error('No channels configured in config.json');
  }

  const results = [];
  let totalMatches = 0;
  let sendCount = 0;

  for (const channel of channels) {
    const label = channel.label || channel.id || '(unknown channel)';

    try {
      const buildResult = await buildChannelMessage(cfg, channel);
      const { text, matchCount, posterStyle, fixtures } = buildResult;

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

      // Handle poster-style messages (one message per fixture)
      if (posterStyle && fixtures && fixtures.length > 0) {
        logLine(
          `Channel "${label}": posting ${fixtures.length} fixtures in poster style.`
        );
        
        // Get footer text from config (empty/whitespace-only means no footer)
        const posterFooterText = (cfg.posterFooterText || '').trim();
        const showFooter = Boolean(posterFooterText);
        
        // Check if we should use image posters
        const backgroundPath = getBackgroundImagePath();
        const useImagePosters = Boolean(backgroundPath);
        
        if (useImagePosters) {
          logLine(`  Using image-based posters with background: ${path.basename(backgroundPath)}`);
        }
        
        let postersSent = 0;
        for (const fixture of fixtures) {
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
                footerText: posterFooterText
              });
            }
            
            if (posterImagePath) {
              // Send image poster
              const caption = posterFooterText || '';
              await sendTelegramPhoto(botToken, channel.id, posterImagePath, caption);
              logLine(`    -> Sent as image poster`);
            } else {
              // Fall back to text poster
              const posterText = formatFixturePoster(posterFixture, {
                showFooter: showFooter,
                footerText: posterFooterText || DEFAULT_FOOTER_TEXT
              });
              await sendTelegramMessage(botToken, channel.id, posterText);
              logLine(`    -> Sent as text poster`);
            }
            
            postersSent++;
            
            // Small delay between messages to avoid rate limiting
            if (postersSent < fixtures.length) {
              await sleep(500);
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
          sent: postersSent > 0,
          matchCount,
          posterCount: postersSent
        });
        
        totalMatches += matchCount;
        if (postersSent > 0) sendCount += 1;
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

      await sendTelegramMessage(botToken, channel.id, text);
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
  adaptFixtureForPoster,
  parseTeamsFromSummary,
  parseFishySummary,
  cleanTeamName,
  formatTimeInZone,
  getBackgroundImagePath,
  buildPosterImageForFixture,
  sendTelegramPhoto,
  enrichFixtureWithLiveSoccerTv,
  enrichFixtureWithAggregator,
  enrichFixtureWithAllSources,
  DEFAULT_FOOTER_TEXT,
  CONFIG_PATH,
  LOG_PATH
};
