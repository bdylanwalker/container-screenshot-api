import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const url = 'https://www.mercycorps.org';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ],
});

const page = await browser.newPage();

await page.setViewportSize({ width: 1440, height: 900 });

page.on('console', msg => console.log('PAGE LOG:', msg.type(), msg.text()));
page.on('pageerror', err => console.error('PAGE ERROR:', err.message));
page.on('requestfailed', req =>
  console.warn('FAILED:', req.url(), req.failure()?.errorText)
);

console.log(`Navigating to ${url}...`);
await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

// Wait for nav + force any CSS transitions to complete
await page.waitForSelector('.c-main-navigation', { state: 'visible' });

await page.evaluate(() => {
  // Disable all transitions/animations so screenshot catches final state
  const style = document.createElement('style');
  style.textContent = `*, *::before, *::after { transition: none !important; animation: none !important; }`;
  document.head.appendChild(style);
});

await Bun.sleep(500);

// const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
// console.log('Body scroll height:', bodyHeight);

// await page.setViewportSize({ width: 1920, height: bodyHeight });

await page.screenshot({ path: 'screenshots/screenshot-debug-full.png', fullPage: true });
writeFileSync('screenshots/screenshot-debug-page.html', await page.content());

console.log('Saved files to screenshots directory');

await browser.close();
