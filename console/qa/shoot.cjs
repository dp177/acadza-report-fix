// Local visual QA: serve dist/, screenshot queue + detail + mobile + injection case.
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');

(async () => {
  const server = spawn('python3', ['-m', 'http.server', '8471', '-d', 'dist'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('http://127.0.0.1:8471/', { waitUntil: 'networkidle0' });
    await page.screenshot({ path: 'qa/desktop-queue.png' });

    // open the first case
    await page.click('.case-row');
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: 'qa/desktop-detail.png', fullPage: true });

    // injection case (R027 in fixture)
    const rows = await page.$$('.case-row');
    for (const row of rows) {
      const txt = await row.evaluate(el => el.textContent);
      if (txt.includes('R027')) { await row.click(); break; }
    }
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: 'qa/desktop-injection.png', fullPage: true });

    // mobile
    await page.setViewport({ width: 390, height: 844 });
    await page.goto('http://127.0.0.1:8471/', { waitUntil: 'networkidle0' });
    await page.click('.case-row');
    await new Promise(r => setTimeout(r, 400));
    await page.screenshot({ path: 'qa/mobile-detail.png', fullPage: true });
    console.log('qa screenshots written');
  } finally {
    await browser.close();
    server.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
