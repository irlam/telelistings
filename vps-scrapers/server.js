// server.js
// Lightweight LiveSoccerTV scraper microservice.
// Runs on your VPS and is called remotely from your Plesk telelistings app.

const express = require('express');
const puppeteer = require('puppeteer');

// Import scrapers
const { fetchWheresTheMatchFixtures, healthCheck: wtmHealthCheck } = require('./scrapers/wheresthematch');
const { fetchOddAlertsFixtures, healthCheck: oddAlertsHealthCheck } = require('./scrapers/oddalerts');
const { fetchProSoccerFixtures, healthCheck: proSoccerHealthCheck } = require('./scrapers/prosoccertv');
const { fetchWorldSoccerTalkFixtures, healthCheck: wstHealthCheck } = require('./scrapers/worldsoccertalk');
const { fetchSportEventzFixtures, healthCheck: sportEventzHealthCheck } = require('./scrapers/sporteventz');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3333;
const API_KEY = process.env.LSTV_API_KEY || 'Subaru5554346';

// Simple in-memory browser instance reuse
let browser = null;

/**
 * Get (or launch) a Puppeteer browser.
 */
async function getBrowser() {
  if (browser && browser.isConnected()) {
    return browser;
  }
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
  return browser;
}

/**
 * Very simple placeholder scraper.
 * At the moment it:
 *  - goes to the LiveSoccerTV homepage
 *  - returns basic info + a dummy regionChannels array
 *
 * Later you can expand this to:
 *  - search for the specific fixture
 *  - open the match page
 *  - scrape the real TV listings table
 */
async function scrapeLSTV({ home, away, dateUtc, leagueHint }) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  const url = 'https://www.livesoccertv.com/';
  const started = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const title = await page.title();
  const latency = Date.now() - started;
  await page.close();

  return {
    url,
    kickoffUtc: dateUtc || null,
    league: leagueHint || null,
    regionChannels: [
      {
        region: 'Example Region',
        channel: 'Example Channel (replace with real data)'
      }
    ],
    meta: {
      title,
      latencyMs: latency
    }
  };
}

// Middleware to check API key
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!API_KEY || key !== API_KEY) {
    return res.status(403).json({ ok: false, error: 'Forbidden (bad API key)' });
  }
  next();
}

// Health endpoint (no auth, just to check Chrome works)
app.get('/health', async (req, res) => {
  const started = Date.now();
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.goto('https://www.livesoccertv.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    const title = await page.title();
    const latency = Date.now() - started;
    await page.close();

    res.json({
      ok: true,
      latencyMs: latency,
      title
    });
  } catch (err) {
    const latency = Date.now() - started;
    console.error('[LSTV-SERVICE][health] error:', err);
    res.status(500).json({
      ok: false,
      latencyMs: latency,
      error: err.message || String(err)
    });
  }
});

// Main scrape endpoint (auth required)
app.post('/scrape/lstv', requireApiKey, async (req, res) => {
  const { home, away, dateUtc, leagueHint } = req.body || {};
  console.log('[LSTV-SERVICE] Request:', { home, away, dateUtc, leagueHint });

  if (!home || !away) {
    return res.status(400).json({ ok: false, error: 'home and away are required' });
  }

  try {
    const result = await scrapeLSTV({ home, away, dateUtc, leagueHint });
    return res.json({
      ok: true,
      data: result
    });
  } catch (err) {
    console.error('[LSTV-SERVICE] scrape error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

// ============ Where's The Match ============
app.post('/scrape/wheresthematch', requireApiKey, async (req, res) => {
  const { date } = req.body || {};
  console.log('[WTM-SERVICE] Request:', { date });

  try {
    const result = await fetchWheresTheMatchFixtures({ date });
    return res.json({
      ok: true,
      data: result
    });
  } catch (err) {
    console.error('[WTM-SERVICE] scrape error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

app.get('/health/wheresthematch', async (req, res) => {
  try {
    const result = await wtmHealthCheck();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============ OddAlerts ============
app.post('/scrape/oddalerts', requireApiKey, async (req, res) => {
  const { date } = req.body || {};
  console.log('[ODDALERTS-SERVICE] Request:', { date });

  try {
    const result = await fetchOddAlertsFixtures({ date });
    return res.json({
      ok: true,
      data: result
    });
  } catch (err) {
    console.error('[ODDALERTS-SERVICE] scrape error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

app.get('/health/oddalerts', async (req, res) => {
  try {
    const result = await oddAlertsHealthCheck();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============ ProSoccer.TV ============
app.post('/scrape/prosoccertv', requireApiKey, async (req, res) => {
  const { leagueUrl } = req.body || {};
  console.log('[PROSOCCERTV-SERVICE] Request:', { leagueUrl });

  try {
    const result = await fetchProSoccerFixtures({ leagueUrl });
    return res.json({
      ok: true,
      data: result
    });
  } catch (err) {
    console.error('[PROSOCCERTV-SERVICE] scrape error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

app.get('/health/prosoccertv', async (req, res) => {
  try {
    const result = await proSoccerHealthCheck();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============ World Soccer Talk ============
app.post('/scrape/worldsoccertalk', requireApiKey, async (req, res) => {
  const { scheduleUrl } = req.body || {};
  console.log('[WST-SERVICE] Request:', { scheduleUrl });

  try {
    const result = await fetchWorldSoccerTalkFixtures({ scheduleUrl });
    return res.json({
      ok: true,
      data: result
    });
  } catch (err) {
    console.error('[WST-SERVICE] scrape error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

app.get('/health/worldsoccertalk', async (req, res) => {
  try {
    const result = await wstHealthCheck();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ============ SportEventz ============
app.post('/scrape/sporteventz', requireApiKey, async (req, res) => {
  const { date } = req.body || {};
  console.log('[SPORTEVENTZ-SERVICE] Request:', { date });

  try {
    const result = await fetchSportEventzFixtures({ date });
    return res.json({
      ok: true,
      data: result
    });
  } catch (err) {
    console.error('[SPORTEVENTZ-SERVICE] scrape error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || String(err)
    });
  }
});

app.get('/health/sporteventz', async (req, res) => {
  try {
    const result = await sportEventzHealthCheck();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`LiveSoccerTV scraper service listening on port ${PORT}`);
});
