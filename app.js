// app.js
// Admin GUI + HTTP cron endpoint for your Telegram Sports TV bot (ICS-based).
/**
 * Telegram Sports TV Bot – Admin GUI
 *
 * Node.js + Express admin panel for a Telegram bot that posts football fixtures.
 * - Reads & writes config.json (channels, teams, settings).
 * - Pages: /admin/channels, /admin/teams, /admin/settings, /admin/logs, /admin/help.
 * - Has a button to trigger /admin/post-now (calls runOnce from autopost.js).
 * - Has a button /admin/import-uk-teams to run import_uk_teams.js.
 * - Exposes /cron/run?key=CRON_SECRET for Plesk scheduled tasks.
 *
 * Constraints:
 * - No DB, config stored in config.json.
 * - Basic auth via express-basic-auth.
 * - Keep UI simple (vanilla HTML/CSS, no frontend framework).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const basicAuth = require('express-basic-auth');
const multer = require('multer');
const axios = require('axios');
const { execFile } = require('child_process');
const { runOnce, CONFIG_PATH, LOG_PATH } = require('./autopost');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for background image upload
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    // Always save as poster-background with original extension
    const ext = path.extname(file.originalname);
    cb(null, 'poster-background' + ext);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Only image files (jpg, jpeg, png, gif) are allowed'));
  }
});

// --------- helpers ---------

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // minimal default
    return {
      botToken: '',
      timezone: 'Europe/London',
      icsUrl: '',
      icsDaysAhead: 1,
      channels: []
    };
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Simple in-memory rate limiter for file operations
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // max 10 requests per minute

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }
  
  const entry = rateLimitStore.get(ip);
  
  // Reset if window has passed
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + RATE_LIMIT_WINDOW_MS;
    return next();
  }
  
  // Check if limit exceeded
  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).send('Too many requests. Please wait a minute and try again.');
  }
  
  entry.count++;
  return next();
}

function renderLayout(title, bodyHtml) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 960px; margin: 0 auto; padding: 20px; background:#121212; color:#f5f5f5; }
    a { color: #80cbc4; text-decoration: none; }
    a:hover { text-decoration: underline; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; background:#1e1e1e; }
    th, td { border: 1px solid #333; padding: 6px; text-align: left; font-size:14px; }
    th { background:#262626; }
    input[type=text], input[type=password], input[type=number], textarea, select {
      width: 100%;
      padding: 6px;
      box-sizing: border-box;
      border-radius: 4px;
      border: 1px solid #444;
      background:#1b1b1b;
      color:#f5f5f5;
      font-size:14px;
    }
    textarea { min-height: 180px; font-family: monospace; }
    button {
      padding: 6px 12px;
      border-radius: 6px;
      border: none;
      background:#00b894;
      color:#000;
      cursor:pointer;
      font-size:14px;
    }
    button:hover { background:#00d6aa; }
    .nav a { margin-right: 1rem; }
    .muted { color:#aaa; font-size: 12px; }
    .page-title { margin-bottom: 0.5rem; }
    .card { background:#1b1b1b; padding: 16px; border-radius: 8px; margin-bottom: 16px; box-shadow:0 2px 8px rgba(0,0,0,0.5); }
    code { background:#222; padding:2px 4px; border-radius:4px; }
    pre { background:#111; padding:10px; border-radius:8px; overflow-x:auto; font-size:12px; }
  </style>
</head>
<body>
  <h1 class="page-title">Telegram Sports TV Bot</h1>
  <p class="nav">
    <a href="/admin/channels">Channels</a>
    <a href="/admin/teams">Teams</a>
    <a href="/admin/settings">Settings</a>
    <a href="/admin/scrapers">Scrapers</a>
    <a href="/admin/auto-test">Auto-Test</a>
    <a href="/admin/results">Results</a>
    <a href="/admin/environment">Environment</a>
    <a href="/admin/logs">Logs</a>
    <a href="/admin/help">Help</a>
  </p>
  ${bodyHtml}
</body>
</html>`;
}

// --------- middleware ---------

app.use(express.urlencoded({ extended: true }));

// Basic auth on /admin/*
app.use(
  '/admin',
  basicAuth({
    users: { admin: process.env.ADMIN_PASSWORD || 'Subaru5554346' },
    challenge: true
  })
);

app.get('/', (req, res) => {
  res.redirect('/admin/channels');
});

// --------- Channels page ---------

// Number of columns in the channels table
const CHANNELS_TABLE_COLS = 6;

app.get('/admin/channels', (req, res) => {
  const cfg = loadConfig();
  const channels = cfg.channels || [];
  const defaultPosterStyle = cfg.defaultPosterStyle || false;

  const rows = channels
    .map((ch, idx) => {
      const teamCount = (ch.teams || []).length;
      const layoutStyle = ch.posterStyle ? 'Poster' : 'List';
      return `<tr>
        <td>${idx + 1}</td>
        <td>${escapeHtml(ch.label || '')}</td>
        <td>${escapeHtml(ch.id || '')}</td>
        <td>${teamCount}</td>
        <td><span class="layout-badge layout-${layoutStyle.toLowerCase()}">${layoutStyle}</span></td>
        <td>
          <a href="/admin/channels/edit?index=${idx}">Edit</a>
          <form method="post" action="/admin/channels/delete" style="display:inline; margin-left:8px;">
            <input type="hidden" name="index" value="${idx}">
            <button type="submit" onclick="return confirm('Delete this channel?');">Delete</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');

  const body = `
  <style>
    .layout-badge { padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }
    .layout-poster { background: #4a90d9; color: #fff; }
    .layout-list { background: #555; color: #fff; }
  </style>
  <div class="card">
    <h2>Channels</h2>
    <p>Each channel has its own Telegram channel ID and list of teams. The autoposter will send one message per configured channel.</p>

    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Label</th>
          <th>Telegram Channel ID</th>
          <th>Teams</th>
          <th>Layout</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${
          rows ||
          `<tr><td colspan="${CHANNELS_TABLE_COLS}">No channels yet. Add one below.</td></tr>`
        }
      </tbody>
    </table>

    <h3>Add Channel</h3>
    <form method="post" action="/admin/channels/add">
      <p>
        <label>Label (e.g. "UK Football")<br>
        <input type="text" name="label" required></label>
      </p>
      <p>
        <label>Telegram Channel username / ID<br>
        <input type="text" name="id" required value="@"></label>
        <span class="muted">For a public channel, this is its username, e.g. <code>@FootballOnTvUK</code>.</span>
      </p>
      <p>
        <label>
          <input type="checkbox" name="posterStyle" value="true" id="posterStyleAdd" ${defaultPosterStyle ? 'checked' : ''}>
          Use poster-style layout (one message per fixture with TV info)
        </label>
        <span class="muted">If unchecked, uses compact list layout (all fixtures in one message).</span>
      </p>
      <p><button type="submit">Add Channel</button></p>
    </form>
  </div>
  `;

  res.send(renderLayout('Channels - Telegram Sports TV Bot', body));
});

app.get('/admin/channels/edit', (req, res) => {
  const cfg = loadConfig();
  const channels = cfg.channels || [];
  const idx = parseInt(req.query.index, 10);

  if (Number.isNaN(idx) || idx < 0 || idx >= channels.length) {
    return res.redirect('/admin/channels');
  }

  const ch = channels[idx];

  const body = `
  <div class="card">
    <h2>Edit Channel: ${escapeHtml(ch.label || ch.id)}</h2>

    <form method="post" action="/admin/channels/update">
      <input type="hidden" name="index" value="${idx}">
      <p>
        <label>Label<br>
        <input type="text" name="label" value="${escapeHtml(ch.label || '')}" required></label>
      </p>
      <p>
        <label>Telegram Channel username / ID<br>
        <input type="text" name="id" value="${escapeHtml(ch.id || '')}" required></label>
      </p>
      <p>
        <label>
          <input type="checkbox" name="posterStyle" value="true" id="posterStyleEdit" ${ch.posterStyle ? 'checked' : ''}>
          Use poster-style layout
        </label>
        <span class="muted">One message per fixture with visual TV listing. Otherwise uses compact list format.</span>
      </p>
      <p><button type="submit">Save Changes</button></p>
    </form>

    <p><a href="/admin/channels">← Back to Channels</a></p>
  </div>
  `;

  res.send(renderLayout('Edit Channel - Telegram Sports TV Bot', body));
});

app.post('/admin/channels/update', (req, res) => {
  const { index, label, id, posterStyle } = req.body;
  const idx = parseInt(index, 10);
  const cfg = loadConfig();
  cfg.channels = cfg.channels || [];

  if (!Number.isNaN(idx) && idx >= 0 && idx < cfg.channels.length) {
    const ch = cfg.channels[idx];
    ch.label = (label || '').trim();
    ch.id = (id || '').trim();
    ch.posterStyle = posterStyle === 'true';
    saveConfig(cfg);
  }

  res.redirect('/admin/channels');
});

app.post('/admin/channels/add', (req, res) => {
  const { label, id, posterStyle } = req.body;
  const cfg = loadConfig();
  cfg.channels = cfg.channels || [];

  cfg.channels.push({
    label: (label || '').trim(),
    id: (id || '').trim(),
    posterStyle: posterStyle === 'true',
    teams: []
  });

  saveConfig(cfg);
  res.redirect('/admin/channels');
});

app.post('/admin/channels/delete', (req, res) => {
  const idx = parseInt(req.body.index, 10);
  const cfg = loadConfig();
  cfg.channels = cfg.channels || [];

  if (!Number.isNaN(idx) && idx >= 0 && idx < cfg.channels.length) {
    cfg.channels.splice(idx, 1);
    saveConfig(cfg);
  }

  res.redirect('/admin/channels');
});

// --------- Teams page (per channel) ---------

app.get('/admin/teams', (req, res) => {
  const cfg = loadConfig();
  const channels = cfg.channels || [];

  if (!channels.length) {
    const body = `
    <div class="card">
      <h2>Teams</h2>
      <p>No channels configured yet. <a href="/admin/channels">Add a channel first</a>.</p>
    </div>`;
    return res.send(renderLayout('Teams - Telegram Sports TV Bot', body));
  }

  let channelIndex = parseInt(req.query.channel, 10);
  if (
    Number.isNaN(channelIndex) ||
    channelIndex < 0 ||
    channelIndex >= channels.length
  ) {
    channelIndex = 0;
  }

  const channel = channels[channelIndex];
  const teams = channel.teams || [];

  const channelOptions = channels
    .map(
      (ch, idx) =>
        `<option value="${idx}" ${
          idx === channelIndex ? 'selected' : ''
        }>${escapeHtml(ch.label || ch.id)}</option>`
    )
    .join('');

  const rows = teams
    .map(
      (t, idx) => `<tr>
        <td>${idx + 1}</td>
        <td>${escapeHtml(t.label)}</td>
        <td>${escapeHtml(t.country || '')}</td>
        <td>${escapeHtml(t.slug || '')}</td>
        <td>
          <form method="post" action="/admin/teams/delete" style="display:inline;">
            <input type="hidden" name="channelIndex" value="${channelIndex}">
            <input type="hidden" name="index" value="${idx}">
            <button type="submit">Delete</button>
          </form>
        </td>
      </tr>`
    )
    .join('');

  const body = `
  <div class="card">
    <h2>Teams</h2>

    <form method="get" action="/admin/teams">
      <p>
        <label>Channel<br>
        <select name="channel" onchange="this.form.submit()">
          ${channelOptions}
        </select></label>
      </p>
    </form>

    <p>Currently editing teams for <strong>${escapeHtml(
      channel.label || channel.id
    )}</strong>.</p>

    <p class="muted">The ICS feed is filtered to fixtures where the summary contains one of these team names (unless you leave the list empty).</p>

    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Label</th>
          <th>Country (optional)</th>
          <th>Slug (optional)</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${
          rows ||
          '<tr><td colspan="5">No teams yet. Add some below.</td></tr>'
        }
      </tbody>
    </table>

    <h3>Add Team to this Channel</h3>
    <form method="post" action="/admin/teams/add">
      <input type="hidden" name="channelIndex" value="${channelIndex}">
      <p>
        <label>Label (team name as it appears in ICS summary)<br>
        <input type="text" name="label" required></label>
      </p>
      <p>
        <label>Country slug (optional, e.g. <code>england</code>)<br>
        <input type="text" name="country"></label>
      </p>
      <p>
        <label>Team slug (optional)<br>
        <input type="text" name="slug"></label>
      </p>
      <p><button type="submit">Add Team</button></p>
    </form>
  </div>
  `;

  res.send(renderLayout('Teams - Telegram Sports TV Bot', body));
});

app.post('/admin/teams/add', (req, res) => {
  const { channelIndex, label, country, slug } = req.body;
  const idx = parseInt(channelIndex, 10);
  const cfg = loadConfig();
  cfg.channels = cfg.channels || [];

  if (!Number.isNaN(idx) && idx >= 0 && idx < cfg.channels.length) {
    const ch = cfg.channels[idx];
    ch.teams = ch.teams || [];
    ch.teams.push({
      label: (label || '').trim(),
      country: (country || '').trim().toLowerCase() || '',
      slug: (slug || '').trim().toLowerCase() || ''
    });
    saveConfig(cfg);
  }

  res.redirect(`/admin/teams?channel=${idx}`);
});

app.post('/admin/teams/delete', (req, res) => {
  const idx = parseInt(req.body.index, 10);
  const channelIndex = parseInt(req.body.channelIndex, 10);
  const cfg = loadConfig();
  cfg.channels = cfg.channels || [];

  if (
    !Number.isNaN(channelIndex) &&
    channelIndex >= 0 &&
    channelIndex < cfg.channels.length
  ) {
    const ch = cfg.channels[channelIndex];
    ch.teams = ch.teams || [];
    if (!Number.isNaN(idx) && idx >= 0 && idx < ch.teams.length) {
      ch.teams.splice(idx, 1);
      saveConfig(cfg);
    }
  }

  res.redirect(`/admin/teams?channel=${channelIndex}`);
});

// --------- Settings + Manual Post + Import UK Teams ---------

app.get('/admin/settings', (req, res) => {
  const cfg = loadConfig();

  const body = `
  <div class="card">
    <h2>Settings</h2>

    <form method="post" action="/admin/settings">
      <p>
        <label>Bot Token (from BotFather)<br>
        <input type="text" name="botToken" value="${escapeHtml(
          cfg.botToken || ''
        )}" required></label>
        <span class="muted">Keep this secret. Don't commit <code>config.json</code> to Git.</span>
      </p>
      <p>
        <label>Timezone (IANA name)<br>
        <input type="text" name="timezone" value="${escapeHtml(
          cfg.timezone || 'Europe/London'
        )}" required></label>
        <span class="muted">e.g. <code>Europe/London</code>, <code>Europe/Paris</code>.</span>
      </p>
      <p>
        <label>ICS URL (fixtures calendar)<br>
        <input type="text" name="icsUrl" value="${escapeHtml(
          cfg.icsUrl || ''
        )}" required></label>
        <span class="muted">This should point to a .ics feed with football fixtures (e.g. a subscription calendar or TheFishy team calendar).</span>
      </p>
      <p>
        <label>Days ahead to include<br>
        <input type="number" name="icsDaysAhead" min="1" max="30" value="${escapeHtml(
          String(cfg.icsDaysAhead || 1)
        )}"></label>
        <span class="muted">For example, 1 = today only, 7 = next week.</span>
      </p>
      <p>
        <label>TheSportsDB API Key (optional)<br>
        <input type="text" name="theSportsDbApiKey" value="${escapeHtml(
          cfg.theSportsDbApiKey || ''
        )}"></label>
        <span class="muted">Get a key from <a href="https://www.thesportsdb.com/api.php" target="_blank">thesportsdb.com</a>. Used to fetch TV channel info for fixtures. Leave blank to disable.</span>
      </p>
      <p>
        <label>
          <input type="checkbox" name="liveSoccerTvEnabled" value="true" id="liveSoccerTvEnabled" ${cfg.liveSoccerTvEnabled !== false ? 'checked' : ''}>
          Enable LiveSoccerTV scraper for worldwide TV channel listings
        </label>
        <span class="muted">When enabled, the bot will call a remote VPS scraper service to get TV channel listings by country/region for each fixture. Results are cached for 4 hours.</span>
      </p>
      <p class="muted" style="margin-left: 24px;">
        <strong>Note:</strong> LiveSoccerTV scraping now runs on a remote VPS instead of using local Puppeteer/Chrome. 
        The remote service URL and API key are configured via environment variables 
        (<code>LSTV_SCRAPER_URL</code> and <code>LSTV_SCRAPER_KEY</code>). 
        <a href="/admin/test-lstv">Test the scraper →</a>
      </p>
      <p>
        <label>
          <input type="checkbox" name="defaultPosterStyle" value="true" id="defaultPosterStyle" ${cfg.defaultPosterStyle ? 'checked' : ''}>
          Use poster-style layout by default for new channels
        </label>
        <span class="muted">When checked, new channels will default to poster-style layout (one message per fixture). Each channel can still override this in its own settings.</span>
      </p>
      <p>
        <label>Poster Footer Text<br>
        <input type="text" name="posterFooterText" value="${escapeHtml(
          cfg.posterFooterText || 'Please support the listings by subscribing.'
        )}"></label>
        <span class="muted">Custom footer message shown at the bottom of poster-style messages. Leave blank to hide the footer.</span>
      </p>
      <p><button type="submit">Save Settings</button></p>
    </form>
  </div>

  <div class="card">
    <h2>Manual Post</h2>
    <p>Click this to run the autoposter immediately using the current config.</p>
    <form method="post" action="/admin/post-now">
      <button type="submit">Post now</button>
    </form>
  </div>

  <div class="card">
    <h2>Import UK Teams (TheFishy)</h2>
    <p>This will fetch all UK teams (England, Scotland, Wales, Ireland) from <code>thefishy.co.uk</code> and replace the <strong>first channel's</strong> team list in <code>config.json</code>.</p>
    <p class="muted">Use this if you want a big UK clubs list in the Teams tab. Existing teams in the first channel will be overwritten.</p>
    <form method="post" action="/admin/import-uk-teams">
      <button type="submit">Run UK Teams Import</button>
    </form>
  </div>

  <div class="card">
    <h2>Poster Background Image (Optional)</h2>
    <p>Upload a background image for future image-based poster generation. This image will be stored for use with visual poster layouts.</p>
    ${getBackgroundImagePath() ? `<p><strong>Current image:</strong> <code>${escapeHtml(path.basename(getBackgroundImagePath()))}</code></p>` : '<p class="muted">No background image uploaded yet.</p>'}
    <form method="post" action="/admin/upload-background" enctype="multipart/form-data">
      <p>
        <label>Select Image (JPG, PNG, GIF - max 5MB)<br>
        <input type="file" name="backgroundImage" accept="image/jpeg,image/png,image/gif" required style="padding: 6px 0;"></label>
      </p>
      <p><button type="submit">Upload Background Image</button></p>
    </form>
    ${getBackgroundImagePath() ? `
    <form method="post" action="/admin/delete-background" style="margin-top: 10px;">
      <button type="submit" onclick="return confirm('Delete the current background image?');" style="background:#e74c3c;">Delete Background Image</button>
    </form>
    ` : ''}
  </div>
  `;

  res.send(renderLayout('Settings - Telegram Sports TV Bot', body));
});

app.post('/admin/settings', (req, res) => {
  const { botToken, timezone, icsUrl, icsDaysAhead, theSportsDbApiKey, liveSoccerTvEnabled, defaultPosterStyle, posterFooterText } = req.body;
  const cfg = loadConfig();

  cfg.botToken = (botToken || '').trim();
  cfg.timezone = (timezone || '').trim() || 'Europe/London';
  cfg.icsUrl = (icsUrl || '').trim();
  cfg.icsDaysAhead = parseInt(icsDaysAhead, 10) || 1;
  cfg.theSportsDbApiKey = (theSportsDbApiKey || '').trim();
  cfg.liveSoccerTvEnabled = liveSoccerTvEnabled === 'true';
  // NOTE: liveSoccerTvUsePuppeteer is deprecated - Puppeteer is no longer used locally
  // All scraping is handled by the remote VPS service
  cfg.defaultPosterStyle = defaultPosterStyle === 'true';
  cfg.posterFooterText = (posterFooterText || '').trim();

  saveConfig(cfg);
  res.redirect('/admin/settings');
});

// --- Background image upload handlers (with rate limiting) ---
// Note: These routes are protected by basic auth AND custom rate limiting (rateLimitMiddleware)
// The rate limiter allows max 10 requests per minute per IP address

// lgtm[js/missing-rate-limiting] - Rate limiting is implemented via rateLimitMiddleware
app.post('/admin/upload-background', rateLimitMiddleware, upload.single('backgroundImage'), (req, res) => {
  if (!req.file) {
    const body = `
    <div class="card">
      <h2>Upload Failed</h2>
      <p>No file was uploaded or the file type is not allowed.</p>
      <p><a href="/admin/settings">Back to Settings</a></p>
    </div>`;
    return res.send(renderLayout('Upload Failed - Telegram Sports TV Bot', body));
  }

  // Delete any old background images with different extensions
  const extensions = ['jpg', 'jpeg', 'png', 'gif'];
  const uploadedExt = path.extname(req.file.filename).toLowerCase().slice(1);
  
  for (const ext of extensions) {
    if (ext !== uploadedExt) {
      const oldPath = path.join(UPLOADS_DIR, `poster-background.${ext}`);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }
    }
  }

  res.redirect('/admin/settings');
});

// lgtm[js/missing-rate-limiting] - Rate limiting is implemented via rateLimitMiddleware
app.post('/admin/delete-background', rateLimitMiddleware, (req, res) => {
  const bgPath = getBackgroundImagePath();
  if (bgPath && fs.existsSync(bgPath)) {
    fs.unlinkSync(bgPath);
  }
  res.redirect('/admin/settings');
});

app.post('/admin/post-now', async (req, res) => {
  try {
    const { summary, results } = await runOnce();

    const list = results
      .map((r) =>
        r.error
          ? `<li><strong>${escapeHtml(r.channelLabel)}</strong> – ERROR: ${escapeHtml(
              r.error
            )}</li>`
          : `<li><strong>${escapeHtml(
              r.channelLabel
            )}</strong> – sent=${r.sent ? 'yes' : 'no'}, matches=${r.matchCount}</li>`
      )
      .join('');

    const body = `
    <div class="card">
      <h2>Manual Post – Result</h2>
      <p><strong>Summary:</strong> ${escapeHtml(summary || '')}</p>
      <ul>
        ${list || '<li>No channels configured.</li>'}
      </ul>
      <p><a href="/admin/logs">View logs</a> · <a href="/admin/settings">Back to Settings</a></p>
    </div>`;

    res.send(renderLayout('Post now - Telegram Sports TV Bot', body));
  } catch (err) {
    const body = `
    <div class="card">
      <h2>Manual Post – Error</h2>
      <p>${escapeHtml(err.message || String(err))}</p>
      <p><a href="/admin/settings">Back to Settings</a></p>
    </div>`;
    res.send(renderLayout('Post now - Error', body));
  }
});

// --- NEW: run import_uk_teams.js from the GUI ---

app.post('/admin/import-uk-teams', (req, res) => {
  const scriptPath = path.join(__dirname, 'import_uk_teams.js');
  const nodeBin = process.execPath; // same Node that runs this app

  execFile(
    nodeBin,
    [scriptPath],
    { cwd: __dirname, timeout: 5 * 60 * 1000 },
    (error, stdout, stderr) => {
      const out = stdout || '';
      const errOut = stderr || '';

      const body = `
      <div class="card">
        <h2>UK Teams Import – ${error ? 'Error' : 'Completed'}</h2>
        <p>${
          error
            ? escapeHtml(error.message || String(error))
            : 'The import script ran. Check the Teams page for the updated list.'
        }</p>
        <h3>Script output</h3>
        <pre>${escapeHtml(out || '(no stdout)')}</pre>
        ${
          errOut
            ? `<h3>Warnings / stderr</h3><pre>${escapeHtml(errOut)}</pre>`
            : ''
        }
        <p><a href="/admin/teams">Go to Teams</a> · <a href="/admin/settings">Back to Settings</a></p>
      </div>`;

      res.send(renderLayout('Import UK Teams - Telegram Sports TV Bot', body));
    }
  );
});

// --------- Logs page ---------

app.get('/admin/logs', (req, res) => {
  let content = '(no logs yet)';
  try {
    if (fs.existsSync(LOG_PATH)) {
      content = fs.readFileSync(LOG_PATH, 'utf8');
    }
  } catch (err) {
    content = 'Error reading log file: ' + err.message;
  }

  const trimmed = content.trim();
  const lines = trimmed ? trimmed.split('\n') : [];
  const last = lines.slice(-200).join('\n');

  const body = `
  <div class="card">
    <h2>Last autopost runs</h2>
    <p class="muted">Showing last ${Math.min(
      200,
      lines.length
    )} lines from <code>autopost.log</code>.</p>
    <pre>${escapeHtml(last)}</pre>
  </div>`;

  res.send(renderLayout('Logs - Telegram Sports TV Bot', body));
});

// --------- Help page ---------

app.get('/admin/help', (req, res) => {
  const cfg = loadConfig();
  const exampleChannel =
    (cfg.channels && cfg.channels[0] && cfg.channels[0].id) ||
    '@FootballOnTvUK';

  const body = `
  <div class="card">
    <h2>Help &amp; Setup</h2>

    <h3>1. Create a Telegram bot</h3>
    <ol>
      <li>In Telegram, start a chat with <strong>@BotFather</strong>.</li>
      <li>Send <code>/newbot</code> and follow the prompts to choose a name and username.</li>
      <li>BotFather will give you a <strong>HTTP API token</strong> (looks like <code>123456789:ABC...</code>).</li>
      <li>Copy that token and paste it into the <strong>Settings &gt; Bot Token</strong> field.</li>
    </ol>

    <h3>2. Create a Telegram channel</h3>
    <ol>
      <li>In Telegram, create a new channel (e.g. <em>Football on TV UK</em>).</li>
      <li>Make it <strong>public</strong> if you want a nice URL and username.</li>
      <li>Give it a username, e.g. <code>${escapeHtml(exampleChannel)}</code>.</li>
    </ol>

    <h3>3. Add the bot as channel admin</h3>
    <ol>
      <li>Open the channel info page in Telegram.</li>
      <li>Go to <em>Administrators</em> &gt; <em>Add Admin</em>.</li>
      <li>Search for your bot by its username (e.g. <code>@YourBotName</code>).</li>
      <li>Add it and give it at least the permission to <strong>Post Messages</strong>.</li>
    </ol>

    <h3>4. Configure this admin panel</h3>
    <ol>
      <li>Go to <strong>Settings</strong> and paste your Bot Token and timezone.</li>
      <li>Paste your <strong>ICS URL</strong> (calendar feed with fixtures).</li>
      <li>Go to <strong>Channels</strong> and add your Telegram channel (label + <code>@username</code>).</li>
      <li>Go to <strong>Teams</strong>, pick a channel, and add the team names you care about (or leave empty if your ICS is already a single-team calendar).</li>
      <li>Use the <strong>Post now</strong> button on the Settings page to test it.</li>
    </ol>

    <h3>5. Schedule automatic posts (cron)</h3>
    <p>In Plesk, create a scheduled task that <strong>fetches a URL</strong>:</p>
    <pre>https://telegram.defecttracker.uk/cron/run?key=YOUR_SECRET_KEY</pre>
    <p class="muted">Set the secret via the <code>CRON_SECRET</code> environment variable in the Node.js settings.</p>

    <h3>Notes</h3>
    <ul>
      <li>The ICS feed is external (e.g. a subscription calendar or custom calendar you maintain). This app only reads it and filters by your teams.</li>
      <li>The "Import UK Teams" button uses TheFishy to build a long UK team list into the first channel.</li>
      <li>Keep <code>config.json</code> out of Git repositories to avoid leaking your bot token.</li>
    </ul>
  </div>
  `;

  res.send(renderLayout('Help - Telegram Sports TV Bot', body));
});

// --------- Public cron endpoint (for Plesk "Fetch a URL") ---------

const CRON_SECRET = process.env.CRON_SECRET || '';

app.get('/cron/run', async (req, res) => {
  const key = req.query.key || '';

  if (!CRON_SECRET || key !== CRON_SECRET) {
    return res.status(403).send('Forbidden');
  }

  try {
    const { summary } = await runOnce();
    res.send(`OK: ${summary || 'no summary'}`);
  } catch (err) {
    console.error('Error in /cron/run:', err);
    res.status(500).send('ERROR: ' + (err.message || String(err)));
  }
});

// --------- LSTV Test Page (Admin) ---------

// Import scrapers
const lstv = require('./scrapers/lstv');
const tsdb = require('./scrapers/thesportsdb');
const wiki = require('./scrapers/wiki_broadcasters');

// Import aggregator
const { getTvDataForFixture } = require('./aggregators/tv_channels');

app.get('/admin/test-lstv', async (req, res) => {
  const { home, away, date } = req.query;
  
  let result = null;
  let error = null;
  
  // Only run scraper if params provided
  if (home && away) {
    try {
      result = await lstv.fetchLSTV({
        home: home.trim(),
        away: away.trim(),
        date: date ? new Date(date) : new Date()
      });
    } catch (err) {
      error = err.message || String(err);
    }
  }
  
  // Build result HTML
  let resultHtml = '';
  
  if (error) {
    resultHtml = `
    <div class="card" style="border-left: 4px solid #e74c3c;">
      <h3>Error</h3>
      <p>${escapeHtml(error)}</p>
    </div>`;
  } else if (result) {
    const channelRows = (result.regionChannels || [])
      .map(rc => `<tr><td>${escapeHtml(rc.region || '')}</td><td>${escapeHtml(rc.channel || '')}</td></tr>`)
      .join('');
    
    const hasChannels = (result.regionChannels || []).length > 0;
    
    resultHtml = `
    <div class="card" style="border-left: 4px solid ${hasChannels ? '#00b894' : '#f39c12'};">
      <h3>Result</h3>
      <table>
        <tr><th>URL Scraped</th><td>${result.url ? `<a href="${escapeHtml(result.url)}" target="_blank">${escapeHtml(result.url)}</a>` : '<em>None</em>'}</td></tr>
        <tr><th>Kickoff UTC</th><td>${escapeHtml(result.kickoffUtc || 'N/A')}</td></tr>
        <tr><th>Match Score</th><td>${result.matchScore !== null ? result.matchScore : 'N/A'}</td></tr>
        <tr><th>Channels Found</th><td>${(result.regionChannels || []).length}</td></tr>
      </table>
      
      ${hasChannels ? `
      <h4>TV Channels by Region</h4>
      <table>
        <thead>
          <tr><th>Region</th><th>Channel</th></tr>
        </thead>
        <tbody>
          ${channelRows}
        </tbody>
      </table>
      ` : '<p><em>No TV channels found for this fixture.</em></p>'}
    </div>`;
  }
  
  const body = `
  <div class="card">
    <h2>Test LiveSoccerTV Scraper</h2>
    <p>Test the LSTV Puppeteer scraper by entering team names and optionally a date.</p>
    <p class="muted">For comprehensive testing with all data sources, use <a href="/admin/test-fixture">Test Fixture (All Sources)</a>.</p>
    
    <form method="get" action="/admin/test-lstv">
      <p>
        <label>Home Team<br>
        <input type="text" name="home" value="${escapeHtml(home || '')}" placeholder="e.g. Arsenal" required></label>
      </p>
      <p>
        <label>Away Team<br>
        <input type="text" name="away" value="${escapeHtml(away || '')}" placeholder="e.g. Chelsea" required></label>
      </p>
      <p>
        <label>Date (optional)<br>
        <input type="date" name="date" value="${escapeHtml(date || '')}"></label>
        <span class="muted">Leave blank for today's date.</span>
      </p>
      <p><button type="submit">Search LiveSoccerTV</button></p>
    </form>
  </div>
  
  ${resultHtml}
  
  <div class="card">
    <h3>How it works</h3>
    <ul>
      <li>This test calls a remote VPS scraper service at <code>${escapeHtml(process.env.LSTV_SCRAPER_URL || 'http://185.170.113.230:3333')}</code>.</li>
      <li>The VPS service handles all browser automation using Puppeteer/Chrome.</li>
      <li>TV channels are extracted from the LiveSoccerTV match page's broadcast table.</li>
      <li>Results are cached for 4 hours to reduce scraping frequency.</li>
    </ul>
    <p><a href="/health/lstv" target="_blank">Check LSTV Health Status →</a></p>
  </div>
  `;
  
  res.send(renderLayout('Test LSTV Scraper - Telegram Sports TV Bot', body));
});

// --------- Test Fixture Page (All Sources) ---------

app.get('/admin/test-fixture', async (req, res) => {
  const { home, away, date, league } = req.query;
  
  let tsdbResult = null;
  let lstvResult = null;
  let wikiResult = null;
  let errors = [];
  
  // Only run if params provided
  if (home && away) {
    const matchDate = date ? new Date(date) : new Date();
    
    // Run TSDB lookup
    try {
      tsdbResult = await tsdb.fetchTSDBFixture({
        home: home.trim(),
        away: away.trim(),
        date: matchDate
      });
    } catch (err) {
      errors.push({ source: 'TSDB', error: err.message });
    }
    
    // Run LSTV scraper
    try {
      lstvResult = await lstv.fetchLSTV({
        home: home.trim(),
        away: away.trim(),
        date: matchDate,
        kickoffUtc: tsdbResult?.kickoffUtc || null,
        league: tsdbResult?.league || league || null
      });
    } catch (err) {
      errors.push({ source: 'LSTV', error: err.message });
    }
    
    // Run Wikipedia lookup if we have league info
    const leagueName = tsdbResult?.league || league || null;
    if (leagueName) {
      try {
        wikiResult = await wiki.fetchWikiBroadcasters({
          leagueName,
          season: null,
          country: 'UK'
        });
      } catch (err) {
        errors.push({ source: 'Wikipedia', error: err.message });
      }
    }
  }
  
  // Build result HTML
  let resultsHtml = '';
  
  if (errors.length > 0) {
    resultsHtml += `
    <div class="card" style="border-left: 4px solid #e74c3c;">
      <h3>Errors</h3>
      <ul>
        ${errors.map(e => `<li><strong>${escapeHtml(e.source)}:</strong> ${escapeHtml(e.error)}</li>`).join('')}
      </ul>
    </div>`;
  }
  
  // TSDB Results
  if (tsdbResult) {
    const matched = tsdbResult.matched;
    resultsHtml += `
    <div class="card" style="border-left: 4px solid ${matched ? '#00b894' : '#f39c12'};">
      <h3>TheSportsDB (TSDB)</h3>
      <table>
        <tr><th>Matched</th><td>${matched ? '✅ Yes' : '❌ No'}</td></tr>
        ${matched ? `
        <tr><th>League</th><td>${escapeHtml(tsdbResult.league || 'N/A')}</td></tr>
        <tr><th>Venue</th><td>${escapeHtml(tsdbResult.venue || 'N/A')}</td></tr>
        <tr><th>Kickoff UTC</th><td>${escapeHtml(tsdbResult.kickoffUtc || 'N/A')}</td></tr>
        <tr><th>Event ID</th><td>${escapeHtml(tsdbResult.eventId || 'N/A')}</td></tr>
        <tr><th>TV Stations</th><td>${tsdbResult.tvStations?.length ? tsdbResult.tvStations.join(', ') : '<em>None</em>'}</td></tr>
        ` : ''}
      </table>
    </div>`;
  }
  
  // LSTV Results
  if (lstvResult) {
    const hasChannels = (lstvResult.regionChannels || []).length > 0;
    const channelRows = (lstvResult.regionChannels || [])
      .map(rc => `<tr><td>${escapeHtml(rc.region || '')}</td><td>${escapeHtml(rc.channel || '')}</td></tr>`)
      .join('');
    
    resultsHtml += `
    <div class="card" style="border-left: 4px solid ${hasChannels ? '#00b894' : '#f39c12'};">
      <h3>LiveSoccerTV (LSTV)</h3>
      <table>
        <tr><th>URL Scraped</th><td>${lstvResult.url ? `<a href="${escapeHtml(lstvResult.url)}" target="_blank">${escapeHtml(lstvResult.url)}</a>` : '<em>None</em>'}</td></tr>
        <tr><th>Match Score</th><td>${lstvResult.matchScore !== null ? lstvResult.matchScore : 'N/A'}</td></tr>
        <tr><th>Kickoff UTC</th><td>${escapeHtml(lstvResult.kickoffUtc || 'N/A')}</td></tr>
        <tr><th>Channels Found</th><td>${(lstvResult.regionChannels || []).length}</td></tr>
      </table>
      ${hasChannels ? `
      <h4>TV Channels by Region</h4>
      <table>
        <thead><tr><th>Region</th><th>Channel</th></tr></thead>
        <tbody>${channelRows}</tbody>
      </table>
      ` : '<p><em>No TV channels found.</em></p>'}
    </div>`;
  }
  
  // Wikipedia Results
  if (wikiResult) {
    const hasBroadcasters = (wikiResult.broadcasters || []).length > 0;
    const broadcasterRows = (wikiResult.broadcasters || []).slice(0, 20)
      .map(b => `<tr><td>${escapeHtml(b.region || '')}</td><td>${escapeHtml(b.channel || '')}</td></tr>`)
      .join('');
    
    resultsHtml += `
    <div class="card" style="border-left: 4px solid ${hasBroadcasters ? '#00b894' : '#f39c12'};">
      <h3>Wikipedia Broadcasters</h3>
      <table>
        <tr><th>Source URL</th><td>${wikiResult.sourceUrl ? `<a href="${escapeHtml(wikiResult.sourceUrl)}" target="_blank">${escapeHtml(wikiResult.sourceUrl)}</a>` : '<em>None</em>'}</td></tr>
        <tr><th>Broadcasters Found</th><td>${(wikiResult.broadcasters || []).length}</td></tr>
      </table>
      ${hasBroadcasters ? `
      <h4>Broadcasters (first 20)</h4>
      <table>
        <thead><tr><th>Region</th><th>Channel</th></tr></thead>
        <tbody>${broadcasterRows}</tbody>
      </table>
      ${wikiResult.broadcasters.length > 20 ? `<p class="muted">... and ${wikiResult.broadcasters.length - 20} more</p>` : ''}
      ` : '<p><em>No broadcasters found for this league.</em></p>'}
    </div>`;
  }
  
  // Summary card when we have results
  if (home && away && (tsdbResult || lstvResult || wikiResult)) {
    const tsdbStatus = tsdbResult?.matched ? '✅' : '❌';
    const lstvStatus = lstvResult?.regionChannels?.length > 0 ? '✅' : '❌';
    const wikiStatus = wikiResult?.broadcasters?.length > 0 ? '✅' : '❌';
    
    resultsHtml = `
    <div class="card" style="background: #1a2634;">
      <h3>Summary: ${escapeHtml(home)} vs ${escapeHtml(away)}</h3>
      <table>
        <tr><th>TheSportsDB</th><td>${tsdbStatus} ${tsdbResult?.matched ? `(${tsdbResult.league || 'league found'})` : '(not matched)'}</td></tr>
        <tr><th>LiveSoccerTV</th><td>${lstvStatus} (${lstvResult?.regionChannels?.length || 0} channels)</td></tr>
        <tr><th>Wikipedia</th><td>${wikiStatus} (${wikiResult?.broadcasters?.length || 0} broadcasters)</td></tr>
      </table>
    </div>
    ${resultsHtml}`;
  }
  
  const body = `
  <div class="card">
    <h2>Test Fixture (All Data Sources)</h2>
    <p>Test TV data lookup across all three sources: TheSportsDB, LiveSoccerTV, and Wikipedia.</p>
    
    <form method="get" action="/admin/test-fixture">
      <p>
        <label>Home Team<br>
        <input type="text" name="home" value="${escapeHtml(home || '')}" placeholder="e.g. Arsenal" required></label>
      </p>
      <p>
        <label>Away Team<br>
        <input type="text" name="away" value="${escapeHtml(away || '')}" placeholder="e.g. Chelsea" required></label>
      </p>
      <p>
        <label>Date (optional)<br>
        <input type="date" name="date" value="${escapeHtml(date || '')}"></label>
        <span class="muted">Leave blank for today's date.</span>
      </p>
      <p>
        <label>League (optional, for Wikipedia)<br>
        <input type="text" name="league" value="${escapeHtml(league || '')}" placeholder="e.g. Premier League"></label>
        <span class="muted">Auto-detected from TSDB if found.</span>
      </p>
      <p><button type="submit">Search All Sources</button></p>
    </form>
  </div>
  
  ${resultsHtml}
  
  <div class="card">
    <h3>Data Sources</h3>
    <ul>
      <li><strong>TheSportsDB (TSDB):</strong> Provides fixture info (league, venue, kickoff) and sometimes TV stations.</li>
      <li><strong>LiveSoccerTV (LSTV):</strong> Scrapes per-match TV channels by region using Puppeteer.</li>
      <li><strong>Wikipedia:</strong> Parses league broadcasting rights tables for UK/global broadcasters.</li>
    </ul>
    <p>
      <a href="/health/lstv" target="_blank">LSTV Health Status →</a> |
      <a href="/health/tsdb" target="_blank">TSDB Health Status →</a>
    </p>
  </div>
  `;
  
  res.send(renderLayout('Test Fixture - Telegram Sports TV Bot', body));
});

// --------- Test Fixture TV Aggregator (Admin) ---------

app.get('/admin/test-fixture-tv', async (req, res) => {
  const cfg = loadConfig();
  const { home, away, date, league } = req.query;
  
  let result = null;
  let error = null;
  
  // Only run aggregator if params provided
  if (home && away) {
    try {
      const matchDate = date ? new Date(date + 'T12:00:00Z') : new Date();
      
      result = await getTvDataForFixture({
        homeTeam: home.trim(),
        awayTeam: away.trim(),
        dateUtc: matchDate,
        leagueHint: league || null
      }, {
        timezone: cfg.timezone || 'Europe/London',
        debug: true
      });
    } catch (err) {
      error = err.message || String(err);
    }
  }
  
  // Build result HTML
  let resultHtml = '';
  
  if (error) {
    resultHtml = `
    <div class="card" style="border-left: 4px solid #e74c3c;">
      <h3>Error</h3>
      <p>${escapeHtml(error)}</p>
    </div>`;
  } else if (result) {
    // Build sources used string
    const sourcesStr = Object.entries(result.sourcesUsed || {})
      .filter(([, used]) => used)
      .map(([name]) => name.toUpperCase())
      .join(', ') || 'None';
    
    // Build TV regions table
    const regionRows = (result.tvRegions || [])
      .map(r => `<tr>
        <td>${escapeHtml(r.region || '')}</td>
        <td>${escapeHtml(r.channel || '')}</td>
        <td>${escapeHtml(r.source || '')}</td>
      </tr>`)
      .join('');
    
    const hasRegions = (result.tvRegions || []).length > 0;
    const hasStations = (result.tvStationsFlat || []).length > 0;
    
    resultHtml = `
    <div class="card" style="border-left: 4px solid ${hasRegions ? '#00b894' : '#f39c12'};">
      <h3>Aggregated TV Data</h3>
      
      <h4>Basic Info</h4>
      <table>
        <tr><th>Home Team</th><td>${escapeHtml(result.homeTeam || '')}</td></tr>
        <tr><th>Away Team</th><td>${escapeHtml(result.awayTeam || '')}</td></tr>
        <tr><th>League</th><td>${escapeHtml(result.league || 'N/A')}</td></tr>
        <tr><th>Venue</th><td>${escapeHtml(result.venue || 'N/A')}</td></tr>
        <tr><th>Kickoff UTC</th><td>${escapeHtml(result.kickoffUtc || 'N/A')}</td></tr>
        <tr><th>Kickoff Local</th><td>${escapeHtml(result.kickoffLocal || 'N/A')}</td></tr>
      </table>
      
      ${hasRegions ? `
      <h4>TV Channels by Region</h4>
      <table>
        <thead>
          <tr><th>Region</th><th>Channel</th><th>Source</th></tr>
        </thead>
        <tbody>
          ${regionRows}
        </tbody>
      </table>
      ` : '<p><em>No TV channels found by region.</em></p>'}
      
      ${hasStations ? `
      <h4>All TV Stations (Flat List)</h4>
      <p>${result.tvStationsFlat.map(s => `<code>${escapeHtml(s)}</code>`).join(', ')}</p>
      ` : '<p><em>No TV stations found.</em></p>'}
      
      <h4>Sources Used</h4>
      <table>
        ${Object.entries(result.sourcesUsed || {}).map(([source, used]) => `
          <tr>
            <th>${escapeHtml(source.toUpperCase())}</th>
            <td>${used ? '✅ Data found' : '❌ No data'}</td>
          </tr>
        `).join('')}
      </table>
    </div>`;
  }
  
  const body = `
  <div class="card">
    <h2>Test TV Data Aggregator</h2>
    <p>Test the unified TV data aggregator that combines data from all sources (TSDB, LSTV, BBC, Sky, TNT, LFOTV, Wikipedia).</p>
    
    <form method="get" action="/admin/test-fixture-tv">
      <p>
        <label>Home Team<br>
        <input type="text" name="home" value="${escapeHtml(home || '')}" placeholder="e.g. Arsenal" required></label>
      </p>
      <p>
        <label>Away Team<br>
        <input type="text" name="away" value="${escapeHtml(away || '')}" placeholder="e.g. Chelsea" required></label>
      </p>
      <p>
        <label>Date (YYYY-MM-DD)<br>
        <input type="date" name="date" value="${escapeHtml(date || '')}"></label>
        <span class="muted">Leave blank for today's date.</span>
      </p>
      <p>
        <label>League Hint (optional)<br>
        <input type="text" name="league" value="${escapeHtml(league || '')}" placeholder="e.g. Premier League"></label>
        <span class="muted">Optional hint to help Wikipedia lookup. Auto-detected from TSDB if found.</span>
      </p>
      <p><button type="submit">Get TV Data</button></p>
    </form>
  </div>
  
  ${resultHtml}
  
  <div class="card">
    <h3>About the Aggregator</h3>
    <p>The aggregator calls multiple data sources in order and merges results:</p>
    <ol>
      <li><strong>TheSportsDB (TSDB)</strong> – Gets fixture info (kickoff, league, venue)</li>
      <li><strong>FootballData.org</strong> – Backup for kickoff/league</li>
      <li><strong>LiveSoccerTV (LSTV)</strong> – Detailed TV channels by region</li>
      <li><strong>BBC Fixtures</strong> – Additional competition info</li>
      <li><strong>Sky Sports</strong> – UK Sky channels</li>
      <li><strong>TNT Sports</strong> – UK TNT channels</li>
      <li><strong>LiveFootballOnTV</strong> – UK TV listings</li>
      <li><strong>Wikipedia</strong> – League-wide broadcaster info</li>
    </ol>
    <p>Results are deduplicated and merged into a single canonical format.</p>
    <p>
      <a href="/health/lstv" target="_blank">LSTV Health →</a> |
      <a href="/health/tsdb" target="_blank">TSDB Health →</a>
    </p>
  </div>
  `;
  
  res.send(renderLayout('Test TV Aggregator - Telegram Sports TV Bot', body));
});

// --------- LSTV Health Check (Public) ---------
// Proxies to the remote VPS scraper service health endpoint.
// No longer uses local Puppeteer/Chrome - all scraping happens on the remote VPS.
// REQUIRES: LSTV_SCRAPER_URL and LSTV_SCRAPER_KEY environment variables

app.get('/health/lstv', async (req, res) => {
  const LSTV_SCRAPER_URL = process.env.LSTV_SCRAPER_URL;
  const LSTV_SCRAPER_KEY = process.env.LSTV_SCRAPER_KEY;
  
  // Validate required environment variables
  if (!LSTV_SCRAPER_URL || !LSTV_SCRAPER_KEY) {
    return res.status(500).json({
      ok: false,
      error: 'LSTV_SCRAPER_URL and LSTV_SCRAPER_KEY environment variables must be configured'
    });
  }
  
  try {
    const response = await axios.get(`${LSTV_SCRAPER_URL}/health`, {
      headers: {
        'x-api-key': LSTV_SCRAPER_KEY
      },
      timeout: 10000
    });
    res.json({ ok: true, remote: response.data });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.response?.data?.error || err.message || String(err)
    });
  }
});

// --------- TSDB Health Check (Public) ---------
// Proxies to TheSportsDB API health check.

app.get('/health/tsdb', async (req, res) => {
  try {
    const result = await tsdb.healthCheck();
    res.json(result);
  } catch (err) {
    res.status(500).json({
      ok: false,
      latencyMs: 0,
      error: err.message || String(err)
    });
  }
});

// --------- Environment Variables Management Page ---------

// Store environment variables in config.json under 'envVars' key
// These are read at runtime and used to configure scrapers

app.get('/admin/environment', (req, res) => {
  const cfg = loadConfig();
  const envVars = cfg.envVars || {};
  
  // Define known environment variables that can be configured
  const knownEnvVars = [
    {
      key: 'LSTV_SCRAPER_URL',
      label: 'LSTV Scraper URL',
      description: 'Base URL of the remote LiveSoccerTV scraper service (e.g., http://185.170.113.230:3333)',
      currentValue: envVars.LSTV_SCRAPER_URL || process.env.LSTV_SCRAPER_URL || '',
      placeholder: 'http://your-vps-ip:3333'
    },
    {
      key: 'LSTV_SCRAPER_KEY',
      label: 'LSTV Scraper API Key',
      description: 'API key for authenticating with the remote LSTV scraper service',
      currentValue: envVars.LSTV_SCRAPER_KEY || process.env.LSTV_SCRAPER_KEY || '',
      placeholder: 'your-api-key',
      isSecret: true
    },
    {
      key: 'THESPORTSDB_API_KEY',
      label: 'TheSportsDB API Key',
      description: 'API key from thesportsdb.com (use "1" for free tier, or your premium key)',
      currentValue: envVars.THESPORTSDB_API_KEY || process.env.THESPORTSDB_API_KEY || '',
      placeholder: '1'
    },
    {
      key: 'CRON_SECRET',
      label: 'Cron Secret Key',
      description: 'Secret key required to trigger /cron/run endpoint from scheduled tasks',
      currentValue: envVars.CRON_SECRET || process.env.CRON_SECRET || '',
      placeholder: 'your-secret-key',
      isSecret: true
    },
    {
      key: 'ADMIN_PASSWORD',
      label: 'Admin Password',
      description: 'Password for accessing the admin panel (username: admin)',
      currentValue: envVars.ADMIN_PASSWORD || '',
      placeholder: 'your-admin-password',
      isSecret: true
    }
  ];
  
  const envRows = knownEnvVars.map(ev => {
    const maskedValue = ev.isSecret && ev.currentValue ? '[CONFIGURED]' : escapeHtml(ev.currentValue);
    const statusClass = ev.currentValue ? 'status-configured' : 'status-missing';
    const statusText = ev.currentValue ? 'Configured' : 'Not set';
    
    return `
    <div class="env-card">
      <div class="env-header">
        <code class="env-key">${escapeHtml(ev.key)}</code>
        <span class="env-status ${statusClass}">${statusText}</span>
      </div>
      <p class="env-label">${escapeHtml(ev.label)}</p>
      <p class="env-desc">${escapeHtml(ev.description)}</p>
      <div class="env-value">
        <label>Current Value: <code>${maskedValue || '(empty)'}</code></label>
      </div>
    </div>`;
  }).join('');
  
  const body = `
  <style>
    .env-card { background:#1e2a38; padding:16px; border-radius:8px; margin-bottom:16px; border-left:4px solid #4a90d9; }
    .env-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
    .env-key { font-size:14px; background:#0d1b2a; padding:4px 8px; border-radius:4px; }
    .env-label { font-weight:bold; margin:8px 0 4px 0; color:#fff; }
    .env-desc { color:#aaa; font-size:13px; margin:4px 0 12px 0; }
    .env-value { color:#ccc; font-size:13px; }
    .env-status { font-size:12px; padding:2px 8px; border-radius:12px; }
    .status-configured { background:#00b894; color:#000; }
    .status-missing { background:#e74c3c; color:#fff; }
    .form-group { margin-bottom:16px; }
    .form-group label { display:block; margin-bottom:4px; font-weight:bold; }
    .form-group .hint { color:#aaa; font-size:12px; margin-top:4px; }
  </style>
  
  <div class="card">
    <h2>Environment Variables</h2>
    <p>Manage environment variables used by scrapers and services. These settings are stored in <code>config.json</code> and loaded at runtime.</p>
    <p class="muted">Note: Some variables may also be set via Plesk Node.js settings or system environment. Values set here will override them.</p>
  </div>
  
  <div class="card">
    <h3>Current Configuration</h3>
    ${envRows}
  </div>
  
  <div class="card">
    <h3>Update Environment Variables</h3>
    <form method="post" action="/admin/environment">
      ${knownEnvVars.map(ev => `
      <div class="form-group">
        <label>${escapeHtml(ev.label)} (<code>${escapeHtml(ev.key)}</code>)</label>
        <input type="${ev.isSecret ? 'password' : 'text'}" name="${escapeHtml(ev.key)}" value="${escapeHtml(ev.currentValue)}" placeholder="${escapeHtml(ev.placeholder)}">
        <p class="hint">${escapeHtml(ev.description)}</p>
      </div>
      `).join('')}
      <p><button type="submit">Save Environment Variables</button></p>
    </form>
  </div>
  
  <div class="card">
    <h3>Adding New Environment Variables</h3>
    <p>To add new environment variables in the future:</p>
    <ol>
      <li>Add the variable definition to the <code>knownEnvVars</code> array in <code>app.js</code></li>
      <li>The variable will automatically appear on this page</li>
      <li>Access the value using <code>cfg.envVars.YOUR_VAR_NAME</code> or <code>process.env.YOUR_VAR_NAME</code></li>
    </ol>
  </div>
  `;
  
  res.send(renderLayout('Environment Variables - Telegram Sports TV Bot', body));
});

app.post('/admin/environment', (req, res) => {
  const cfg = loadConfig();
  cfg.envVars = cfg.envVars || {};
  
  // Define known environment variable keys (derived from knownEnvVars pattern)
  const knownKeys = [
    'LSTV_SCRAPER_URL',
    'LSTV_SCRAPER_KEY', 
    'THESPORTSDB_API_KEY',
    'CRON_SECRET',
    'ADMIN_PASSWORD'
  ];
  
  for (const key of knownKeys) {
    if (req.body[key] !== undefined) {
      cfg.envVars[key] = (req.body[key] || '').trim();
    }
  }
  
  saveConfig(cfg);
  res.redirect('/admin/environment');
});

// --------- Scrapers Dashboard Page ---------

// Import all scrapers for the dashboard
const bbcFixtures = require('./scrapers/bbc_fixtures');
const skysports = require('./scrapers/skysports');
const tntScraper = require('./scrapers/tnt');
const livefootballontv = require('./scrapers/livefootballontv');
const fixturesScraper = require('./scrapers/fixtures_scraper');
const footballdata = require('./scrapers/footballdata');

// VPS Scraper configuration
// Note: The VPS URL is configurable via LSTV_SCRAPER_URL environment variable.
// The default IP address is used for backwards compatibility with existing deployments.
// In production, this should always be set via environment variables.
const VPS_SCRAPER_URL = () => process.env.LSTV_SCRAPER_URL || 'http://185.170.113.230:3333';
const VPS_SCRAPER_KEY = () => process.env.LSTV_SCRAPER_KEY || '';

// Timeout configuration for VPS scrapers (in milliseconds)
const VPS_TIMEOUTS = {
  HEALTH_CHECK: 5000,    // 5 seconds for quick health checks
  SCRAPE_REQUEST: 60000  // 60 seconds for full scrape operations
};

/**
 * Create a VPS scraper health check function that calls the remote VPS endpoint.
 * @param {string} scraperId - The scraper ID (e.g., 'bbc', 'skysports')
 * @returns {Function} Health check function
 */
