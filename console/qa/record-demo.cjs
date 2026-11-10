// Record the 3-minute console walkthrough (screen only; beats follow docs/demo_script.md).
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');

const CHROME = process.env.CHROME_PATH || 'chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function slowScroll(page, selector, from, to, ms) {
  await page.evaluate(async ({ selector, from, to, ms }) => {
    const el = document.querySelector(selector);
    const steps = 40, dt = ms / steps;
    for (let i = 0; i <= steps; i++) {
      el.scrollTop = from + (to - from) * (i / steps);
      await new Promise(r => setTimeout(r, dt));
    }
  }, { selector, from, to, ms });
}

async function clickRow(page, cid) {
  await page.evaluate((cid) => {
    const row = [...document.querySelectorAll('.case-row')].find(r => r.querySelector('.cid')?.textContent.trim() === cid);
    row.scrollIntoView({ block: 'center' }); row.click();
  }, cid);
  await sleep(600);
}

(async () => {
  const server = spawn('python3', ['-m', 'http.server', '8471', '-d', 'dist'], { stdio: 'ignore' });
  await sleep(1200);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: 'qa/video-raw', size: { width: 1280, height: 800 } },
  });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:8471/', { waitUntil: 'networkidle0' });
  await sleep(7000); // Beat 1 (0:00-0:24): settle on the full queue

  // Beat 1 cont: slow scroll through the queue
  await slowScroll(page, '.queue', 0, 1400, 12000);
  await slowScroll(page, '.queue', 1400, 0, 6000);

  // Beat 2 (0:24-1:23): R001 walkthrough
  await clickRow(page, 'R001');
  await sleep(4500);
  await slowScroll(page, '.detail', 0, 1100, 18000); // verdict, reports, diff, reply
  await sleep(4000);
  await slowScroll(page, '.detail', 1100, 1750, 8000); // actions visible
  await sleep(3500);
  await page.keyboard.press('a');                        // approve
  await sleep(4500);
  await slowScroll(page, '.detail', 1750, 0, 8000);      // back to top: applied state
  await sleep(6000);

  // Beat 3 (1:23-2:01): the injection trap, R027
  await clickRow(page, 'R027');
  await sleep(5000);
  await slowScroll(page, '.detail', 0, 1150, 16000);
  await sleep(5000);
  await slowScroll(page, '.detail', 1150, 0, 8000);
  await sleep(4000);

  // Beat 4 (2:01-2:29): filters + a faculty-review case + audit export
  await page.click('.filters button:nth-child(2)');      // Needs review
  await sleep(5000);
  await page.click('.filters button:nth-child(3)');      // Recommended auto-apply
  await sleep(5000);
  await page.click('.filters button:nth-child(1)');      // All
  await sleep(3000);
  await clickRow(page, 'R015');                          // faculty_review case
  await sleep(7000);
  await page.click('button.export');                     // export audit log
  await sleep(4000);

  // Beat 5 (2:29-end): back to the queue overview
  await page.evaluate(() => { document.querySelector('.queue').scrollTop = 0; });
  await sleep(9000);

  await ctx.close(); // finalizes the video
  await browser.close();
  server.kill();
  const f = fs.readdirSync('qa/video-raw')[0];
  fs.renameSync('qa/video-raw/' + f, 'qa/video-raw/demo.webm');
  console.log('raw video: qa/video-raw/demo.webm');
})().catch(e => { console.error(e); process.exit(1); });
