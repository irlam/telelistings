// server.js
// VPS Scraper Microservice for Telelistings.
// Provides unified HTTP endpoints for all TV listing scrapers.

const express = require('express');
const puppeteer = require('puppeteer');
const crypto = require('crypto');

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
const liveonsat = safeRequire('./scrapers/liveonsat', 'liveonsat');
const lstv = safeRequire('./scrapers/lstv', 'lstv');
const skysports = safeRequire('./scrapers/skysports', 'skysports');
const premiersports = safeRequire('./scrapers/premiersports', 'premiersports');

// ---------- Configuration ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

const PORT = process.env.PORT || 3333;
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.LSTV_SCRAPER_KEY || process.env.LSTV_API_KEY || '';
const SCRAPE_CACHE_TTL_MS = Math.max(5, Number(process.env.SCRAPE_CACHE_MINUTES || 20)) * 60 * 1000;
const MAX_CONCURRENT_SCRAPES = Math.max(1, Math.min(Number(process.env.MAX_CONCURRENT_SCRAPES || 2), 3));
const REQUESTS_PER_MINUTE = Math.max(5, Math.min(Number(process.env.REQUESTS_PER_MINUTE || 30), 120));

if (!API_KEY) console.error('[SECURITY] LSTV_SCRAPER_KEY is required; scrape requests will be rejected.');

// List of all supported sources
const SUPPORTED_SOURCES = [
  { name: 'liveonsat', path: '/scrape/liveonsat', description: 'LiveOnSat UK Football (daily)' },
  { name: 'lstv', path: '/scrape/lstv', description: 'LiveSoccerTV listings' },
  { name: 'skysports', path: '/scrape/skysports', description: 'Official Sky Sports football listings' },
  { name: 'premiersports', path: '/scrape/premiersports', description: 'Official Premier Sports live football listings' }
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
    headless: true,
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

const requestCounters = new Map();
const scrapeCache = new Map();
const healthCache = new Map();
const HEALTH_CACHE_TTL_MS = 5 * 60 * 1000;
let activeScrapes = 0;
const scrapeWaiters = [];

function rateLimitMiddleware(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const current = requestCounters.get(key);
  if (!current || now >= current.resetAt) {
    requestCounters.set(key, { count: 1, resetAt: now + 60000 });
    if (requestCounters.size > 2000) {
      for (const [client, entry] of requestCounters) {
        if (now >= entry.resetAt) requestCounters.delete(client);
      }
    }
    return next();
  }
  current.count += 1;
  if (current.count > REQUESTS_PER_MINUTE) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((current.resetAt - now) / 1000))));
    return res.status(429).json({ error: 'rate_limited' });
  }
  next();
}

function safeKeyEquals(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
  }
  return value;
}

function scrapeCacheKey(source, params) {
  return crypto.createHash('sha256').update(`${source}|${JSON.stringify(stableObject(params))}`).digest('hex');
}

async function withScrapeSlot(task) {
  if (activeScrapes >= MAX_CONCURRENT_SCRAPES) {
    await new Promise((resolve) => scrapeWaiters.push(resolve));
  }
  activeScrapes += 1;
  try {
    return await task();
  } finally {
    activeScrapes -= 1;
    const next = scrapeWaiters.shift();
    if (next) next();
  }
}

/**
 * Authentication middleware that checks for valid API key.
 * Returns 403 Forbidden for missing or invalid keys.
 */
function authMiddleware(req, res, next) {
  const key = req.header('x-api-key');
  if (!API_KEY || !safeKeyEquals(key, API_KEY)) {
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
  
  app.post(path, rateLimitMiddleware, authMiddleware, async (req, res) => {
    try {
      const params = req.body || {};
      const cacheKey = scrapeCacheKey(sourceName, params);
      const cached = scrapeCache.get(cacheKey);
      if (cached && Date.now() - cached.createdAt < SCRAPE_CACHE_TTL_MS) {
        return res.json({
          ...cached.result,
          _meta: { ...(cached.result._meta || {}), cacheHit: true, cachedAt: new Date(cached.createdAt).toISOString() }
        });
      }

      console.log(`[${sourceName.toUpperCase()}-SERVICE] Scrape requested`);
      const rawResult = await withScrapeSlot(() => scraperModule.scrape(params));
      const result = rawResult && typeof rawResult === 'object' ? rawResult : { fixtures: [] };
      
      // Ensure source is set
      result.source = result.source || sourceName;
      result._meta = {
        ...(result._meta || {}),
        cacheHit: false,
        fetchedAt: new Date().toISOString()
      };
      scrapeCache.set(cacheKey, { result, createdAt: Date.now() });
      if (scrapeCache.size > 250) {
        const oldestKey = [...scrapeCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]?.[0];
        if (oldestKey) scrapeCache.delete(oldestKey);
      }
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

addScrapeRoute('/scrape/liveonsat', liveonsat, 'liveonsat');
addScrapeRoute('/scrape/lstv', lstv, 'lstv');
addScrapeRoute('/scrape/skysports', skysports, 'skysports');
addScrapeRoute('/scrape/premiersports', premiersports, 'premiersports');

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
          'x-api-key': '<your-api-key-here>'
        },
        body: {
          teamName: 'Arsenal' // example parameter - check scraper documentation for supported parameters
        }
      },
      availableEndpoints: {
        scrape: `POST ${path}`,
        health: `GET /health/${sourceName}`,
        sources: 'GET /sources',
        mainHealth: 'GET /health'
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
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    activeScrapes,
    queuedScrapes: scrapeWaiters.length,
    cachedRequests: scrapeCache.size,
    sources: SUPPORTED_SOURCES.map((source) => source.name)
  });
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
app.get('/debug/routes', authMiddleware, (req, res) => {
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
  
  app.get(path, rateLimitMiddleware, authMiddleware, async (req, res) => {
    try {
      if (typeof scraperModule.healthCheck === 'function') {
        const cached = healthCache.get(sourceName);
        if (cached && Date.now() - cached.createdAt < HEALTH_CACHE_TTL_MS) {
          return res.status(cached.result.ok ? 200 : 500).json({
            ...cached.result,
            cached: true
          });
        }
        const result = await scraperModule.healthCheck();
        healthCache.set(sourceName, { result, createdAt: Date.now() });
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
addHealthRoute('/health/liveonsat', liveonsat, 'liveonsat');
addHealthRoute('/health/lstv', lstv, 'lstv');
addHealthRoute('/health/skysports', skysports, 'skysports');
addHealthRoute('/health/premiersports', premiersports, 'premiersports');

// ---------- Start Server ----------

const server = app.listen(PORT, HOST, () => {
  console.log(`VPS Scraper microservice listening on ${HOST}:${PORT}`);
  console.log(`Registered routes: ${registeredRoutes.length}`);
  if (failedRoutes.length > 0) {
    console.warn(`Failed to register ${failedRoutes.length} routes:`, failedRoutes.map(r => r.source).join(', '));
  }
  console.log(`Supported sources: ${SUPPORTED_SOURCES.map(s => s.name).join(', ')}`);
});

async function shutdown(signal) {
  console.log(`[SHUTDOWN] ${signal} received`);
  server.close();
  if (browser && browser.isConnected()) {
    try { await browser.close(); } catch (_) {}
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
