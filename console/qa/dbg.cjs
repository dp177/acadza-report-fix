const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
(async () => {
  const server = spawn('python3', ['-m','http.server','8471','-d','dist'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', m => console.log('PAGE:', m.text()));
  page.on('pageerror', e => console.log('PAGEERR:', e.message));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:8471/', { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  async function clickRow(cid) {
    await page.evaluate((cid) => {
      const rows = [...document.querySelectorAll('.case-row')];
      const row = rows.find(r => r.querySelector('.cid')?.textContent.trim() === cid);
      row.scrollIntoView({ block: 'center' }); row.click();
    }, cid);
    await new Promise(r => setTimeout(r, 250));
  }
  await clickRow('R018');
  await page.keyboard.press('a');
  await new Promise(r => setTimeout(r, 300));
  console.log('after R018 approve:',
    await page.evaluate(() => ({
      decisions: Object.keys(JSON.parse(localStorage.getItem('acadza_decisions_v2')||'{}')),
      patches: JSON.parse(localStorage.getItem('acadza_patches_v2')||'{}'),
    })));
  await clickRow('R019');
  console.log('R019 banner:', await page.$eval('.decided-banner', el => el.textContent).catch(() => 'NONE'));
  await page.click('.actions .edit');
  await new Promise(r => setTimeout(r, 200));
  console.log('editing inputs:', await page.$$eval('.diff input', els => els.map(e => e.value)));
  await page.evaluate(() => {
    const inputs = document.querySelectorAll('.diff input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inputs[1], 'DIFFERENT-CONTENT');
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.evaluate(() => {
    [...document.querySelectorAll('.actions button')].find(b => b.textContent.includes('Approve edited')).click();
  });
  await new Promise(r => setTimeout(r, 300));
  console.log('conflict el:', await page.$eval('.conflict', el => el.textContent).catch(() => 'NONE'));
  console.log('audit len:', await page.evaluate(() => JSON.parse(localStorage.getItem('acadza_audit_v2')||'[]').length));
  await browser.close(); server.kill();
})().catch(e => { console.error(e); process.exit(1); });