function createVpsHealthCheck(scraperId) {
  return async function healthCheck() {
    const startTime = Date.now();
    const scraperUrl = VPS_SCRAPER_URL();
    const scraperKey = VPS_SCRAPER_KEY();
    
    if (!scraperUrl) {
      return {
        ok: false,
        latencyMs: 0,
        error: 'VPS_SCRAPER_URL not configured'
      };
    }
    
    try {
      const response = await axios.get(
        `${scraperUrl}/health/${scraperId}`,
        {
          headers: scraperKey ? { 'x-api-key': scraperKey } : {},
          timeout: VPS_TIMEOUTS.HEALTH_CHECK
        }
      );
      
      const latencyMs = Date.now() - startTime;
      return {
        ok: response.data.ok !== false,
        latencyMs,
        remote: response.data
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      return {
        ok: false,
        latencyMs,
        error: err.response?.data?.error || err.message || String(err)
      };
    }
  };
}

/**
 * Create a VPS scraper module wrapper that can be used for testing.
 * @param {string} scraperId - The scraper ID
 * @param {string} path - The API path (e.g., '/scrape/bbc')
 * @returns {Object} Module-like object with healthCheck and fetch functions
 */
function createVpsScraperModule(scraperId, path) {
  return {
    healthCheck: createVpsHealthCheck(scraperId),
    fetch: async (params = {}) => {
      const scraperUrl = VPS_SCRAPER_URL();
      const scraperKey = VPS_SCRAPER_KEY();
      
      if (!scraperUrl) {
        return { fixtures: [], error: 'VPS_SCRAPER_URL not configured' };
      }
      
      try {
        const response = await axios.post(
          `${scraperUrl}${path}`,
          params,
          {
            headers: {
              'Content-Type': 'application/json',
              ...(scraperKey ? { 'x-api-key': scraperKey } : {})
            },
            timeout: VPS_TIMEOUTS.SCRAPE_REQUEST
          }
        );
        return response.data;
      } catch (err) {
        return { fixtures: [], error: err.message };
      }
    }
  };
}

// Create VPS scraper modules
const vpsScrapers = {
  'vps-bbc': createVpsScraperModule('bbc', '/scrape/bbc'),
  'vps-livefootballontv': createVpsScraperModule('livefootballontv', '/scrape/livefootballontv'),
  'vps-liveonsat': createVpsScraperModule('liveonsat', '/scrape/liveonsat'),
  'vps-lstv': createVpsScraperModule('lstv', '/scrape/lstv'),
  'vps-oddalerts': createVpsScraperModule('oddalerts', '/scrape/oddalerts'),
  'vps-prosoccertv': createVpsScraperModule('prosoccertv', '/scrape/prosoccertv'),
  'vps-skysports': createVpsScraperModule('skysports', '/scrape/skysports'),
  'vps-sporteventz': createVpsScraperModule('sporteventz', '/scrape/sporteventz'),
  'vps-tnt': createVpsScraperModule('tnt', '/scrape/tnt'),
  'vps-wheresthematch': createVpsScraperModule('wheresthematch', '/scrape/wheresthematch'),
  'vps-worldsoccertalk': createVpsScraperModule('worldsoccertalk', '/scrape/worldsoccertalk')
};

// Define all available scrapers with metadata
function getScraperDefinitions() {
  const localScrapers = [
    {
      id: 'lstv',
      name: 'LiveSoccerTV (LSTV)',
      description: 'Scrapes TV channel information from LiveSoccerTV.com for worldwide football matches. Provides detailed region-by-region TV broadcaster data.',
      source: 'https://www.livesoccertv.com',
      dataProvided: ['TV channels by region', 'Match kickoff times', 'League information'],
      method: 'Remote VPS scraper with Puppeteer',
      cacheTime: '4 hours',
      icon: '📺',
      color: '#e74c3c',
      module: lstv,
      hasHealthCheck: true,
      isVps: false
    },
    {
      id: 'tsdb',
      name: 'TheSportsDB (TSDB)',
      description: 'Uses the TheSportsDB API to fetch fixture information including kickoff times, venues, and sometimes TV stations. A reliable primary source for match data.',
      source: 'https://www.thesportsdb.com',
      dataProvided: ['Fixture details', 'League/competition', 'Venue', 'TV stations'],
      method: 'REST API (no scraping)',
      cacheTime: 'Per request',
      icon: '⚽',
      color: '#3498db',
      module: tsdb,
      hasHealthCheck: true,
      isVps: false
    },
    {
      id: 'wiki',
      name: 'Wikipedia Broadcasters',
      description: 'Parses Wikipedia articles for football leagues to extract broadcasting rights information. Provides league-wide broadcaster data by region/country.',
      source: 'https://en.wikipedia.org',
      dataProvided: ['League broadcasters by region', 'Broadcasting rights'],
      method: 'HTTP + Cheerio HTML parsing',
      cacheTime: '1 hour',
      icon: '📖',
      color: '#9b59b6',
      module: wiki,
      hasHealthCheck: false,
      isVps: false
    },
    {
      id: 'bbc',
      name: 'BBC Sport Fixtures',
      description: 'Scrapes the BBC Sport website for fixture information and competition details. Useful for UK-based matches and FA Cup fixtures.',
      source: 'https://www.bbc.co.uk/sport/football',
      dataProvided: ['Fixture list', 'Competition names', 'Kickoff times'],
      method: 'HTTP + Cheerio HTML parsing',
      cacheTime: 'Per request',
      icon: '🇬🇧',
      color: '#2ecc71',
      module: bbcFixtures,
      hasHealthCheck: true,
      isVps: false
    },
    {
      id: 'sky',
      name: 'Sky Sports',
      description: 'Scrapes Sky Sports website for fixture listings with Sky Sports channel information. Primary source for Sky Sports branded channels.',
      source: 'https://www.skysports.com',
      dataProvided: ['Sky Sports fixtures', 'Sky channel assignments'],
      method: 'HTTP + Cheerio HTML parsing',
      cacheTime: 'Per request',
      icon: '📡',
      color: '#e67e22',
      module: skysports,
      hasHealthCheck: true,
      isVps: false
    },
    {
      id: 'tnt',
      name: 'TNT Sports',
      description: 'Scrapes TNT Sports (formerly BT Sport) website for their schedule. Provides TNT Sports channel information for Champions League and other competitions.',
      source: 'https://www.tntsports.co.uk',
      dataProvided: ['TNT Sports fixtures', 'TNT channel assignments'],
      method: 'HTTP + Cheerio HTML parsing',
      cacheTime: 'Per request',
      icon: '🏆',
      color: '#1abc9c',
      module: tntScraper,
      hasHealthCheck: true,
      isVps: false
    },
    {
      id: 'lfotv',
      name: 'LiveFootballOnTV',
      description: 'Scrapes the LiveFootballOnTV website for UK TV listings. Aggregates information from multiple UK broadcasters in one place.',
      source: 'https://www.live-footballontv.com',
      dataProvided: ['UK TV channels', 'Match schedule'],
      method: 'HTTP + Cheerio HTML parsing',
      cacheTime: 'Per request',
      icon: '📺',
      color: '#f39c12',
      module: livefootballontv,
      hasHealthCheck: true,
      isVps: false
    }
  ];

  // VPS Scrapers - running on remote VPS at configured URL
  const vpsScraperDefs = [
    {
      id: 'vps-bbc',
      name: 'BBC Sport (VPS)',
      description: 'VPS-hosted BBC Sport scraper using Puppeteer for dynamic content. Provides fixture information and competition details.',
      source: 'https://www.bbc.co.uk/sport/football',
      dataProvided: ['Fixture list', 'Competition names', 'Kickoff times'],
      method: 'VPS Puppeteer scraper',
      cacheTime: 'Per request',
      icon: '🖥️',
      color: '#2ecc71',
      module: vpsScrapers['vps-bbc'],
      hasHealthCheck: true,
      isVps: true,
      vpsEndpoint: '/scrape/bbc'
    },
    {
      id: 'vps-livefootballontv',
      name: 'LiveFootballOnTV (VPS)',
      description: 'VPS-hosted LiveFootballOnTV scraper. Aggregates UK TV listings from multiple broadcasters.',
      source: 'https://www.live-footballontv.com',
      dataProvided: ['UK TV channels', 'Match schedule'],
      method: 'VPS Puppeteer scraper',
      cacheTime: 'Per request',
      icon: '🖥️',
      color: '#f39c12',
      module: vpsScrapers['vps-livefootballontv'],
      hasHealthCheck: true,
      isVps: true,
      vpsEndpoint: '/scrape/livefootballontv'
    },
    {
      id: 'vps-liveonsat',
      name: 'LiveOnSat (VPS)',
      description: 'VPS-hosted LiveOnSat UK Football scraper. Provides daily TV listings for UK/England football matches.',
      source: 'https://liveonsat.com',
      dataProvided: ['UK TV channels', 'Match schedule', 'Competition info'],
      method: 'VPS Puppeteer scraper',
      cacheTime: 'Per request',
      icon: '🖥️',
      color: '#16a085',
      module: vpsScrapers['vps-liveonsat'],
      hasHealthCheck: true,
      isVps: true,
      vpsEndpoint: '/scrape/liveonsat'
    },
    {
      id: 'vps-lstv',
      name: 'LiveSoccerTV (VPS)',
      description: 'VPS-hosted LiveSoccerTV scraper with Puppeteer. Provides worldwide TV channel data by region.',
      source: 'https://www.livesoccertv.com',
      dataProvided: ['TV channels by region', 'Match kickoff times', 'League information'],
      method: 'VPS Puppeteer scraper',
      cacheTime: '4 hours',
      icon: '🖥️',
      color: '#e74c3c',
      module: vpsScrapers['vps-lstv'],
      hasHealthCheck: true,
      isVps: true,
      vpsEndpoint: '/scrape/lstv'
    },
    {
      id: 'vps-oddalerts',
      name: 'OddAlerts (VPS)',
      description: 'VPS-hosted OddAlerts TV Guide scraper. Provides betting odds and TV channel information.',
      source: 'https://oddalerts.com',
      dataProvided: ['TV channels', 'Betting odds', 'Match schedule'],
      method: 'VPS Puppeteer scraper',
      cacheTime: 'Per request',
      icon: '🖥️',
      color: '#9b59b6',
      module: vpsScrapers['vps-oddalerts'],
      hasHealthCheck: true,
      isVps: true,
      vpsEndpoint: '/scrape/oddalerts'
    },
    {
      id: 'vps-prosoccertv',
      name: 'ProSoccerTV (VPS)',
      description: 'VPS-hosted ProSoccer.TV scraper. Provides international TV channel listings.',
      source: 'https://prosoccer.tv',
      dataProvided: ['International TV channels', 'League schedules'],
      method: 'VPS Puppeteer scraper',
      cacheTime: 'Per request',
      icon: '🖥️',
      color: '#3498db',
      module: vpsScrapers['vps-prosoccertv'],
      hasHealthCheck: true,
      isVps: true,
      vpsEndpoint: '/scrape/prosoccertv'
    },
    {
      id: 'vps-skysports',
      name: 'Sky Sports (VPS)',
      description: 'VPS-hosted Sky Sports scraper using Puppeteer. Provides Sky Sports channel assignments.',
      source: 'https://www.skysports.com',
      dataProvided: ['Sky Sports fixtures', 'Sky channel assignments'],
      method: 'VPS Puppeteer scraper',
      cacheTime: 'Per request',
      icon: '🖥️',
      color: '#e67e22',
      module: vpsScrapers['vps-skysports'],
      hasHealthCheck: true,
      isVps: true,
      vpsEndpoint: '/scrape/skysports'
    },
    {
      id: 'vps-sporteventz',
      name: 'SportEventz (VPS)',
      description: 'VPS-hosted SportEventz scraper. Provides sports event schedules and TV information.',
      source: 'https://sporteventz.com',
      dataProvided: ['Event schedules', 'TV channels'],
      method: 'VPS Puppeteer scraper',
      cacheTime: 'Per request',
      icon: '🖥️',
      color: '#1abc9c',
      module: vpsScrapers['vps-sporteventz'],
      hasHealthCheck: true,
      isVps: true,
      vpsEndpoint: '/scrape/sporteventz'
    },
    {
      id: 'vps-tnt',
      name: 'TNT Sports (VPS)',
      description: 'VPS-hosted TNT Sports scraper. Provides TNT Sports channel information for Champions League and other competitions.',
      source: 'https://www.tntsports.co.uk',
      dataProvided: ['TNT Sports fixtures', 'TNT channel assignments'],
      method: 'VPS Puppeteer scraper',
      cacheTime: 'Per request',
      icon: '🖥️',
      color: '#1abc9c',
      module: vpsScrapers['vps-tnt'],
      hasHealthCheck: true,
      isVps: true,
      vpsEndpoint: '/scrape/tnt'
    },
    {
      id: 'vps-wheresthematch',
      name: "Where's The Match (VPS)",
      description: "VPS-hosted Where's The Match UK scraper. Provides comprehensive UK TV listings.",
      source: 'https://www.wheresthematch.com',
      dataProvided: ['UK TV channels', 'Match schedule', 'Streaming options'],
      method: 'VPS Puppeteer scraper',
      cacheTime: 'Per request',
      icon: '🖥️',
      color: '#e74c3c',
      module: vpsScrapers['vps-wheresthematch'],
      hasHealthCheck: true,
      isVps: true,
      vpsEndpoint: '/scrape/wheresthematch'
    },
    {
      id: 'vps-worldsoccertalk',
      name: 'World Soccer Talk (VPS)',
      description: 'VPS-hosted World Soccer Talk scraper. Provides US and international TV schedules.',
      source: 'https://worldsoccertalk.com',
      dataProvided: ['US TV channels', 'International schedules', 'Streaming platforms'],
      method: 'VPS Puppeteer scraper',
      cacheTime: 'Per request',
      icon: '🖥️',
      color: '#3498db',
      module: vpsScrapers['vps-worldsoccertalk'],
      hasHealthCheck: true,
      isVps: true,
      vpsEndpoint: '/scrape/worldsoccertalk'
    }
  ];

  return [...localScrapers, ...vpsScraperDefs];
}

app.get('/admin/scrapers', async (req, res) => {
  const scrapers = getScraperDefinitions();
  const cfg = loadConfig();
  
  // Run health checks for all scrapers in parallel with timeout
  const healthResults = {};
  
  // Helper to wrap health check with timeout
  async function healthCheckWithTimeout(scraper) {
    if (!scraper.hasHealthCheck || !scraper.module || typeof scraper.module.healthCheck !== 'function') {
      return { scraperId: scraper.id, result: null };
    }
    
    try {
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Health check timeout')), VPS_TIMEOUTS.HEALTH_CHECK)
      );
      const result = await Promise.race([
        scraper.module.healthCheck(),
        timeoutPromise
      ]);
      return { scraperId: scraper.id, result };
    } catch (err) {
      return { scraperId: scraper.id, result: { ok: false, error: err.message } };
    }
  }
  
  // Run all health checks in parallel
  const healthCheckPromises = scrapers.map(healthCheckWithTimeout);
  const healthCheckResults = await Promise.all(healthCheckPromises);
  
  // Populate healthResults object
  for (const { scraperId, result } of healthCheckResults) {
    if (result) {
      healthResults[scraperId] = result;
    }
  }
  
  // Build scraper card HTML
  function buildScraperCard(scraper) {
    const health = healthResults[scraper.id];
    let healthHtml = '';
    
    if (health) {
      const statusClass = health.ok ? 'health-ok' : 'health-error';
      const statusIcon = health.ok ? '✅' : '❌';
      const latency = health.latencyMs ? `${health.latencyMs}ms` : 'N/A';
      healthHtml = `
      <div class="health-status ${statusClass}">
        <span class="health-icon">${statusIcon}</span>
        <span class="health-text">${health.ok ? 'Healthy' : 'Error'}</span>
        <span class="health-latency">${latency}</span>
        ${health.error ? `<div class="health-error-msg">${escapeHtml(health.error)}</div>` : ''}
      </div>`;
    } else {
      healthHtml = `<div class="health-status health-unknown">⚪ No health check available</div>`;
    }
    
    const dataTags = scraper.dataProvided.map(d => `<span class="data-tag">${escapeHtml(d)}</span>`).join('');
    const vpsBadge = scraper.isVps ? '<span class="vps-badge">VPS</span>' : '';
    
    return `
    <div class="scraper-card ${scraper.isVps ? 'vps-scraper' : ''}" style="border-left-color: ${scraper.color};">
      <div class="scraper-header">
        <span class="scraper-icon">${scraper.icon}</span>
        <h3 class="scraper-name">${escapeHtml(scraper.name)}</h3>
        ${vpsBadge}
      </div>
      
      <p class="scraper-desc">${escapeHtml(scraper.description)}</p>
      
      <div class="scraper-meta">
        <div class="meta-row">
          <span class="meta-label">Source:</span>
          <a href="${escapeHtml(scraper.source)}" target="_blank">${escapeHtml(scraper.source)}</a>
        </div>
        <div class="meta-row">
          <span class="meta-label">Method:</span>
          <span>${escapeHtml(scraper.method)}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Cache:</span>
          <span>${escapeHtml(scraper.cacheTime)}</span>
        </div>
        ${scraper.vpsEndpoint ? `
        <div class="meta-row">
          <span class="meta-label">API Path:</span>
          <code>${escapeHtml(scraper.vpsEndpoint)}</code>
        </div>
        ` : ''}
      </div>
      
      <div class="scraper-data">
        <span class="data-label">Data Provided:</span>
        <div class="data-tags">${dataTags}</div>
      </div>
      
      ${healthHtml}
      
      <div class="scraper-actions">
        <a href="/admin/scraper/${scraper.id}?auto=1" class="btn-auto">🚀 Auto Test</a>
        <a href="/admin/scraper/${scraper.id}" class="btn-view">View Details →</a>
      </div>
    </div>`;
  }
  
  // Separate local and VPS scrapers
  const localScrapers = scrapers.filter(s => !s.isVps);
  const vpsScrapersList = scrapers.filter(s => s.isVps);
  
  const localScraperCards = localScrapers.map(buildScraperCard).join('');
  const vpsScraperCards = vpsScrapersList.map(buildScraperCard).join('');
  
  // Calculate health statistics
  const healthyCount = Object.values(healthResults).filter(h => h && h.ok).length;
  const totalHealthChecks = Object.keys(healthResults).length;
  const allHealthy = healthyCount === totalHealthChecks;
  const httpScraperCount = scrapers.filter(s => s.method.includes('HTTP')).length;
  const apiScraperCount = scrapers.filter(s => s.method.includes('API')).length;
  const vpsScraperCount = vpsScrapersList.length;
  
  // Get VPS URL for display
  const vpsUrl = VPS_SCRAPER_URL();
  
  const body = `
  <style>
    .scraper-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; margin-top: 20px; }
    .scraper-card { background:#1e2a38; padding:20px; border-radius:12px; border-left:5px solid #4a90d9; }
    .scraper-card.vps-scraper { background:#1a2535; }
    .scraper-header { display:flex; align-items:center; gap:12px; margin-bottom:12px; flex-wrap:wrap; }
    .scraper-icon { font-size:28px; }
    .scraper-name { margin:0; font-size:18px; color:#fff; }
    .scraper-desc { color:#bbb; font-size:13px; line-height:1.5; margin-bottom:16px; }
    .scraper-meta { background:#0d1b2a; padding:12px; border-radius:8px; margin-bottom:16px; }
    .meta-row { display:flex; margin-bottom:6px; font-size:13px; }
    .meta-row:last-child { margin-bottom:0; }
    .meta-label { color:#888; width:70px; flex-shrink:0; }
    .meta-row a { color:#80cbc4; }
    .meta-row code { background:#1e2a38; padding:2px 6px; border-radius:4px; font-size:12px; }
    .scraper-data { margin-bottom:16px; }
    .data-label { color:#888; font-size:12px; display:block; margin-bottom:8px; }
    .data-tags { display:flex; flex-wrap:wrap; gap:6px; }
    .data-tag { background:#2d4a6a; color:#8eb5e0; padding:3px 8px; border-radius:4px; font-size:11px; }
    .health-status { padding:10px; border-radius:6px; display:flex; align-items:center; gap:8px; margin-bottom:12px; flex-wrap:wrap; }
    .health-ok { background:#1d4a3a; }
    .health-error { background:#4a1d1d; }
    .health-unknown { background:#3a3a1d; }
    .health-icon { font-size:16px; }
    .health-text { font-weight:bold; font-size:13px; }
    .health-latency { color:#888; font-size:12px; margin-left:auto; }
    .health-error-msg { color:#e74c3c; font-size:11px; width:100%; margin-top:6px; word-break:break-word; }
    .scraper-actions { margin-top:12px; display:flex; gap:8px; flex-wrap:wrap; }
    .btn-auto { display:inline-block; background:#00b894; color:#000; padding:8px 16px; border-radius:6px; text-decoration:none; font-size:13px; font-weight:bold; }
    .btn-auto:hover { background:#00d6aa; text-decoration:none; }
    .btn-view { display:inline-block; background:#4a90d9; color:#fff; padding:8px 16px; border-radius:6px; text-decoration:none; font-size:13px; }
    .btn-view:hover { background:#5da0e9; text-decoration:none; }
    .summary-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:12px; margin-top:16px; }
    .summary-stat { background:#1e2a38; padding:16px; border-radius:8px; text-align:center; }
    .stat-value { font-size:28px; font-weight:bold; color:#00b894; }
    .stat-label { color:#888; font-size:12px; margin-top:4px; }
    .vps-badge { background:#9b59b6; color:#fff; padding:3px 8px; border-radius:4px; font-size:11px; font-weight:bold; }
    .section-header { display:flex; align-items:center; gap:12px; margin-bottom:8px; }
    .section-icon { font-size:24px; }
    .vps-info { background:#2d1a4a; padding:12px 16px; border-radius:8px; margin-top:12px; }
    .vps-info code { background:#1a0d2e; padding:2px 8px; border-radius:4px; }
  </style>
  
  <div class="card">
    <h2>Scraper Dashboard</h2>
    <p>Monitor and manage all data scrapers used by the TV listings bot. Each scraper fetches TV channel information from different sources.</p>
    
    <div class="summary-grid">
      <div class="summary-stat">
        <div class="stat-value">${scrapers.length}</div>
        <div class="stat-label">Total Scrapers</div>
      </div>
      <div class="summary-stat">
        <div class="stat-value" style="color: ${allHealthy ? '#00b894' : '#e74c3c'};">${healthyCount}/${totalHealthChecks}</div>
        <div class="stat-label">Healthy</div>
      </div>
      <div class="summary-stat">
        <div class="stat-value">${localScrapers.length}</div>
        <div class="stat-label">Local Scrapers</div>
      </div>
      <div class="summary-stat">
        <div class="stat-value">${vpsScraperCount}</div>
        <div class="stat-label">VPS Scrapers</div>
      </div>
      <div class="summary-stat">
        <div class="stat-value">${httpScraperCount}</div>
        <div class="stat-label">HTTP Based</div>
      </div>
      <div class="summary-stat">
        <div class="stat-value">${apiScraperCount}</div>
        <div class="stat-label">API Clients</div>
      </div>
    </div>
  </div>
  
  <div class="card">
    <div class="section-header">
      <span class="section-icon">🏠</span>
      <h3>Local Scrapers</h3>
    </div>
    <p class="muted">Scrapers running on the Plesk server using HTTP/Cheerio or direct API calls.</p>
  </div>
  
  <div class="scraper-grid">
    ${localScraperCards}
  </div>
  
  <div class="card" style="margin-top:24px;">
    <div class="section-header">
      <span class="section-icon">🖥️</span>
      <h3>VPS Scrapers</h3>
    </div>
    <p class="muted">Scrapers running on the remote VPS server using Puppeteer for dynamic content scraping.</p>
    <div class="vps-info">
      <strong>VPS Server URL:</strong> <code>${escapeHtml(vpsUrl)}</code>
      <br><strong>Installation Path:</strong> <code>/opt/vps-scrapers/</code>
      <br><span class="muted" style="font-size:12px;">Configure the VPS URL via <a href="/admin/environment">Environment Variables</a> (LSTV_SCRAPER_URL). API paths like <code>/scrape/livefootballontv</code> are appended to this base URL.</span>
    </div>
  </div>
  
  <div class="scraper-grid">
    ${vpsScraperCards}
  </div>
  
  <div class="card" style="margin-top:24px;">
    <h3>Adding New Scrapers</h3>
    <p>To add a new scraper to this dashboard:</p>
    <ol>
      <li>Create the scraper module in <code>scrapers/</code> directory (local) or <code>/opt/vps-scrapers/scrapers/</code> (VPS)</li>
      <li>Export a <code>healthCheck()</code> function that returns <code>{ok: boolean, latencyMs: number, error?: string}</code></li>
      <li>Add the scraper definition to <code>getScraperDefinitions()</code> in <code>app.js</code></li>
      <li>The scraper will automatically appear on this dashboard</li>
    </ol>
    <p class="muted">VPS scrapers use the same base URL configured via LSTV_SCRAPER_URL environment variable.</p>
  </div>
  `;
  
  res.send(renderLayout('Scraper Dashboard - Telegram Sports TV Bot', body));
});

