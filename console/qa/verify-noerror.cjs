const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
(async () => {
  const server = spawn('python3', ['-m','http.server','8471','-d','dist'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto('http://127.0.0.1:8471/', { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  async function clickRow(cid) {
    await page.evaluate((cid) => {
      const row = [...document.querySelectorAll('.case-row')].find(r => r.querySelector('.cid')?.textContent.trim() === cid);
      row.scrollIntoView({ block: 'center' }); row.click();
    }, cid);
    await new Promise(r => setTimeout(r, 300));
  }
  // no_error case: caption must NOT mention a fix
  await clickRow('R029');
  const capBefore = await page.$eval('.reply-caption', el => el.textContent);
  console.log('R029 caption before:', capBefore.trim());
  await page.keyboard.press('a');
  await new Promise(r => setTimeout(r, 300));
  const capAfter = await page.$eval('.reply-caption', el => el.textContent);
  const banner = await page.$eval('.decided-banner', el => el.textContent);
  console.log('R029 caption after:', capAfter.trim());
  console.log('R029 banner:', banner.trim());
  // conflict reshoot with final data
  await clickRow('R018');
  await page.keyboard.press('a');
  await new Promise(r => setTimeout(r, 250));
  await clickRow('R019');
  await page.click('.actions .edit');
  await new Promise(r => setTimeout(r, 200));
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
  await page.evaluate(() => { document.querySelector('.detail').scrollTop = 0; });
  await page.screenshot({ path: 'qa/desktop-conflict.png' });
  console.log('conflict reshot:', await page.$eval('.conflict', el => el.textContent.slice(0,60)));
  await browser.close(); server.kill();
})().catch(e => { console.error(e); process.exit(1); });
