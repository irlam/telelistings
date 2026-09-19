'use strict';

const puppeteer = require('puppeteer');
const axios = require('axios');
const { parseTvGuideText } = require('./tv_guide_parser');

const BASE_URL = 'https://www.skysports.com';
const PAGE_URL = `${BASE_URL}/watch/football-on-sky`;
const DEFAULT_TIMEOUT = 45000;
let browser;

function log(message) {
  console.log(`[${new Date().toISOString()}] [SKY-VPS] ${message}`);
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/[^>]+>/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function looksLikeGuide(text) {
  const value = String(text || '');
  return /match preview/i.test(value) && /sky sports/i.test(value) && /\b\d{1,2}:\d{2}\b/.test(value);
}

async function fetchHttpText() {
  const response = await axios.get(PAGE_URL, {
    timeout: 15000,
    maxContentLength: 5 * 1024 * 1024,
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-GB,en;q=0.9',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36'
    }
  });
  return htmlToText(response.data);
}

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  return browser;
}

async function fetchPageText() {
  try {
    const text = await fetchHttpText();
    if (looksLikeGuide(text)) {
      log('Loaded guide using lightweight HTTP');
      return text;
    }
    log(`HTTP response did not contain fixture rows (${text.length} characters); trying browser`);
  } catch (error) {
    log(`HTTP fetch unavailable (${error.message}); trying browser`);
  }

  const instance = await getBrowser();
  const page = await instance.newPage();
  try {
    await page.setViewport({ width: 1365, height: 900 });
    await page.goto(PAGE_URL, { waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT });
    await page.waitForSelector('body', { timeout: 10000 });
    try {
      await page.waitForFunction(
        () => /match preview/i.test(document.body.innerText) && /\b\d{1,2}:\d{2}\b/.test(document.body.innerText),
        { timeout: 20000 }
      );
    } catch (_) {
      // Return the body below so the health response can report a useful diagnostic.
    }
    return await page.evaluate(() => document.body.innerText);
  } finally {
    await page.close();
  }
}

async function scrape(params = {}) {
  log('Fetching official football-on-Sky listings');
  const text = await fetchPageText();
  let fixtures = parseTvGuideText(text, { date: params.date, defaultLive: true, defaultChannel: 'Sky Sports' });
  if (params.teamName) {
    const needle = params.teamName.toLowerCase();
    fixtures = fixtures.filter((fixture) => `${fixture.homeTeam} ${fixture.awayTeam}`.toLowerCase().includes(needle));
  }
  log(`Found ${fixtures.length} live football fixtures`);
  return { fixtures, source: 'skysports' };
}

async function healthCheck() {
  const started = Date.now();
  try {
    const text = await fetchPageText();
    const fixtures = parseTvGuideText(text, { defaultLive: true, defaultChannel: 'Sky Sports' });
    return {
      ok: text.length > 500 && fixtures.length > 0,
      latencyMs: Date.now() - started,
      fixtures: fixtures.length,
      title: 'Official Sky Sports football TV listings',
      message: fixtures.length > 0
        ? 'Sky fixture rows parsed successfully'
        : `Sky page loaded (${text.length} characters) but no fixture rows were parsed`
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error.message };
  }
}

module.exports = { scrape, healthCheck, fetchPageText, fetchHttpText, htmlToText, looksLikeGuide, PAGE_URL, BASE_URL };
