// lib/scrape_store.js
// Persistent storage for scrape results.
/**
 * Telegram Sports TV Bot – Scrape Result Storage
 *
 * This module provides persistent storage for scrape results.
 * Results are stored as JSON files in the storage/ directory.
 *
 * Features:
 * - Store results from any scraper with timestamp and metadata
 * - Retrieve latest results for each scraper
 * - Keep history of past results (configurable retention)
 * - Query results by scraper, date, or fixture
 *
 * Storage format:
 * storage/
 *   scrapes/
 *     {scraperId}/
 *       {YYYY-MM-DD}_{timestamp}.json
 *   latest/
 *     {scraperId}.json
 *   auto_tests/
 *     {scraperId}_{YYYY-MM-DD}.json
 */

const fs = require('fs');
const path = require('path');

// ---------- Configuration ----------

const STORAGE_ROOT = path.join(__dirname, '..', 'storage');
const SCRAPES_DIR = path.join(STORAGE_ROOT, 'scrapes');
const LATEST_DIR = path.join(STORAGE_ROOT, 'latest');
const AUTO_TESTS_DIR = path.join(STORAGE_ROOT, 'auto_tests');

// Maximum number of result files to keep per scraper
const MAX_RESULTS_PER_SCRAPER = 30;

// ---------- Initialization ----------

/**
 * Ensure storage directories exist.
 */
function initStorage() {
  const dirs = [STORAGE_ROOT, SCRAPES_DIR, LATEST_DIR, AUTO_TESTS_DIR];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

// Initialize on module load
initStorage();

// ---------- Helpers ----------

/**
 * Get timestamp string for filenames.
 * @returns {string} e.g., "2024-12-15_143052"
 */
function getTimestamp() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  return `${date}_${time}`;
}

/**
 * Get date string for filenames.
 * @param {Date} [date] - Date object, defaults to now
 * @returns {string} e.g., "2024-12-15"
 */
