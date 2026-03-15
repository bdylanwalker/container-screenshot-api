import puppeteer from 'puppeteer';
import { writeFileSync } from 'fs';

const url = 'https://www.mercycorps.org';

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1920,1080',
  ],
});

const page = await browser.newPage();

await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

page.on('console', msg => console.log('PAGE LOG:', msg.type(), msg.text()));
page.on('pageerror', err => console.error('PAGE ERROR:', err.message));
page.on('requestfailed', req =>
  console.warn('FAILED:', req.url(), req.failure()?.errorText)
);

await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });

// Scroll to trigger lazy-loaded content
await page.evaluate(async () => {
  await new Promise<void>(resolve => {
    let totalHeight = 0;
    const timer = setInterval(() => {
      window.scrollBy(0, 300);
      totalHeight += 300;
      if (totalHeight >= document.body.scrollHeight) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
});

await Bun.sleep(1000);

const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
console.log('Body scroll height:', bodyHeight);

// Resize viewport to full content height before screenshotting
await page.setViewport({ width: 1920, height: bodyHeight });

await page.screenshot({ path: 'screenshots/screenshot-debug-full.png', fullPage: true });

writeFileSync('screenshots/screenshot-debug-page.html', await page.content());
console.log('Saved files to screenshots directory');

await browser.close();