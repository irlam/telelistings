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
    <a href="/admin/logs">Logs</a>
    <a href="/admin/test-lstv">Test LSTV</a>
    <a href="/admin/test-fixture">Test Fixture</a>
    <a href="/admin/test-fixture-tv">Test TV Aggregator</a>
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
  const { botToken, timezone, icsUrl, icsDaysAhead, theSportsDbApiKey, liveSoccerTvEnabled, liveSoccerTvUsePuppeteer, defaultPosterStyle, posterFooterText } = req.body;
  const cfg = loadConfig();

  cfg.botToken = (botToken || '').trim();
  cfg.timezone = (timezone || '').trim() || 'Europe/London';
  cfg.icsUrl = (icsUrl || '').trim();
  cfg.icsDaysAhead = parseInt(icsDaysAhead, 10) || 1;
  cfg.theSportsDbApiKey = (theSportsDbApiKey || '').trim();
  cfg.liveSoccerTvEnabled = liveSoccerTvEnabled === 'true';
  cfg.liveSoccerTvUsePuppeteer = liveSoccerTvUsePuppeteer === 'true';
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

app.get('/health/lstv', async (req, res) => {
  const LSTV_SCRAPER_URL = process.env.LSTV_SCRAPER_URL || 'http://185.170.113.230:3333';
  const LSTV_SCRAPER_KEY = process.env.LSTV_SCRAPER_KEY || 'Q0tMx1sJ8nVh3w9L2z';
  
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

// --------- start server ---------

app.listen(PORT, () => {
  console.log(`Admin GUI listening on port ${PORT}`);
});