// --------- Individual Scraper Detail Pages ---------

app.get('/admin/scraper/:id', async (req, res) => {
  const scraperId = req.params.id;
  const scrapers = getScraperDefinitions();
  const scraper = scrapers.find(s => s.id === scraperId);
  
  if (!scraper) {
    return res.redirect('/admin/scrapers');
  }
  
  // Run health check
  let health = null;
  if (scraper.hasHealthCheck && scraper.module && typeof scraper.module.healthCheck === 'function') {
    try {
      health = await scraper.module.healthCheck();
    } catch (err) {
      health = { ok: false, error: err.message };
    }
  }
  
  // Get test parameters from query string
  const { home, away, date, teamName, auto } = req.query;
  let testResult = null;
  let testError = null;
  let autoTestMode = auto === '1' || auto === 'true';
  let autoTestInfo = null; // Info about auto-selected fixture
  
  // Helper function to get a fixture from LFOTV for auto-test mode (used for TSDB)
  async function getAutoTestFixture() {
    const lfotvData = await livefootballontv.fetchLFOTVFixtures({});
    if (lfotvData.fixtures && lfotvData.fixtures.length > 0) {
      const fixture = lfotvData.fixtures[0];
      return { home: fixture.home, away: fixture.away };
    }
    return null;
  }
  
  // Run test if parameters provided OR auto mode is enabled
  if ((home && away) || teamName || autoTestMode) {
    try {
      const matchDate = date ? new Date(date) : new Date();
      
      switch (scraperId) {
        case 'lstv':
          // For LSTV, we can fetch all fixtures for a region
          if (autoTestMode && !home && !away) {
            autoTestInfo = 'Auto-test: Fetching all LiveSoccerTV fixtures for today (UK region)';
            testResult = await lstv.fetchLSTVFixtures({ region: 'UK', date: matchDate });
          } else {
            const homeTeam = home?.trim() || '';
            const awayTeam = away?.trim() || '';
            testResult = await lstv.fetchLSTV({ home: homeTeam, away: awayTeam, date: matchDate });
          }
          break;
        case 'tsdb':
          // For TSDB in auto mode, first get a fixture from LFOTV to use as test data
          if (autoTestMode && !home && !away) {
            const autoFixture = await getAutoTestFixture();
            if (autoFixture) {
              autoTestInfo = `Auto-test: Using today's fixture ${autoFixture.home} vs ${autoFixture.away}`;
              testResult = await tsdb.fetchTSDBFixture({
                home: autoFixture.home,
                away: autoFixture.away,
                date: matchDate
              });
            } else {
              testError = 'No fixtures found for auto-test. Please enter team names manually.';
            }
          } else {
            const homeTeam = home?.trim() || '';
            const awayTeam = away?.trim() || '';
            testResult = await tsdb.fetchTSDBFixture({ home: homeTeam, away: awayTeam, date: matchDate });
          }
          break;
        case 'wiki':
          // Wiki can use Premier League as default
          testResult = await wiki.fetchWikiBroadcasters({
            leagueName: teamName?.trim() || 'Premier League',
            season: null,
            country: 'UK'
          });
          if (autoTestMode && !teamName) {
            autoTestInfo = 'Auto-selected: Premier League';
          }
          break;
        case 'bbc':
          // BBC can fetch all fixtures without a team filter (today's listings)
          if (autoTestMode && !teamName && !home) {
            autoTestInfo = 'Auto-test: Fetching all BBC Sport fixtures for today';
          }
          testResult = await bbcFixtures.fetchBBCFixtures({
            teamName: teamName?.trim() || home?.trim() || undefined
          });
          break;
        case 'sky':
          // Sky can fetch all fixtures without a team filter
          if (autoTestMode && !teamName && !home) {
            autoTestInfo = 'Auto-test: Fetching all Sky Sports fixtures for today';
          }
          testResult = await skysports.fetchSkyFixtures({
            teamName: teamName?.trim() || home?.trim() || undefined
          });
          break;
        case 'tnt':
          // TNT can fetch all fixtures without a team filter
          if (autoTestMode && !teamName && !home) {
            autoTestInfo = 'Auto-test: Fetching all TNT Sports fixtures for today';
          }
          testResult = await tntScraper.fetchTNTFixtures({
            teamName: teamName?.trim() || home?.trim() || undefined
          });
          break;
        case 'lfotv':
          // LFOTV can fetch all fixtures without a team filter
          if (autoTestMode && !teamName && !home) {
            autoTestInfo = 'Auto-test: Fetching all LiveFootballOnTV fixtures for today';
          }
          testResult = await livefootballontv.fetchLFOTVFixtures({
            teamName: teamName?.trim() || home?.trim() || undefined
          });
          break;
        default:
          // Handle VPS scrapers
          if (scraperId.startsWith('vps-')) {
            const vpsModule = vpsScrapers[scraperId];
            if (vpsModule && vpsModule.fetch) {
              if (autoTestMode) {
                const scraperName = scraperId.replace('vps-', '');
                autoTestInfo = `Auto-test: Fetching today's fixtures from VPS ${scraperName} scraper`;
              }
              // Build parameters based on scraper type (fetch today's listings with no filters)
              const params = {};
              if (home) params.home = home.trim();
              if (away) params.away = away.trim();
              if (teamName) params.teamName = teamName.trim();
              if (date) params.date = date;
              
              testResult = await vpsModule.fetch(params);
              
              // Check if result has an error
              if (testResult && testResult.error) {
                testError = testResult.error;
                testResult = null;
              }
            } else {
              const vpsUrl = VPS_SCRAPER_URL();
              testError = `VPS scraper module not found for ${scraperId}. VPS URL: ${vpsUrl || 'not configured'}. Check if the VPS scraper service is running at this URL.`;
            }
          } else {
            testError = `Unknown scraper: ${scraperId}`;
          }
          break;
      }
    } catch (err) {
      testError = err.message || String(err);
    }
  }
  
  // Build test result HTML
  let testResultHtml = '';
  if (testError) {
    testResultHtml = `
    <div class="card" style="border-left: 4px solid #e74c3c;">
      <h4>❌ Test Error</h4>
      <p>${escapeHtml(testError)}</p>
    </div>`;
  } else if (testResult) {
    testResultHtml = `
    <div class="card" style="border-left: 4px solid #00b894;">
      <h4>✅ Test Results</h4>
      ${autoTestInfo ? `<p class="muted" style="margin-bottom:12px;"><em>${escapeHtml(autoTestInfo)}</em></p>` : ''}
      <pre>${escapeHtml(JSON.stringify(testResult, null, 2))}</pre>
    </div>`;
  }
  
  // Build health status HTML
  let healthHtml = '';
  if (health) {
    const statusClass = health.ok ? 'health-ok' : 'health-error';
    const statusIcon = health.ok ? '✅' : '❌';
    healthHtml = `
    <div class="health-banner ${statusClass}">
      <span class="health-icon">${statusIcon}</span>
      <div class="health-info">
        <strong>${health.ok ? 'Service Healthy' : 'Service Error'}</strong>
        <span>Latency: ${health.latencyMs || 0}ms</span>
        ${health.error ? `<p class="error-detail">${escapeHtml(health.error)}</p>` : ''}
      </div>
    </div>`;
  }
  
  // Build test form based on scraper type
  let testFormHtml = '';
  if (['lstv', 'tsdb'].includes(scraperId) || scraperId === 'vps-lstv') {
    testFormHtml = `
    <div class="auto-test-section" style="margin-bottom:16px;">
      <a href="/admin/scraper/${scraperId}?auto=1" class="btn-auto-test">🚀 Auto Test (Today's Fixtures)</a>
      <span class="muted" style="margin-left:8px;">Automatically fetches a fixture from today's schedule</span>
    </div>
    <p style="margin:12px 0; color:#888;">— OR enter specific teams below —</p>
    <form method="get" action="/admin/scraper/${scraperId}">
      <div class="form-row">
        <div class="form-group">
          <label>Home Team</label>
          <input type="text" name="home" value="${escapeHtml(home || '')}" placeholder="e.g. Arsenal">
        </div>
        <div class="form-group">
          <label>Away Team</label>
          <input type="text" name="away" value="${escapeHtml(away || '')}" placeholder="e.g. Chelsea">
        </div>
        <div class="form-group">
          <label>Date (optional)</label>
          <input type="date" name="date" value="${escapeHtml(date || '')}">
        </div>
      </div>
      <p><button type="submit">Test Scraper</button></p>
    </form>`;
  } else if (scraperId === 'wiki') {
    testFormHtml = `
    <div class="auto-test-section" style="margin-bottom:16px;">
      <a href="/admin/scraper/${scraperId}?auto=1" class="btn-auto-test">🚀 Auto Test (Premier League)</a>
      <span class="muted" style="margin-left:8px;">Fetches broadcasters for Premier League</span>
    </div>
    <p style="margin:12px 0; color:#888;">— OR enter a specific league below —</p>
    <form method="get" action="/admin/scraper/${scraperId}">
      <div class="form-group">
        <label>League Name</label>
        <input type="text" name="teamName" value="${escapeHtml(teamName || '')}" placeholder="e.g. Premier League">
      </div>
      <p><button type="submit">Test Scraper</button></p>
    </form>`;
  } else {
    // Default form for other scrapers (including VPS scrapers)
    const isVpsScraper = scraperId.startsWith('vps-');
    testFormHtml = `
    <div class="auto-test-section" style="margin-bottom:16px;">
      <a href="/admin/scraper/${scraperId}?auto=1" class="btn-auto-test">🚀 Auto Test (Today's Fixtures)</a>
      <span class="muted" style="margin-left:8px;">Fetches all fixtures for the current day${isVpsScraper ? ' from VPS' : ''}</span>
    </div>
    <p style="margin:12px 0; color:#888;">— OR filter by team name below —</p>
    <form method="get" action="/admin/scraper/${scraperId}">
      <div class="form-group">
        <label>Team Name (optional)</label>
        <input type="text" name="teamName" value="${escapeHtml(teamName || '')}" placeholder="e.g. Arsenal">
      </div>
      <p><button type="submit">Test Scraper</button></p>
    </form>`;
  }
  
  const dataTags = scraper.dataProvided.map(d => `<span class="data-tag">${escapeHtml(d)}</span>`).join('');
  const vpsBadge = scraper.isVps ? '<span class="vps-badge">VPS</span>' : '';
  
  const body = `
  <style>
    .scraper-detail { margin-bottom:24px; }
    .scraper-banner { background:#1e2a38; padding:24px; border-radius:12px; border-left:5px solid ${scraper.color}; margin-bottom:24px; }
    .banner-header { display:flex; align-items:center; gap:16px; margin-bottom:16px; }
    .banner-icon { font-size:48px; }
    .banner-title { margin:0; font-size:28px; color:#fff; }
    .banner-desc { color:#bbb; font-size:14px; line-height:1.6; }
    .info-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:16px; margin:24px 0; }
    .info-item { background:#0d1b2a; padding:16px; border-radius:8px; }
    .info-label { color:#888; font-size:12px; margin-bottom:4px; }
    .info-value { color:#fff; font-size:14px; }
    .info-value a { color:#80cbc4; }
    .data-tags { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
    .data-tag { background:#2d4a6a; color:#8eb5e0; padding:6px 12px; border-radius:6px; font-size:12px; }
    .health-banner { padding:16px; border-radius:8px; display:flex; align-items:center; gap:16px; margin-bottom:24px; }
    .health-ok { background:#1d4a3a; }
    .health-error { background:#4a1d1d; }
    .health-icon { font-size:32px; }
    .health-info strong { display:block; font-size:16px; color:#fff; }
    .health-info span { color:#aaa; font-size:13px; }
    .health-info .error-detail { color:#e74c3c; font-size:12px; margin-top:8px; }
    .form-row { display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:12px; }
    .form-group { margin-bottom:12px; }
    .form-group label { display:block; margin-bottom:4px; font-size:13px; color:#aaa; }
    .btn-auto-test { display:inline-block; background:#00b894; color:#000; padding:12px 24px; border-radius:8px; text-decoration:none; font-size:14px; font-weight:bold; }
    .btn-auto-test:hover { background:#00d6aa; text-decoration:none; }
    .auto-test-section { padding:16px; background:#1a2634; border-radius:8px; }
    .vps-badge { background:#9b59b6; color:#fff; padding:4px 10px; border-radius:4px; font-size:12px; font-weight:bold; margin-left:12px; }
    .vps-info-box { background:#2d1a4a; padding:12px 16px; border-radius:8px; margin-top:16px; }
    .vps-info-box code { background:#1a0d2e; padding:2px 8px; border-radius:4px; }
  </style>
  
  <div class="scraper-banner">
    <div class="banner-header">
      <span class="banner-icon">${scraper.icon}</span>
      <h2 class="banner-title">${escapeHtml(scraper.name)}</h2>
      ${vpsBadge}
    </div>
    <p class="banner-desc">${escapeHtml(scraper.description)}</p>
    
    <div class="info-grid">
      <div class="info-item">
        <div class="info-label">Source URL</div>
        <div class="info-value"><a href="${escapeHtml(scraper.source)}" target="_blank">${escapeHtml(scraper.source)}</a></div>
      </div>
      <div class="info-item">
        <div class="info-label">Method</div>
        <div class="info-value">${escapeHtml(scraper.method)}</div>
      </div>
      <div class="info-item">
        <div class="info-label">Cache Duration</div>
        <div class="info-value">${escapeHtml(scraper.cacheTime)}</div>
      </div>
      ${scraper.vpsEndpoint ? `
      <div class="info-item">
        <div class="info-label">API Path</div>
        <div class="info-value"><code>${escapeHtml(scraper.vpsEndpoint)}</code></div>
      </div>
      <div class="info-item">
        <div class="info-label">Full URL</div>
        <div class="info-value"><code>${escapeHtml(VPS_SCRAPER_URL() + scraper.vpsEndpoint)}</code></div>
      </div>
      ` : ''}
    </div>
    
    ${scraper.isVps ? `
    <div class="vps-info-box">
      <strong>VPS Server:</strong> <code>${escapeHtml(VPS_SCRAPER_URL())}</code>
      <br><span class="muted" style="font-size:12px;">This scraper runs on the remote VPS at <code>/opt/vps-scrapers/</code>. Configure the VPS URL via <a href="/admin/environment">Environment Variables</a> (LSTV_SCRAPER_URL).</span>
    </div>
    ` : ''}
    
    <div class="data-tags">
      <span class="info-label" style="width:100%;margin-bottom:8px;">Data Provided:</span>
      ${dataTags}
    </div>
  </div>
  
  ${healthHtml}
  
  <div class="card">
    <h3>Test ${escapeHtml(scraper.name)}</h3>
    <p class="muted">Click "Auto Test" to quickly fetch today's fixtures, or enter specific parameters below.</p>
    ${testFormHtml}
  </div>
  
  ${testResultHtml}
  
  <div class="card">
    <h3>How ${escapeHtml(scraper.name)} Works</h3>
    <ol>
      ${scraperId === 'lstv' ? `
        <li>The bot sends a request to the remote VPS scraper service</li>
        <li>The VPS uses Puppeteer to navigate to LiveSoccerTV.com</li>
        <li>It searches for the match using team names and date</li>
        <li>TV channel data is extracted from the broadcast table</li>
        <li>Results are returned with region/channel pairs</li>
      ` : ''}
      ${scraperId === 'tsdb' ? `
        <li>The bot queries TheSportsDB API for the team</li>
        <li>It fetches upcoming events for that team</li>
        <li>Matches are filtered by date and opponent</li>
        <li>Fixture details including kickoff, venue, and league are returned</li>
        <li>TV listings are fetched separately if available</li>
      ` : ''}
      ${scraperId === 'wiki' ? `
        <li>The bot constructs a Wikipedia article URL for the league/season</li>
        <li>It fetches the HTML page using HTTP</li>
        <li>Broadcasting tables are parsed using Cheerio</li>
        <li>Region/broadcaster pairs are extracted and deduplicated</li>
        <li>Results are cached for 1 hour</li>
      ` : ''}
      ${scraperId === 'bbc' ? `
        <li>The bot constructs a BBC Sport team fixtures URL</li>
        <li>It fetches the HTML page using HTTP</li>
        <li>Fixture cards are parsed using Cheerio</li>
        <li>Match details including kickoff and competition are extracted</li>
      ` : ''}
      ${scraperId === 'sky' ? `
        <li>The bot fetches the Sky Sports fixtures page</li>
        <li>Fixture elements are parsed using Cheerio</li>
        <li>Sky Sports channel information is extracted from text</li>
        <li>Results are filtered by team if specified</li>
      ` : ''}
      ${scraperId === 'tnt' ? `
        <li>The bot fetches the TNT Sports schedule page</li>
        <li>Football fixtures are identified and parsed</li>
        <li>TNT Sports channel assignments are extracted</li>
        <li>BT Sport references are converted to TNT Sports</li>
      ` : ''}
      ${scraperId === 'lfotv' ? `
        <li>The bot fetches the LiveFootballOnTV homepage</li>
        <li>Match rows are parsed from the fixture table</li>
        <li>UK TV channel names are extracted from text</li>
        <li>Results are filtered by team if specified</li>
      ` : ''}
      ${scraperId.startsWith('vps-') ? `
        <li>The Plesk app sends an HTTP POST request to the VPS scraper service at <code>${escapeHtml(VPS_SCRAPER_URL())}</code></li>
        <li>The VPS service launches a Puppeteer browser instance</li>
        <li>Puppeteer navigates to the target website and waits for dynamic content to load</li>
        <li>Page content is parsed and TV channel data is extracted</li>
        <li>Results are returned to the Plesk app in JSON format</li>
        <li>The VPS endpoint used is: <code>${escapeHtml(scraper.vpsEndpoint || '')}</code></li>
      ` : ''}
    </ol>
  </div>
  
  <p><a href="/admin/scrapers">← Back to Scrapers Dashboard</a></p>
  `;
  
  res.send(renderLayout(`${scraper.name} - Telegram Sports TV Bot`, body));
});

