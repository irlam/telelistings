// puppeteer-example.js
// Description: Example Node script using puppeteer-core with the system Chrome/Chromium binary on a VPS.
// Date: 04/12/2025 (UK format)
// Usage:
//   npm init -y
//   npm install puppeteer-core
//   node puppeteer-example.js
//
// Notes:
// - This uses puppeteer-core so it doesn't download its own Chromium. We use the system chrome installed by the shell script.
// - If you installed Chromium via snap, the binary path may be /snap/bin/chromium.
// - We pass recommended flags for running in a container/VPS (--no-sandbox etc.). Only use these flags if you understand their security implications.

const puppeteer = require('puppeteer-core');

(async () => {
  // Set CHROME_PATH env var to override if needed. Default paths commonly used:
  // - Google Chrome stable: /usr/bin/google-chrome-stable
  // - Google Chrome: /usr/bin/google-chrome
  // - Chromium snap: /snap/bin/chromium
  const executablePath = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

  console.log('Using Chrome executable at:', executablePath);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // useful on low-shm containers
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
    ],
    // Increase timeout if the VPS is slow to start Chrome
    timeout: 30000
  });

  try {
    const page = await browser.newPage();
    await page.goto('https://example.com', { waitUntil: 'networkidle2' });
    const title = await page.title();
    console.log('Page title:', title);
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('Error in Puppeteer script:', err);
  process.exit(1);
});
