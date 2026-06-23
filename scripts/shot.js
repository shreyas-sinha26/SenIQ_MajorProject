// One-off: full-page screenshot of the landing page using local Chrome.
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--hide-scrollbars'],
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle0', timeout: 60000 });

  // Let GSAP intro + reveals settle, then force all scroll-reveal elements visible
  // so the full-page capture doesn't show pre-animation (opacity:0) sections.
  await page.evaluate(() => {
    document.querySelectorAll('[data-reveal],[data-hero]').forEach((el) => {
      el.style.opacity = '1';
      el.style.transform = 'none';
    });
  });
  await new Promise((r) => setTimeout(r, 1500));

  await page.screenshot({ path: 'scripts/landing-fullpage.png', fullPage: true });
  await browser.close();
  console.log('saved scripts/landing-fullpage.png');
})().catch((e) => { console.error(e); process.exit(1); });
