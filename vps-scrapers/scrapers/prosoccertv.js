// scrapers/prosoccertv.js
// ProSoccer.TV scraper with Puppeteer support for VPS.
// This version uses Puppeteer for reliable scraping of JavaScript-rendered content.
/**
 * VPS ProSoccer.TV Scraper
 *
 * Uses Puppeteer for browser automation to handle JavaScript-rendered content.
 * Can be run as a standalone service or integrated into the main VPS server.
 *
 * Exports fetchProSoccerFixtures({ leagueUrl }) which:
 * - Uses Puppeteer to load ProSoccer.TV pages
 * - Handles fixtures grouped by country/league
 * - Clicks "TV" links to get broadcasting channels
 *
 * Returns:
 * {
 *   fixtures: Array<{
 *     home: string,
 *     away: string,
 *     kickoffUtc: string | null,
 *     competition: string | null,
 *     channels: string[]
 *   }>
 * }
 */

const puppeteer = require('puppeteer');

// ---------- Configuration ----------

const BASE_URL = 'https://prosoccer.tv';
const DEFAULT_TIMEOUT = 30000;

// Known TV channels for football
const TV_CHANNELS = [
  'Sky Sports Main Event',
  'Sky Sports Premier League',
  'Sky Sports Football',
  'Sky Sports',
  'TNT Sports 1',
  'TNT Sports 2',
  'TNT Sports 3',
  'TNT Sports 4',
  'TNT Sports',
  'BBC One',
  'BBC Two',
  'BBC iPlayer',
  'ITV1',
  'ITV4',
  'ITVX',
  'Channel 4',
  'Amazon Prime Video',
  'Amazon Prime',
  'Premier Sports 1',
  'Premier Sports 2',
  'Premier Sports',
  'BT Sport 1',
  'BT Sport 2',
  'BT Sport 3',
  'LaLigaTV',
  'FreeSports',
  'discovery+',
  'DAZN',
  'ESPN',
  'ESPN+',
  'beIN Sports',
  'Paramount+',
  'Peacock',
  'fuboTV',
  'CBS Sports'
];

// Shared browser instance
let browser = null;

// ---------- Logging ----------

