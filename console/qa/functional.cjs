// Functional QA: real state transitions, duplicate consistency, conflict
// protection, keyboard guards, layout (independent pane scroll), mobile reach.
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
  if (!cond) failures++;
}

async function clickRow(page, cid) {
  const ok = await page.evaluate((cid) => {
    const rows = [...document.querySelectorAll('.case-row')];
    const row = rows.find(r => r.querySelector('.cid')?.textContent.trim() === cid);
    if (!row) return false;
    row.scrollIntoView({ block: 'center' });
    row.click();
    return true;
  }, cid);
  if (!ok) throw new Error('row not found: ' + cid);
  await new Promise(r => setTimeout(r, 250));
}

const auditLen = page => page.evaluate(() =>
  JSON.parse(localStorage.getItem('acadza_audit_v2') || '[]').length);
const decidedCount = page => page.evaluate(() =>
  Object.keys(JSON.parse(localStorage.getItem('acadza_decisions_v2') || '{}')).length);

(async () => {
  const server = spawn('python3', ['-m', 'http.server', '8471', '-d', 'dist'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto('http://127.0.0.1:8471/', { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'networkidle0' });

    // 1. all 44 cases present
    const rowCount = await page.$$eval('.case-row', rs => rs.length);
    check('queue lists all 44 cases', rowCount === 44, `got ${rowCount}`);

    // 2. independent pane scroll: body does not scroll, queue does
    const layout = await page.evaluate(() => ({
      bodyScroll: document.documentElement.scrollHeight,
      vh: window.innerHeight,
      queueScrollable: document.querySelector('.queue').scrollHeight > document.querySelector('.queue').clientHeight + 50,
      queueClientH: document.querySelector('.queue').clientHeight,
    }));
    check('body does not scroll at 1280x800', layout.bodyScroll <= layout.vh + 2, `scrollHeight=${layout.bodyScroll}`);
    check('queue pane scrolls independently', layout.queueScrollable);
    await page.screenshot({ path: 'qa/desktop-queue.png' });

    // 3. approve R001 -> working copy patched + duplicates resolved together
    await clickRow(page, 'R001');
    const dupVisible = await page.$('.dup-note');
    check('duplicate-fix note shown for R001 (R002/R003 same fix)', !!dupVisible);
    await page.keyboard.press('a');
    await new Promise(r => setTimeout(r, 250));
    check('approve via keyboard recorded', (await auditLen(page)) === 3, '3 audit entries: R001 + R002 + R003');
    check('duplicates resolved together', (await decidedCount(page)) === 3);
    const appliedAnswer = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('acadza_patches_v2') || '{}'));
    check('working copy patched (answer field)', Object.values(appliedAnswer)[0]?.answer?.replace === 'A');
    const banner = await page.$eval('.decided-banner', el => el.textContent).catch(() => '');
    check('applied state shown in detail', /applied to the working copy/.test(banner));
    const header = await page.$eval('header.top', el => el.textContent);
    check('header shows 3 decided, recommends (not "applied")', /3 decided/.test(header) && /recommended auto-apply/.test(header) && !/auto-applied/.test(header));
    const replyCaption = await page.$eval('.reply-caption', el => el.textContent);
    check('reply caption says released after approval', /Released with the approved fix/.test(replyCaption));
    await page.screenshot({ path: 'qa/desktop-detail-applied.png' });

    // 4. persistence across reload
    await page.reload({ waitUntil: 'networkidle0' });
    check('decisions persist across reload', (await decidedCount(page)) === 3);

    // 5. conflict protection: approve R018, then try a different edit via R019
    await clickRow(page, 'R018');
    await page.keyboard.press('a');
    await new Promise(r => setTimeout(r, 250));
    const afterR018 = await auditLen(page);
    await clickRow(page, 'R019');
    await page.click('.actions .edit');
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('.diff input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inputs[1], 'DIFFERENT-CONTENT');
      inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 6. keyboard guard: typing 'a' inside the input must NOT approve
    await page.click('.diff input');
    await page.keyboard.press('a');
    await new Promise(r => setTimeout(r, 200));
    check('keyboard shortcut ignored while typing in input', (await auditLen(page)) === afterR018);
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.actions button')];
      btns.find(b => b.textContent.includes('Approve edited')).click();
    });
    await new Promise(r => setTimeout(r, 250));
    const conflictTxt = await page.$eval('.conflict', el => el.textContent).catch(() => '');
    check('conflicting edit blocked with visible warning', /Blocked: field "solution"/.test(conflictTxt));
    check('conflicting edit NOT applied, no audit entry', (await auditLen(page)) === afterR018);
    await page.screenshot({ path: 'qa/desktop-conflict.png' });

    // 7. reject path
    await clickRow(page, 'R015');
    await page.keyboard.press('r');
    await new Promise(r => setTimeout(r, 250));
    const rejBanner = await page.$eval('.decided-banner', el => el.textContent).catch(() => '');
    check('reject recorded, no change applied', /Rejected/.test(rejBanner) && /no change applied/.test(rejBanner));
    check('decided count = 6 (R001-3 + R018/R019 + R015)', (await decidedCount(page)) === 6, `got ${await decidedCount(page)}`);

    // 8. injection case still safe
    await clickRow(page, 'R027');
    const inj = await page.$('.injection');
    check('injection warning banner shown for R027', !!inj);
    await page.screenshot({ path: 'qa/desktop-injection.png' });

    // 9. mobile: all cases reachable, selection works
    await page.setViewport({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle0' });
    const mRows = await page.$$eval('.case-row', rs => rs.length);
    check('mobile queue lists all 44 cases', mRows === 44, `got ${mRows}`);
    const lastCid = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.case-row')];
      const last = rows[rows.length - 1];
      const cid = last.querySelector('.cid').textContent.trim();
      last.scrollIntoView();
      last.click();
      return cid;
    });
    await new Promise(r => setTimeout(r, 300));
    const detailH2 = await page.$eval('.detail h2', el => el.textContent).catch(() => '');
    check('last queue case selectable on mobile', detailH2.includes(lastCid), `${lastCid} -> ${detailH2.slice(0, 12)}`);
    await page.screenshot({ path: 'qa/mobile-detail.png', fullPage: true });

    console.log(failures ? `\n${failures} FAILURES` : '\nALL PASS');
    process.exitCode = failures ? 1 : 0;
  } finally {
    await browser.close();
    server.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