// --------- Scrape Results Storage Page ---------

// Import storage and auto-tester modules
const scrapeStore = require('./lib/scrape_store');
const autoTester = require('./lib/auto_tester');

app.get('/admin/results', (req, res) => {
  const scrapers = scrapeStore.listStoredScrapers();
  const { scraperId } = req.query;
  
  let selectedResults = null;
  let selectedScraper = null;
  
  if (scraperId) {
    selectedResults = scrapeStore.getResultHistory(scraperId, 10);
    selectedScraper = scraperId;
  }
  
  // Build scraper list
  const scraperList = scrapers.map(s => {
    const isSelected = s.scraperId === selectedScraper;
    const timestamp = s.latestTimestamp ? new Date(s.latestTimestamp).toLocaleString() : 'N/A';
    return `
    <tr class="${isSelected ? 'selected' : ''}">
      <td><a href="/admin/results?scraperId=${encodeURIComponent(s.scraperId)}">${escapeHtml(s.scraperId)}</a></td>
      <td>${timestamp}</td>
      <td>${s.resultCount}</td>
    </tr>`;
  }).join('');
  
  // Build results display
  let resultsHtml = '';
  if (selectedResults && selectedResults.length > 0) {
    resultsHtml = selectedResults.map((r, idx) => {
      const timestamp = new Date(r.timestamp).toLocaleString();
      const fixtureCount = r.metadata?.fixtureCount || 0;
      const duration = r.metadata?.duration_ms ? `${r.metadata.duration_ms}ms` : 'N/A';
      const resultsJson = JSON.stringify(r.results, null, 2);
      
      return `
      <div class="result-card">
        <div class="result-header">
          <span class="result-time">${timestamp}</span>
          <span class="result-meta">Fixtures: ${fixtureCount} | Duration: ${duration}</span>
        </div>
        <details ${idx === 0 ? 'open' : ''}>
          <summary>View Results</summary>
          <pre class="result-json">${escapeHtml(resultsJson)}</pre>
        </details>
      </div>`;
    }).join('');
  } else if (selectedScraper) {
    resultsHtml = '<p>No results stored for this scraper yet.</p>';
  }
  
  const body = `
  <style>
    .selected { background: #2a3f5f !important; }
    .result-card { background:#1e2a38; padding:16px; border-radius:8px; margin-bottom:16px; border-left:4px solid #4a90d9; }
    .result-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
    .result-time { font-weight:bold; color:#fff; }
    .result-meta { color:#888; font-size:12px; }
    .result-json { max-height:400px; overflow:auto; font-size:11px; background:#0d1b2a; padding:12px; border-radius:4px; }
    details summary { cursor:pointer; color:#80cbc4; margin-bottom:8px; }
  </style>
  
  <div class="card">
    <h2>Stored Scrape Results</h2>
    <p>View historical results from each scraper. Results are stored after each auto-test run and can be used for debugging or integration with the autoposter.</p>
  </div>
  
  <div class="card">
    <h3>Available Scrapers</h3>
    ${scrapers.length > 0 ? `
    <table>
      <thead>
        <tr>
          <th>Scraper ID</th>
          <th>Last Result</th>
          <th>Results Stored</th>
        </tr>
      </thead>
      <tbody>
        ${scraperList}
      </tbody>
    </table>
    ` : '<p>No scraped results stored yet. Run an auto-test to populate data.</p>'}
    
    <p style="margin-top:16px;">
      <a href="/admin/auto-test" class="btn-action">Run Auto-Test Now →</a>
    </p>
  </div>
  
  ${selectedScraper ? `
  <div class="card">
    <h3>Results for ${escapeHtml(selectedScraper)}</h3>
    ${resultsHtml}
  </div>
  ` : ''}
  `;
  
  res.send(renderLayout('Stored Results - Telegram Sports TV Bot', body));
});