function getDateString(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Ensure scraper directory exists.
 * @param {string} scraperId - Scraper identifier
 * @returns {string} Path to scraper directory
 */
function ensureScraperDir(scraperId) {
  const dir = path.join(SCRAPES_DIR, scraperId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Clean old files from a directory, keeping only the latest N.
 * @param {string} dir - Directory path
 * @param {number} maxFiles - Maximum files to keep
 */
function cleanOldFiles(dir, maxFiles) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse(); // newest first
    
    if (files.length > maxFiles) {
      const toDelete = files.slice(maxFiles);
      for (const file of toDelete) {
        fs.unlinkSync(path.join(dir, file));
      }
    }
  } catch (err) {
    // Ignore errors
  }
}

// ---------- Core Storage Functions ----------

/**
 * Store scrape results for a scraper.
 *
 * @param {string} scraperId - Unique scraper identifier (e.g., 'lstv', 'tsdb')
 * @param {Object} results - Scrape results data
 * @param {Object} [metadata={}] - Additional metadata (duration, error, etc.)
 * @returns {{success: boolean, filePath: string | null, error: string | null}}
 */
function storeResults(scraperId, results, metadata = {}) {
  try {
    initStorage();
    
    const timestamp = getTimestamp();
    const scraperDir = ensureScraperDir(scraperId);
    
    // Build result object
    const resultObj = {
      scraperId,
      timestamp: new Date().toISOString(),
      metadata: {
        duration_ms: metadata.duration_ms || null,
        fixtureCount: Array.isArray(results) ? results.length : (results.fixtures?.length || results.matches?.length || 0),
        error: metadata.error || null,
        ...metadata
      },
      results
    };
    
    // Save to scraper-specific directory
    const fileName = `${timestamp}.json`;
    const filePath = path.join(scraperDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(resultObj, null, 2), 'utf8');
    
    // Also save as "latest" for quick access
    const latestPath = path.join(LATEST_DIR, `${scraperId}.json`);
    fs.writeFileSync(latestPath, JSON.stringify(resultObj, null, 2), 'utf8');
    
    // Clean old files
    cleanOldFiles(scraperDir, MAX_RESULTS_PER_SCRAPER);
    
    return { success: true, filePath, error: null };
    
  } catch (err) {
    return { success: false, filePath: null, error: err.message };
  }
}

/**
 * Get the latest results for a scraper.
 *
 * @param {string} scraperId - Scraper identifier
 * @returns {Object | null} Latest results or null
 */
function getLatestResults(scraperId) {
  try {
    const latestPath = path.join(LATEST_DIR, `${scraperId}.json`);
    if (fs.existsSync(latestPath)) {
      const content = fs.readFileSync(latestPath, 'utf8');
      return JSON.parse(content);
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Get all stored results for a scraper.
 *
 * @param {string} scraperId - Scraper identifier
 * @param {number} [limit=10] - Maximum results to return
 * @returns {Array<Object>} Array of result objects (newest first)
 */
function getResultHistory(scraperId, limit = 10) {
  try {
    const scraperDir = path.join(SCRAPES_DIR, scraperId);
    if (!fs.existsSync(scraperDir)) {
      return [];
    }
    
    const files = fs.readdirSync(scraperDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, limit);
    
    return files.map(f => {
      try {
        const content = fs.readFileSync(path.join(scraperDir, f), 'utf8');
        return JSON.parse(content);
      } catch (err) {
        return null;
      }
    }).filter(Boolean);
    
  } catch (err) {
    return [];
  }
}

/**
 * Get list of all scrapers with stored results.
 *
 * @returns {Array<{scraperId: string, latestTimestamp: string | null, resultCount: number}>}
 */
function listStoredScrapers() {
  try {
    const scrapers = [];
    
    if (fs.existsSync(SCRAPES_DIR)) {
      const dirs = fs.readdirSync(SCRAPES_DIR);
      
      for (const scraperId of dirs) {
        const scraperDir = path.join(SCRAPES_DIR, scraperId);
        if (fs.statSync(scraperDir).isDirectory()) {
          const files = fs.readdirSync(scraperDir).filter(f => f.endsWith('.json'));
          const latest = getLatestResults(scraperId);
          
          scrapers.push({
            scraperId,
            latestTimestamp: latest?.timestamp || null,
            resultCount: files.length
          });
        }
      }
    }
    
    return scrapers;
    
  } catch (err) {
    return [];
  }
}

// ---------- Auto-Test Storage ----------

/**
 * Store auto-test results for a scraper.
 *
 * @param {string} scraperId - Scraper identifier
 * @param {Object} testResult - Test result object
 * @returns {{success: boolean, error: string | null}}
 */
function storeAutoTestResult(scraperId, testResult) {
  try {
    initStorage();
    
    const date = getDateString();
    const filePath = path.join(AUTO_TESTS_DIR, `${scraperId}_${date}.json`);
    
    // Build result object
    const resultObj = {
      scraperId,
      date,
      timestamp: new Date().toISOString(),
      ...testResult
    };
    
    fs.writeFileSync(filePath, JSON.stringify(resultObj, null, 2), 'utf8');
    return { success: true, error: null };
    
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get auto-test results for a scraper on a specific date.
 *
 * @param {string} scraperId - Scraper identifier
 * @param {string} [date] - Date string (YYYY-MM-DD), defaults to today
 * @returns {Object | null} Auto-test results or null
 */
function getAutoTestResult(scraperId, date = null) {
  try {
    const dateStr = date || getDateString();
    const filePath = path.join(AUTO_TESTS_DIR, `${scraperId}_${dateStr}.json`);
    
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Get all auto-test results for all scrapers.
 *
 * @param {number} [days=7] - Number of days to look back
 * @returns {Array<Object>} Array of auto-test results
 */
function getAllAutoTestResults(days = 7) {
  try {
    if (!fs.existsSync(AUTO_TESTS_DIR)) {
      return [];
    }
    
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    
    const files = fs.readdirSync(AUTO_TESTS_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();
    
    return files.map(f => {
      try {
        const content = fs.readFileSync(path.join(AUTO_TESTS_DIR, f), 'utf8');
        const result = JSON.parse(content);
        
        // Filter by date
        if (new Date(result.timestamp) >= cutoff) {
          return result;
        }
        return null;
      } catch (err) {
        return null;
      }
    }).filter(Boolean);
    
  } catch (err) {
    return [];
  }
}

// ---------- Aggregated Fixtures Storage ----------

/**
 * Store aggregated fixtures for today.
 *
 * @param {Array} fixtures - Array of fixture objects
 * @param {Object} [metadata={}] - Additional metadata
 * @returns {{success: boolean, error: string | null}}
 */
function storeTodaysFixtures(fixtures, metadata = {}) {
  return storeResults('aggregated_fixtures', {
    date: getDateString(),
    fixtures,
    ...metadata
  }, {
    fixtureCount: fixtures.length,
    ...metadata
  });
}

/**
 * Get today's aggregated fixtures.
 *
 * @returns {Object | null} Today's fixtures or null
 */
function getTodaysFixtures() {
  return getLatestResults('aggregated_fixtures');
}

// ---------- Module Exports ----------

module.exports = {
  // Core storage
  storeResults,
  getLatestResults,
  getResultHistory,
  listStoredScrapers,
  
  // Auto-test storage
  storeAutoTestResult,
  getAutoTestResult,
  getAllAutoTestResults,
  
  // Aggregated fixtures
  storeTodaysFixtures,
  getTodaysFixtures,
  
  // Helpers
  getTimestamp,
  getDateString,
  initStorage,
  
  // Constants
  STORAGE_ROOT,
  SCRAPES_DIR,
  LATEST_DIR,
  AUTO_TESTS_DIR
};
