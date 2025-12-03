// server.js
// VPS Scraper Microservice for Telelistings.
// Provides unified HTTP endpoints for all TV listing scrapers.

const express = require('express');
const puppeteer = require('puppeteer');

// ---------- Import all scraper modules ----------

const bbc = require('./scrapers/bbc');
const livefootballontv = require('./scrapers/livefootballontv');
const lstv = require('./scrapers/lstv');
const oddalerts = require('./scrapers/oddalerts');
const prosoccertv = require('./scrapers/prosoccertv');
const skysports = require('./scrapers/skysports');
const sporteventz = require('./scrapers/sporteventz');
const tnt = require('./scrapers/tnt');
const wheresthematch = require('./scrapers/wheresthematch');
const worldsoccertalk = require('./scrapers/worldsoccertalk');

// ---------- Configuration ----------

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3333;
const API_KEY = process.env.LSTV_SCRAPER_KEY || process.env.LSTV_API_KEY || 'Subaru5554346';

// List of all supported sources
const SUPPORTED_SOURCES = [
  { name: 'bbc', path: '/scrape/bbc', description: 'BBC Sport fixtures' },
  { name: 'livefootballontv', path: '/scrape/livefootballontv', description: 'Live Football On TV' },
  { name: 'lstv', path: '/scrape/lstv', description: 'LiveSoccerTV listings' },
  { name: 'oddalerts', path: '/scrape/oddalerts', description: 'OddAlerts TV Guide' },
  { name: 'prosoccertv', path: '/scrape/prosoccertv', description: 'ProSoccer.TV' },
  { name: 'skysports', path: '/scrape/skysports', description: 'Sky Sports fixtures' },
  { name: 'sporteventz', path: '/scrape/sporteventz', description: 'SportEventz' },
  { name: 'tnt', path: '/scrape/tnt', description: 'TNT Sports fixtures' },
  { name: 'wheresthematch', path: '/scrape/wheresthematch', description: 'Where\'s The Match UK' },
  { name: 'worldsoccertalk', path: '/scrape/worldsoccertalk', description: 'World Soccer Talk' }
];

// Simple in-memory browser instance reuse
let browser = null;

// ---------- Browser Management ----------

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

// ---------- Reusable Auth Middleware ----------

/**
 * Authentication middleware that checks for valid API key.
 */
function authMiddleware(req, res, next) {
  const key = req.header('x-api-key') || req.query.key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ---------- Helper to Add Scrape Routes ----------

/**
 * Add a POST endpoint for a scraper with consistent contract.
 * @param {string} path - Route path (e.g., '/scrape/lstv')
 * @param {Object} scraperModule - Scraper module with scrape() function
 * @param {string} sourceName - Source identifier for logging and response
 */
function addScrapeRoute(path, scraperModule, sourceName) {
  app.post(path, authMiddleware, async (req, res) => {
    try {
      const params = req.body || {};
      console.log(`[${sourceName.toUpperCase()}-SERVICE] Request:`, params);
      
      const result = await scraperModule.scrape(params);
      
      // Ensure source is set
      result.source = result.source || sourceName;
      
      res.json(result);
    } catch (err) {
      console.error(`[${sourceName.toUpperCase()}] error:`, err);
      res.status(500).json({ error: 'internal_error', source: sourceName });
    }
  });
}

// ---------- Register All Scrape Routes ----------

addScrapeRoute('/scrape/bbc', bbc, 'bbc');
addScrapeRoute('/scrape/livefootballontv', livefootballontv, 'livefootballontv');
addScrapeRoute('/scrape/lstv', lstv, 'lstv');
addScrapeRoute('/scrape/oddalerts', oddalerts, 'oddalerts');
addScrapeRoute('/scrape/prosoccertv', prosoccertv, 'prosoccertv');
addScrapeRoute('/scrape/skysports', skysports, 'skysports');
addScrapeRoute('/scrape/sporteventz', sporteventz, 'sporteventz');
addScrapeRoute('/scrape/tnt', tnt, 'tnt');
addScrapeRoute('/scrape/wheresthematch', wheresthematch, 'wheresthematch');
addScrapeRoute('/scrape/worldsoccertalk', worldsoccertalk, 'worldsoccertalk');

// ---------- Health Endpoints ----------

/**
 * Main health check endpoint - checks if service is running and browser works.
 * Also returns list of supported sources.
 */
app.get('/health', async (req, res) => {
  const started = Date.now();
  try {
    const browserInstance = await getBrowser();
    const page = await browserInstance.newPage();
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
      title,
      sources: SUPPORTED_SOURCES.map(s => s.name)
    });
  } catch (err) {
    const latency = Date.now() - started;
    console.error('[HEALTH] error:', err);
    res.status(500).json({
      ok: false,
      latencyMs: latency,
      error: err.message || String(err),
      sources: SUPPORTED_SOURCES.map(s => s.name)
    });
  }
});

/**
 * Sources endpoint - returns list of all supported sources with paths.
 */
app.get('/sources', (req, res) => {
  res.json({
    sources: SUPPORTED_SOURCES
  });
});

// ---------- Individual Health Check Endpoints ----------

/**
 * Helper to add health check endpoint for a scraper.
 * @param {string} path - Route path (e.g., '/health/bbc')
 * @param {Object} scraperModule - Scraper module with healthCheck() function
 */
function addHealthRoute(path, scraperModule) {
  app.get(path, async (req, res) => {
    try {
      if (typeof scraperModule.healthCheck === 'function') {
        const result = await scraperModule.healthCheck();
        res.status(result.ok ? 200 : 500).json(result);
      } else {
        res.status(501).json({ ok: false, error: 'Health check not implemented' });
      }
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

// Register health check routes for all scrapers
addHealthRoute('/health/bbc', bbc);
addHealthRoute('/health/livefootballontv', livefootballontv);
addHealthRoute('/health/lstv', lstv);
addHealthRoute('/health/oddalerts', oddalerts);
addHealthRoute('/health/prosoccertv', prosoccertv);
addHealthRoute('/health/skysports', skysports);
addHealthRoute('/health/sporteventz', sporteventz);
addHealthRoute('/health/tnt', tnt);
addHealthRoute('/health/wheresthematch', wheresthematch);
addHealthRoute('/health/worldsoccertalk', worldsoccertalk);

// ---------- Start Server ----------

app.listen(PORT, () => {
  console.log(`VPS Scraper microservice listening on port ${PORT}`);
  console.log(`Supported sources: ${SUPPORTED_SOURCES.map(s => s.name).join(', ')}`);
});