// --------- Auto-Test Runner Page ---------

app.get('/admin/auto-test', async (req, res) => {
  const scrapers = autoTester.listScrapers();
  const autoTestResults = scrapeStore.getAllAutoTestResults(7);
  
  // Check if we should run a test
  const { run, scraperId } = req.query;
  let testResult = null;
  
  if (run === '1') {
    if (scraperId) {
      // Run single scraper test
      testResult = await autoTester.runScraperTest(scraperId, { storeResults: true });
    } else {
      // Run all tests
      testResult = await autoTester.runAllTests({ storeResults: true });
    }
  }
  
  // Build scraper cards
  const scraperCards = scrapers.map(s => {
    // Find latest test result for this scraper
    const latestTest = autoTestResults.find(r => r.scraperId === s.id);
    const lastStatus = latestTest?.success ? '✅ Pass' : (latestTest ? '❌ Fail' : '○ Not tested');
    const lastTime = latestTest?.timestamp ? new Date(latestTest.timestamp).toLocaleString() : 'Never';
    
    return `
    <div class="scraper-mini-card">
      <div class="mini-header">
        <span class="mini-name">${escapeHtml(s.name)}</span>
        <span class="mini-status">${lastStatus}</span>
      </div>
      <div class="mini-meta">
        <span>Last tested: ${lastTime}</span>
        <span>${s.requiresVPS ? '🖥️ VPS' : '☁️ HTTP'}</span>
      </div>
      <div class="mini-actions">
        <a href="/admin/auto-test?run=1&scraperId=${encodeURIComponent(s.id)}">Run Test</a>
        <a href="/admin/scraper/${encodeURIComponent(s.id)}">Details</a>
      </div>
    </div>`;
  }).join('');
  
  // Build test result display
  let testResultHtml = '';
  if (testResult) {
    if (testResult.results) {
      // All tests result
      const passCount = testResult.passed || 0;
      const failCount = testResult.failed || 0;
      const statusColor = testResult.allPassed ? '#00b894' : '#e74c3c';
      
      testResultHtml = `
      <div class="card" style="border-left: 4px solid ${statusColor};">
        <h3>${testResult.allPassed ? '✅ All Tests Passed' : '❌ Some Tests Failed'}</h3>
        <p>Passed: ${passCount} | Failed: ${failCount} | Duration: ${testResult.totalDurationMs}ms</p>
        <table>
          <thead><tr><th>Scraper</th><th>Status</th><th>Duration</th></tr></thead>
          <tbody>
            ${testResult.results.map(r => `
              <tr>
                <td>${escapeHtml(r.name)}</td>
                <td>${r.success ? '✅ Pass' : '❌ Fail'}</td>
                <td>${r.totalDurationMs}ms</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>`;
    } else {
      // Single test result
      const statusColor = testResult.success ? '#00b894' : '#e74c3c';
      testResultHtml = `
      <div class="card" style="border-left: 4px solid ${statusColor};">
        <h3>${testResult.success ? '✅' : '❌'} ${escapeHtml(testResult.name)} Test Result</h3>
        <p>Duration: ${testResult.totalDurationMs}ms</p>
        <table>
          <tr><th>Health Check</th><td>${testResult.health?.ok ? '✅ OK' : '❌ Fail'} ${testResult.health?.latencyMs ? `(${testResult.health.latencyMs}ms)` : ''}</td></tr>
          <tr><th>Functional Test</th><td>${testResult.functional?.success ? '✅ OK' : '❌ Fail'} ${testResult.functional?.durationMs ? `(${testResult.functional.durationMs}ms)` : ''}</td></tr>
        </table>
        ${testResult.functional?.error ? `<p class="error-msg">Error: ${escapeHtml(testResult.functional.error)}</p>` : ''}
      </div>`;
    }
  }
  
  const body = `
  <style>
    .scraper-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; margin: 20px 0; }
    .scraper-mini-card { background:#1e2a38; padding:16px; border-radius:8px; border-left:3px solid #4a90d9; }
    .mini-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }
    .mini-name { font-weight:bold; color:#fff; }
    .mini-status { font-size:12px; }
    .mini-meta { color:#888; font-size:11px; display:flex; justify-content:space-between; margin-bottom:12px; }
    .mini-actions { display:flex; gap:12px; }
    .mini-actions a { color:#80cbc4; font-size:13px; }
    .btn-action { display:inline-block; background:#00b894; color:#000; padding:10px 20px; border-radius:6px; text-decoration:none; font-weight:bold; }
    .btn-action:hover { background:#00d6aa; text-decoration:none; }
    .error-msg { color:#e74c3c; font-size:13px; margin-top:12px; }
  </style>
  
  <div class="card">
    <h2>Automated Scraper Testing</h2>
    <p>Run automated tests on all scrapers to verify they're working correctly. Test results are stored for later analysis.</p>
    
    <div style="margin-top:16px;">
      <a href="/admin/auto-test?run=1" class="btn-action">🚀 Run All Tests</a>
      <a href="/admin/results" style="margin-left:16px; color:#80cbc4;">View Stored Results →</a>
    </div>
  </div>
  
  ${testResultHtml}
  
  <div class="card">
    <h3>Individual Scrapers</h3>
    <p class="muted">Click "Run Test" to test a specific scraper, or "Details" for more information.</p>
    
    <div class="scraper-grid">
      ${scraperCards}
    </div>
  </div>
  
  <div class="card">
    <h3>Recent Test History</h3>
    ${autoTestResults.length > 0 ? `
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Scraper</th>
          <th>Status</th>
          <th>Duration</th>
        </tr>
      </thead>
      <tbody>
        ${autoTestResults.slice(0, 20).map(r => `
          <tr>
            <td>${new Date(r.timestamp).toLocaleString()}</td>
            <td>${escapeHtml(r.scraperId)}</td>
            <td>${r.success ? '✅ Pass' : '❌ Fail'}</td>
            <td>${r.totalDurationMs || 0}ms</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ` : '<p>No test history yet. Run some tests to see results here.</p>'}
  </div>
  `;
  
  res.send(renderLayout('Auto-Test - Telegram Sports TV Bot', body));
});

// --------- Health Endpoints ---------

// Unified health endpoint for all scrapers
app.get('/health', async (req, res) => {
  const status = await autoTester.getHealthStatus();
  res.status(status.allHealthy ? 200 : 503).json(status);
});

// Individual scraper health endpoints
app.get('/health/:scraperId', async (req, res) => {
  const { scraperId } = req.params;
  const result = await autoTester.runHealthCheck(scraperId);
  res.status(result.ok ? 200 : 503).json({
    scraperId,
    ...result
  });
});

// --------- start server ---------

app.listen(PORT, () => {
  console.log(`Admin GUI listening on port ${PORT}`);
});
