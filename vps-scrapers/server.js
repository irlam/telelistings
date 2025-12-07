// server.js
// VPS Scraper Microservice for Telelistings.
// Provides unified HTTP endpoints for all TV listing scrapers.

const express = require('express');
const puppeteer = require('puppeteer');

// ---------- Import all scraper modules ----------
// Using safe module loading to prevent server crash if a module fails to load

/**
 * Safely load a scraper module without crashing the server.
 * If the module fails to load (e.g., missing dependencies, syntax error),
 * returns null and the corresponding routes will be skipped during registration.
 * 
 * @param {string} modulePath - Path to the module (e.g., './scrapers/bbc')
 * @param {string} moduleName - Name for logging purposes (e.g., 'bbc')
 * @returns {Object|null} The loaded module object with scrape() and healthCheck() functions,
 *                        or null if loading failed (error is logged to console)
 */
function safeRequire(modulePath, moduleName) {
  try {
    const mod = require(modulePath);
    console.log(`[INIT] Loaded module: ${moduleName}`);
    return mod;
  } catch (err) {
    console.error(`[INIT] Failed to load module '${moduleName}' from '${modulePath}': ${err.message}`);
    return null;
  }
}

// Load all scraper modules with error handling
const bbc = safeRequire('./scrapers/bbc', 'bbc');
const livefootballontv = safeRequire('./scrapers/livefootballontv', 'livefootballontv');
const liveonsat = safeRequire('./scrapers/liveonsat', 'liveonsat');
const lstv = safeRequire('./scrapers/lstv', 'lstv');
const oddalerts = safeRequire('./scrapers/oddalerts', 'oddalerts');
const prosoccertv = safeRequire('./scrapers/prosoccertv', 'prosoccertv');
const skysports = safeRequire('./scrapers/skysports', 'skysports');
const sporteventz = safeRequire('./scrapers/sporteventz', 'sporteventz');
const tnt = safeRequire('./scrapers/tnt', 'tnt');
const wheresthematch = safeRequire('./scrapers/wheresthematch', 'wheresthematch');
const worldsoccertalk = safeRequire('./scrapers/worldsoccertalk', 'worldsoccertalk');

// ---------- Configuration ----------

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3333;
const DEFAULT_API_KEY = 'Q0tMx1sJ8nVh3w9L2z';
const API_KEY = process.env.LSTV_SCRAPER_KEY || process.env.LSTV_API_KEY || DEFAULT_API_KEY;

// Warn if using default API key in production
if (API_KEY === DEFAULT_API_KEY) {
  console.warn('[WARNING] Using default API key. Set LSTV_SCRAPER_KEY environment variable for production use.');
}