function log(msg) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [PROSOCCERTV-VPS] ${msg}`);
}

// ---------- Browser Management ----------

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

// ---------- Helpers ----------

function normalizeTeamName(name) {
  return (name || '')
    .trim()
    .replace(/\b(fc|afc|cf|sc|ac)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeChannelName(name) {
  return (name || '')
    .trim()
    .replace(/\s+/g, ' ')
    .trim();
}

function extractChannels(text) {
  if (!text) return [];
  
  const channels = [];
  const textLower = text.toLowerCase();
  
  for (const channel of TV_CHANNELS) {
    if (textLower.includes(channel.toLowerCase())) {
      channels.push(channel);
    }
  }
  
  return [...new Set(channels)];
}

// ---------- Main Function ----------

async function fetchProSoccerFixtures({ leagueUrl } = {}) {
  const emptyResult = { fixtures: [] };
  
  const url = leagueUrl || BASE_URL;
  log(`Fetching fixtures from: ${url}`);
  
  let page = null;
  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: DEFAULT_TIMEOUT
    });
    
    // Wait for content to load
    await page.waitForSelector('body', { timeout: 10000 });
    
    // Extract fixtures using page.evaluate
    const fixtures = await page.evaluate((TV_CHANNELS) => {
      const results = [];
      
      // Known competition/league keywords to filter out as team names
      const competitionKeywords = [
        'primera', 'clausura', 'apertura', 'league', 'cup', 'championship',
        'division', 'serie', 'liga', 'bundesliga', 'ligue', 'eredivisie',
        'premier', 'la liga', 'calcio', 'round', 'matchday', 'group',
        'stage', 'final', 'semi', 'quarter', 'knockout', 'playoff'
      ];
      
      // Function to check if text looks like a competition name rather than team name
      function looksLikeCompetition(text) {
        if (!text) return false;
        const lower = text.toLowerCase().trim();
        return competitionKeywords.some(kw => lower.includes(kw)) ||
               /^\d+$/.test(lower) || // Just numbers
               lower.length < 3; // Too short
      }
      
      // Track current competition from group headers
      let currentCompetition = null;
      
      // ProSoccer.TV typically uses tables with fixtures
      // Look for table rows that contain match information
      const tables = document.querySelectorAll('table');
      
      tables.forEach(table => {
        const rows = table.querySelectorAll('tr');
        
        rows.forEach(row => {
          try {
            const text = row.innerText || row.textContent || '';
            const cells = row.querySelectorAll('td');
            
            // Skip header rows
            if (row.querySelector('th')) return;
            
            // Skip rows with too few cells (likely headers or spacers)
            if (cells.length < 2) {
              // Could be a competition header row
              const headerText = text.trim();
              if (headerText && headerText.length > 2 && headerText.length < 100) {
                currentCompetition = headerText;
              }
              return;
            }
            
            // Extract teams - look for vs/v pattern first
            let homeTeam = '';
            let awayTeam = '';
            
            // Try to find match pattern in the row text
            const vsMatch = text.match(/([A-Za-zÀ-ÿ\s\-'\.0-9]+?)\s+(?:v|vs|versus|–|[-–—])\s+([A-Za-zÀ-ÿ\s\-'\.0-9]+?)(?:\s|$)/i);
            if (vsMatch) {
              homeTeam = vsMatch[1].trim();
              awayTeam = vsMatch[2].trim();
            }
            
            // Alternatively, look for team links
            if (!homeTeam || !awayTeam) {
              const teamLinks = row.querySelectorAll('a');
              const potentialTeams = [];
              teamLinks.forEach(link => {
                const linkText = link.innerText.trim();
                // Filter out TV/broadcast links and short text
                if (linkText && 
                    linkText.length > 2 && 
                    !linkText.toLowerCase().includes('tv') &&
                    !looksLikeCompetition(linkText)) {
                  potentialTeams.push(linkText);
                }
              });
              if (potentialTeams.length >= 2) {
                homeTeam = potentialTeams[0];
                awayTeam = potentialTeams[1];
              }
            }
            
            // Skip if teams look like competition names
            if (looksLikeCompetition(homeTeam) || looksLikeCompetition(awayTeam)) {
              return;
            }
            
            // Clean up team names
            homeTeam = homeTeam
              .replace(/\b(fc|afc|cf|sc|ac)\b/gi, '')
              .replace(/\s+/g, ' ')
              .replace(/^\d+\.\s*/, '') // Remove leading numbers like "1. "
              .trim();
            awayTeam = awayTeam
              .replace(/\b(fc|afc|cf|sc|ac)\b/gi, '')
              .replace(/\s+/g, ' ')
              .replace(/^\d+\.\s*/, '')
              .trim();
            
            // Skip if no valid teams found
            if (!homeTeam || !awayTeam || homeTeam.length < 3 || awayTeam.length < 3) return;
            
            // Skip if home and away are the same
            if (homeTeam.toLowerCase() === awayTeam.toLowerCase()) return;
            
            // Extract kickoff time/date
            let kickoffUtc = null;
            const timeEl = row.querySelector('time, [datetime], .time, .kickoff, .date, .ko');
            if (timeEl) {
              kickoffUtc = timeEl.getAttribute('datetime') || timeEl.innerText.trim() || null;
            }
            
            // Try to find time pattern in text
            if (!kickoffUtc) {
              const timeMatch = text.match(/(\d{1,2}[:\.]?\d{2}\s*(am|pm)?)/i);
              if (timeMatch) {
                kickoffUtc = timeMatch[1];
              }
            }
            
            // Extract competition from row or use tracked competition
            let competition = currentCompetition;
            const compEl = row.querySelector('.competition, .league, [class*="competition"], [class*="league"]');
            if (compEl) {
              competition = compEl.innerText.trim();
            }
            
            // Extract TV channels
            const channels = [];
            const textLower = text.toLowerCase();
            for (const channel of TV_CHANNELS) {
              if (textLower.includes(channel.toLowerCase())) {
                channels.push(channel);
              }
            }
            
            // Look for TV link and extract channel info from it
            const tvLink = row.querySelector('a[href*="tv"], .tv-link, [class*="tv"], .channels');
            if (tvLink) {
              const tvText = tvLink.innerText.trim();
              if (tvText && !channels.includes(tvText)) {
                // Parse individual channels from TV link text
                const tvChannels = tvText.split(/[,;\/]/).map(c => c.trim()).filter(c => c);
                tvChannels.forEach(ch => {
                  if (!channels.includes(ch)) {
                    channels.push(ch);
                  }
                });
              }
            }
            
            // Also look for channel-specific elements
            const channelEls = row.querySelectorAll('.channel, .broadcaster, [class*="channel"], [class*="broadcaster"]');
            channelEls.forEach(chEl => {
              const chText = chEl.innerText.trim();
              if (chText && !channels.includes(chText)) {
                channels.push(chText);
              }
            });
            
            results.push({
              home: homeTeam,
              away: awayTeam,
              kickoffUtc,
              competition,
              channels: [...new Set(channels.map(c => c.trim()).filter(c => c))]
            });
          } catch (e) {
            // Skip malformed fixtures
          }
        });
      });
      
      // If table parsing didn't work, try general element selectors
      if (results.length === 0) {
        const fixtureSelectors = [
          '.match-row',
          '.fixture-row',
          '.fixture',
          '.match',
          '[class*="match"]',
          '[class*="fixture"]',
          '.event',
          '.game-row'
        ];
        
        for (const selector of fixtureSelectors) {
          const elements = document.querySelectorAll(selector);
          
          elements.forEach(el => {
            try {
              const text = el.innerText || el.textContent || '';
              
              // Check if this is a header/competition row
              const isHeader = el.classList.contains('header') || 
                             el.querySelector('th') ||
                             el.classList.contains('league');
              
              if (isHeader) {
                currentCompetition = text.trim();
                return;
              }
              
              // Extract teams using vs pattern
              const vsMatch = text.match(/([A-Za-zÀ-ÿ\s\-'\.0-9]+?)\s+(?:v|vs|versus|–|[-–—])\s+([A-Za-zÀ-ÿ\s\-'\.0-9]+?)(?:\s|$)/i);
              if (!vsMatch) return;
              
              let homeTeam = vsMatch[1].trim()
                .replace(/\b(fc|afc|cf|sc|ac)\b/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
              let awayTeam = vsMatch[2].trim()
                .replace(/\b(fc|afc|cf|sc|ac)\b/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
              
              // Skip if teams look like competition names
              if (looksLikeCompetition(homeTeam) || looksLikeCompetition(awayTeam)) {
                return;
              }
              
              if (!homeTeam || !awayTeam || homeTeam.length < 3 || awayTeam.length < 3) return;
              
              // Extract kickoff time
              let kickoffUtc = null;
              const timeMatch = text.match(/(\d{1,2}[:\.]?\d{2}\s*(am|pm)?)/i);
              if (timeMatch) {
                kickoffUtc = timeMatch[1];
              }
              
              // Extract TV channels
              const channels = [];
              const textLower = text.toLowerCase();
              for (const channel of TV_CHANNELS) {
                if (textLower.includes(channel.toLowerCase())) {
                  channels.push(channel);
                }
              }
              
              results.push({
                home: homeTeam,
                away: awayTeam,
                kickoffUtc,
                competition: currentCompetition,
                channels: [...new Set(channels)]
              });
            } catch (e) {
              // Skip malformed fixtures
            }
          });
          
          if (results.length > 0) break;
        }
      }
      
      return results;
    }, TV_CHANNELS);
    
    await page.close();
    page = null;
    
    log(`Found ${fixtures.length} fixtures`);
    return { fixtures };
    
  } catch (err) {
    log(`Error fetching fixtures: ${err.message}`);
    if (page) {
      try { await page.close(); } catch (e) { /* ignore */ }
    }
    return emptyResult;
  }
}

async function healthCheck() {
  const startTime = Date.now();
  let page = null;
  
  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();
    
    await page.goto(BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_TIMEOUT
    });
    
    const title = await page.title();
    
    // Check for expected content "Live Soccer on TV"
    const hasExpectedContent = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('live soccer on tv') || 
             text.includes('soccer on tv') || 
             text.includes('football on tv') ||
             text.includes('prosoccer');
    });
    
    await page.close();
    page = null;
    
    const latencyMs = Date.now() - startTime;
    log(`[health] ${hasExpectedContent ? 'OK' : 'WARN'} in ${latencyMs}ms`);
    return { ok: hasExpectedContent, latencyMs, title };
    
  } catch (err) {
    if (page) {
      try { await page.close(); } catch (e) { /* ignore */ }
    }
    const latencyMs = Date.now() - startTime;
    log(`[health] FAIL in ${latencyMs}ms: ${err.message}`);
    return { ok: false, latencyMs, error: err.message };
  }
}

// ---------- Unified Scrape Function ----------

/**
 * Unified scrape function with consistent signature.
 * @param {Object} params - Parameters
 * @param {string} [params.leagueUrl] - League URL to scrape
 * @returns {Promise<{fixtures: Array, source: string}>}
 */
async function scrape(params = {}) {
  const result = await fetchProSoccerFixtures(params);
  
  // Normalize to consistent format
  const fixtures = (result.fixtures || []).map(f => ({
    homeTeam: f.home || null,
    awayTeam: f.away || null,
    kickoffUtc: f.kickoffUtc || null,
    league: null,
    competition: f.competition || null,
    url: null,
    channels: f.channels || []
  }));
  
  return {
    fixtures,
    source: 'prosoccertv'
  };
}

// ---------- Module Exports ----------

module.exports = {
  scrape,
  fetchProSoccerFixtures,
  healthCheck,
  normalizeTeamName,
  normalizeChannelName,
  extractChannels,
  TV_CHANNELS,
  BASE_URL
};

// Allow running as standalone
if (require.main === module) {
  (async () => {
    console.log('Running ProSoccer.TV VPS Scraper health check...');
    const result = await healthCheck();
    console.log('Result:', result);
    
    if (result.ok) {
      console.log('\nFetching fixtures...');
      const fixtures = await fetchProSoccerFixtures();
      console.log('Fixtures:', JSON.stringify(fixtures, null, 2));
    }
    
    process.exit(result.ok ? 0 : 1);
  })();
}
