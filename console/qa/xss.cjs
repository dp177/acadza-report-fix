// XSS safety proof: poison one question's raw HTML in dist/data, load the app,
// open the case, and verify nothing executed.
const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');

(async () => {
  const dataPath = 'dist/data/console_data.json';
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const qid = Object.keys(data.questions)[0];
  const original = data.questions[qid].rawQuestionHtml;
  data.questions[qid].rawQuestionHtml =
    '<script>window.__xss=1</script><img src="x" onerror="window.__xss=2">' + original;
  fs.writeFileSync(dataPath, JSON.stringify(data));

  const server = spawn('python3', ['-m', 'http.server', '8472', '-d', 'dist'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 1200));
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8472/', { waitUntil: 'networkidle0' });
    await page.click('.case-row');
    await new Promise(r => setTimeout(r, 500));
    const xss = await page.evaluate(() => window.__xss || null);
    const html = await page.$eval('.question-render', el => el.innerHTML);
    const scriptLeft = html.includes('<script') || html.includes('onerror');
    console.log('xss marker:', xss, '| dangerous markup left:', scriptLeft);
    if (xss === null && !scriptLeft) console.log('XSS TEST PASS: script and onerror rendered inert');
    else { console.log('XSS TEST FAIL'); process.exitCode = 1; }
    await page.screenshot({ path: 'qa/xss-case.png' });
  } finally {
    await browser.close();
    server.kill();
    // restore clean data
    data.questions[qid].rawQuestionHtml = original;
    fs.writeFileSync(dataPath, JSON.stringify(data));
  }
})().catch(e => { console.error(e); process.exit(1); });