// List of all supported sources
const SUPPORTED_SOURCES = [
  { name: 'bbc', path: '/scrape/bbc', description: 'BBC Sport fixtures' },
  { name: 'livefootballontv', path: '/scrape/livefootballontv', description: 'Live Football On TV' },
  { name: 'liveonsat', path: '/scrape/liveonsat', description: 'LiveOnSat UK Football (daily)' },
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
 * Returns 403 Forbidden for missing or invalid keys.
 */
function authMiddleware(req, res, next) {
  const key = req.header('x-api-key') || req.query.key;
  if (!key || key !== API_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

// ---------- Helper to Add Scrape Routes ----------

// Track which routes were successfully registered
const registeredRoutes = [];
const failedRoutes = [];

/**
 * Add a POST endpoint for a scraper with consistent contract.
 * Skips registration if the module is null (failed to load).
 * @param {string} path - Route path (e.g., '/scrape/lstv')
 * @param {Object|null} scraperModule - Scraper module with scrape() function, or null
 * @param {string} sourceName - Source identifier for logging and response
 */
function addScrapeRoute(path, scraperModule, sourceName) {
  // Skip if module failed to load
  if (!scraperModule) {
    console.warn(`[INIT] Skipping route ${path} - module '${sourceName}' not loaded`);
    failedRoutes.push({ path, source: sourceName, error: 'Module not loaded' });
    return;
  }
  
  // Check if module has scrape function
  if (typeof scraperModule.scrape !== 'function') {
    console.warn(`[INIT] Skipping route ${path} - module '${sourceName}' has no scrape() function`);
    failedRoutes.push({ path, source: sourceName, error: 'No scrape() function' });
    return;
  }
  
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
  
  registeredRoutes.push({ path, source: sourceName, method: 'POST' });
  console.log(`[INIT] Registered route: POST ${path}`);
}

// ---------- Register All Scrape Routes ----------

addScrapeRoute('/scrape/bbc', bbc, 'bbc');
addScrapeRoute('/scrape/livefootballontv', livefootballontv, 'livefootballontv');
addScrapeRoute('/scrape/liveonsat', liveonsat, 'liveonsat');
addScrapeRoute('/scrape/lstv', lstv, 'lstv');
addScrapeRoute('/scrape/oddalerts', oddalerts, 'oddalerts');
addScrapeRoute('/scrape/prosoccertv', prosoccertv, 'prosoccertv');
addScrapeRoute('/scrape/skysports', skysports, 'skysports');
addScrapeRoute('/scrape/sporteventz', sporteventz, 'sporteventz');
addScrapeRoute('/scrape/tnt', tnt, 'tnt');
addScrapeRoute('/scrape/wheresthematch', wheresthematch, 'wheresthematch');
addScrapeRoute('/scrape/worldsoccertalk', worldsoccertalk, 'worldsoccertalk');

// ---------- Add GET Handlers for Scrape Routes ----------
// These provide helpful information when accessed with GET instead of POST

/**
 * Helper to add GET info endpoint for a scraper route.
 * Returns information about the scraper and how to use it.
 * @param {string} path - Route path (e.g., '/scrape/liveonsat')
 * @param {string} sourceName - Source name for display
 * @param {string} description - Description of the scraper
 */
function addScrapeInfoRoute(path, sourceName, description) {
  app.get(path, (req, res) => {
    res.json({
      source: sourceName,
      description: description,
      method: 'POST',
      message: `This endpoint requires POST request. Use POST ${path} with JSON body.`,
      example: {
        url: path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'YOUR_API_KEY'
        },
        body: {
          teamName: 'Arsenal' // optional parameter example
        }
      },
      availableEndpoints: {
        scrape: `POST ${path}`,
        health: `GET /health/${sourceName}`,
        sources: 'GET /sources',
        allHealth: 'GET /health'
      }
    });
  });
}

// Add GET info routes for all scrapers
SUPPORTED_SOURCES.forEach(source => {
  addScrapeInfoRoute(source.path, source.name, source.description);
});

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
 * Also includes information about which routes are registered and which failed.
 */
app.get('/sources', (req, res) => {
  res.json({
    sources: SUPPORTED_SOURCES,
    registered: registeredRoutes,
    failed: failedRoutes
  });
});

/**
 * Debug endpoint - returns detailed information about registered routes.
 * Useful for diagnosing 404 errors and verifying deployment.
 */
app.get('/debug/routes', (req, res) => {
  res.json({
    server: {
      port: PORT,
      nodeVersion: process.version,
      platform: process.platform,
      uptime: process.uptime()
    },
    routes: {
      registered: registeredRoutes,
      failed: failedRoutes
    },
    sources: SUPPORTED_SOURCES
  });
});

// ---------- Individual Health Check Endpoints ----------

/**
 * Helper to add health check endpoint for a scraper.
 * Skips registration if the module is null (failed to load).
 * @param {string} path - Route path (e.g., '/health/bbc')
 * @param {Object|null} scraperModule - Scraper module with healthCheck() function, or null
 * @param {string} sourceName - Source name for error messages
 */
function addHealthRoute(path, scraperModule, sourceName) {
  // Skip if module failed to load
  if (!scraperModule) {
    console.warn(`[INIT] Skipping health route ${path} - module '${sourceName}' not loaded`);
    return;
  }
  
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
  
  registeredRoutes.push({ path, source: sourceName, method: 'GET' });
}

// Register health check routes for all scrapers
addHealthRoute('/health/bbc', bbc, 'bbc');
addHealthRoute('/health/livefootballontv', livefootballontv, 'livefootballontv');
addHealthRoute('/health/liveonsat', liveonsat, 'liveonsat');
addHealthRoute('/health/lstv', lstv, 'lstv');
addHealthRoute('/health/oddalerts', oddalerts, 'oddalerts');
addHealthRoute('/health/prosoccertv', prosoccertv, 'prosoccertv');
addHealthRoute('/health/skysports', skysports, 'skysports');
addHealthRoute('/health/sporteventz', sporteventz, 'sporteventz');
addHealthRoute('/health/tnt', tnt, 'tnt');
addHealthRoute('/health/wheresthematch', wheresthematch, 'wheresthematch');
addHealthRoute('/health/worldsoccertalk', worldsoccertalk, 'worldsoccertalk');

// ---------- Start Server ----------

app.listen(PORT, () => {
  console.log(`VPS Scraper microservice listening on port ${PORT}`);
  console.log(`Registered routes: ${registeredRoutes.length}`);
  if (failedRoutes.length > 0) {
    console.warn(`Failed to register ${failedRoutes.length} routes:`, failedRoutes.map(r => r.source).join(', '));
  }
  console.log(`Supported sources: ${SUPPORTED_SOURCES.map(s => s.name).join(', ')}`);
});
