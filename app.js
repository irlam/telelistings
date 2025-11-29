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
const { execFile } = require('child_process');
const { runOnce, CONFIG_PATH, LOG_PATH } = require('./autopost');

const app = express();
const PORT = process.env.PORT || 3000;

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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

app.get('/admin/channels', (req, res) => {
  const cfg = loadConfig();
  const channels = cfg.channels || [];

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
          '<tr><td colspan="6">No channels yet. Add one below.</td></tr>'
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
          <input type="checkbox" name="posterStyle" value="true">
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
          <input type="checkbox" name="posterStyle" value="true" ${ch.posterStyle ? 'checked' : ''}>
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
  `;

  res.send(renderLayout('Settings - Telegram Sports TV Bot', body));
});

app.post('/admin/settings', (req, res) => {
  const { botToken, timezone, icsUrl, icsDaysAhead, theSportsDbApiKey } = req.body;
  const cfg = loadConfig();

  cfg.botToken = (botToken || '').trim();
  cfg.timezone = (timezone || '').trim() || 'Europe/London';
  cfg.icsUrl = (icsUrl || '').trim();
  cfg.icsDaysAhead = parseInt(icsDaysAhead, 10) || 1;
  cfg.theSportsDbApiKey = (theSportsDbApiKey || '').trim();

  saveConfig(cfg);
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

// --------- start server ---------

app.listen(PORT, () => {
  console.log(`Admin GUI listening on port ${PORT}`);
});
