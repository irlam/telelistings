'use strict';

const puppeteer = require('puppeteer');
const { parseTvGuideText } = require('./tv_guide_parser');

const BASE_URL = 'https://www.premiersports.com';
const PAGE_URLS = [
  `${BASE_URL}/gb/tv-guide`,
  `${BASE_URL}/tv-guide`,
  `${BASE_URL}/gb/upcoming-fixtures`,
  `${BASE_URL}/ie`,
  'https://premiersportsireland.com/'
];
const DEFAULT_TIMEOUT = 45000;
let browser;

function log(message) {
  console.log(`[${new Date().toISOString()}] [PREMIERSPORTS-VPS] ${message}`);
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
  const instance = await getBrowser();
  let lastError;
  for (const url of PAGE_URLS) {
    const page = await instance.newPage();
    try {
      await page.setViewport({ width: 1365, height: 900 });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: DEFAULT_TIMEOUT });
      await page.waitForSelector('body', { timeout: 10000 });
      const text = await page.evaluate(() => document.body.innerText);
      if (text.length > 500 && /premier sports|ps one|fixtures/i.test(text)) return { text, url };
    } catch (error) {
      lastError = error;
    } finally {
      await page.close();
    }
  }
  throw lastError || new Error('Premier Sports TV guide did not return usable content');
}

async function scrape(params = {}) {
  log('Fetching official Premier Sports listings');
  const { text, url } = await fetchPageText();
  let fixtures = parseTvGuideText(text, { date: params.date, defaultLive: false, defaultChannel: 'Premier Sports 1' });
  if (params.teamName) {
    const needle = params.teamName.toLowerCase();
    fixtures = fixtures.filter((fixture) => `${fixture.homeTeam} ${fixture.awayTeam}`.toLowerCase().includes(needle));
  }
  log(`Found ${fixtures.length} explicitly live football fixtures`);
  return { fixtures, source: 'premiersports', _meta: { pageUrl: url } };
}

async function healthCheck() {
  const started = Date.now();
  try {
    const { text, url } = await fetchPageText();
    const fixtures = parseTvGuideText(text, { defaultLive: false, defaultChannel: 'Premier Sports 1' });
    return {
      ok: text.length > 500,
      latencyMs: Date.now() - started,
      fixtures: fixtures.length,
      title: 'Official Premier Sports TV guide',
      url
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error.message };
  }
}

module.exports = { scrape, healthCheck, fetchPageText, PAGE_URLS, BASE_URL };
