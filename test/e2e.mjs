/**
 * End-to-end test: boots the server against a throwaway data directory and a stub
 * Gemini, then drives the real UI in Chrome. Nothing here touches your own library.
 *
 *   npm test
 *
 * Needs Google Chrome installed (override with CHROME_PATH=/path/to/chrome).
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.TEST_PORT) || 3211;
const STUB_PORT = PORT + 1;
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const pass = [], fail = [];
const check = (name, ok, extra = '') => {
  (ok ? pass : fail).push(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? `  (${extra})` : ''}`);
  return ok;
};

/* ---- stub Gemini: answers like the Interactions API, no network, no key, no cost ---- */
let lastCall = null;
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    lastCall = { path: req.url, headers: req.headers, body: JSON.parse(raw || '{}') };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'interaction-test',
      status: 'completed',
      steps: [{
        type: 'model_output',
        content: [{ type: 'text', text: JSON.stringify({
          headline: 'oxidative phosphorylation',
          kind: 'phrase',
          meaning: 'The process that makes ATP using energy released as electrons pass down the respiratory chain.',
          inContext: 'The chapter uses it as the mitochondrion\u2019s defining job.',
          details: [
            { label: 'Part of speech', value: 'noun phrase' },
            { label: 'Example', value: 'Most ATP comes from oxidative phosphorylation.' },
          ],
        }) }],
      }],
    }));
  });
});

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'spr-test-'));
let server, browser;

const cleanup = async () => {
  await browser?.close().catch(() => {});
  server?.kill();
  stub.close();
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
};

try {
  await new Promise((r) => stub.listen(STUB_PORT, r));

  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: path.join(tmp, 'data'),
      PDF_DIR: path.join(tmp, 'pdfs'),
      GEMINI_API_KEY: 'stub-key',
      GEMINI_API_BASE: `http://localhost:${STUB_PORT}`,
    },
    stdio: 'ignore',
  });

  // wait for the server to accept connections
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  /* ---- upload the fixture through the real API ---- */
  const form = new FormData();
  form.append('pdf', new Blob([fs.readFileSync(path.join(HERE, 'fixtures/sample.pdf'))], { type: 'application/pdf' }), 'sample.pdf');
  const doc = await (await fetch(`${BASE}/api/documents`, { method: 'POST', body: form })).json();
  check('upload returns page count read from the PDF', doc.pages === 9, `pages=${doc.pages}`);

  const dup = await (await fetch(`${BASE}/api/documents`, { method: 'POST', body: form })).json();
  check('re-uploading the same PDF dedupes', dup.alreadyExisted === true && dup.id === doc.id);

  /* ---- progress API ---- */
  await fetch(`${BASE}/api/documents/${doc.id}/progress`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 999, offsetPct: 0.5 }),
  });
  const clamped = await (await fetch(`${BASE}/api/documents/${doc.id}/progress`)).json();
  check('progress clamps past the last page', clamped.page === 9, `got ${clamped.page}`);

  await fetch(`${BASE}/api/documents/${doc.id}/progress-beacon`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 4, offsetPct: 0.2 }),
  });
  const beaconed = await (await fetch(`${BASE}/api/documents/${doc.id}/progress`)).json();
  check('unload beacon saves progress', beaconed.page === 4, `got ${beaconed.page}`);

  await fetch(`${BASE}/api/documents/${doc.id}/progress`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ page: 1, offsetPct: 0 }),
  });

  /* ---- the reader itself ---- */
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  check('library lists the document', (await page.locator('.doc-card').count()) === 1);

  await page.locator('.doc-card').first().click();
  await page.waitForSelector('#reader:not([hidden])');
  await page.waitForFunction(() => document.querySelectorAll('.page canvas').length > 0, null, { timeout: 20000 });

  check('page count shown in the toolbar', (await page.locator('#page-count').textContent()) === '9');
  check('one scroll slot per page', (await page.locator('.page').count()) === 9);

  const rendered = await page.locator('.page canvas').count();
  check('pages render lazily', rendered > 0 && rendered < 9, `${rendered} of 9 rendered`);

  const spans = await page.locator('.page .textLayer span').count();
  check('selectable text layer is present', spans > 0, `${spans} spans`);

  /* scroll -> indicator -> saved progress */
  await page.evaluate(() => {
    const c = document.getElementById('viewer-container');
    const t = document.querySelector('.page[data-page="5"]');
    c.scrollTop = t.offsetTop - c.clientHeight * 0.35 + 10;
  });
  await page.waitForFunction(() => document.getElementById('page-input').value === '5', null, { timeout: 5000 })
    .then(() => check('scrolling tracks the current page', true))
    .catch(() => check('scrolling tracks the current page', false));

  await page.waitForTimeout(1400);
  const saved = await (await fetch(`${BASE}/api/documents/${doc.id}/progress`)).json();
  check('the page you are on is saved', saved.page === 5, `server has page ${saved.page}`);

  await page.goto(`${BASE}/#/doc/${doc.id}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.page canvas').length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  check('reopening resumes where you left off', (await page.locator('#page-input').inputValue()) === '5');

  /* selection -> explanation */
  const selected = await page.evaluate(() => {
    const bounds = document.getElementById('viewer-container').getBoundingClientRect();
    const span = [...document.querySelectorAll('.page .textLayer span')].find((s) => {
      const r = s.getBoundingClientRect();
      return s.textContent.trim().length > 4 && r.top > bounds.top + 40 && r.bottom < bounds.bottom - 40;
    });
    if (!span) return false;
    const node = span.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('viewer-container').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  });
  check('found on-screen text to highlight', selected);

  await page.waitForSelector('#explain-btn:not([hidden])', { timeout: 4000 })
    .then(() => check('highlighting offers an explanation', true))
    .catch(() => check('highlighting offers an explanation', false));

  const btnBox = await page.locator('#explain-btn').boundingBox();
  const barBox = await page.locator('.toolbar').boundingBox();
  check('the button never hides under the toolbar', btnBox.y >= barBox.y + barBox.height,
    `button at y=${Math.round(btnBox.y)}`);

  await page.locator('#explain-btn').click();
  await page.waitForSelector('.panel-headline', { timeout: 15000 });
  check('the panel shows the explanation',
    (await page.locator('.panel-headline').textContent()).includes('oxidative phosphorylation'));
  check('the panel is really on screen', await page.locator('#panel').isVisible());
  check('the button goes away once used', !(await page.locator('#explain-btn').isVisible()));

  const lookups = await (await fetch(`${BASE}/api/documents/${doc.id}/lookups`)).json();
  check('the lookup is recorded', lookups.length === 1, `${lookups.length} recorded`);

  /* ---- the request we send matches the documented Interactions API ---- */
  check('posts to /interactions', lastCall.path === '/interactions', lastCall.path);
  check('sends the API key header', lastCall.headers['x-goog-api-key'] === 'stub-key');
  check('pins the API revision', lastCall.headers['api-revision'] === '2026-05-20',
    lastCall.headers['api-revision']);
  check('names the model in the body',
    typeof lastCall.body.model === 'string' && lastCall.body.model.length > 0, lastCall.body.model);
  check('system_instruction is a plain string', typeof lastCall.body.system_instruction === 'string');
  check('uses input, not contents',
    typeof lastCall.body.input === 'string' && lastCall.body.input.includes('Highlighted text'));
  check('carries the page text as context', lastCall.body.input.includes('mitochondrion'));
  check('asks for JSON via response_format',
    lastCall.body.response_format?.mime_type === 'application/json');
  check('sends a plain JSON Schema (lowercase types)',
    lastCall.body.response_format?.schema?.type === 'object'
      && lastCall.body.response_format.schema.properties.headline.type === 'string');
  check('requires the fields the panel renders',
    JSON.stringify(lastCall.body.response_format.schema.required)
      === JSON.stringify(['headline', 'kind', 'meaning', 'inContext']));
  check('keeps thinking minimal for a lookup',
    lastCall.body.generation_config?.thinking_level === 'minimal',
    lastCall.body.generation_config?.thinking_level);
  check('opts out of server-side storage', lastCall.body.store === false);

  /* history drawer */
  await page.locator('#history-btn').click();
  await page.waitForSelector('#history:not([hidden])');
  check('history lists past lookups', (await page.locator('.history-item').count()) >= 1);
  check('history replaces the panel rather than overlapping it',
    !(await page.locator('#panel').isVisible()));

  /* zoom + jump */
  const wBefore = await page.locator('.page').first().evaluate((e) => e.getBoundingClientRect().width);
  await page.locator('#zoom-in').click();
  await page.waitForTimeout(700);
  const wAfter = await page.locator('.page').first().evaluate((e) => e.getBoundingClientRect().width);
  check('zooming resizes the pages', wAfter > wBefore, `${Math.round(wBefore)} -> ${Math.round(wAfter)}px`);

  // climb to the top of the ladder
  for (let i = 0; i < 12 && !(await page.locator('#zoom-in').isDisabled()); i++) {
    await page.locator('#zoom-in').click();
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(1000);
  check('zoom reaches 500%', (await page.locator('#zoom-level').textContent()) === '500%',
    await page.locator('#zoom-level').textContent());
  check('zoom-in disables at the ceiling', await page.locator('#zoom-in').isDisabled());

  const wMax = await page.locator('.page').first().evaluate((e) => e.getBoundingClientRect().width);
  check('pages really are 5x at 500%', Math.abs(wMax / wBefore - 5) < 0.05, `${Math.round(wMax)}px wide`);

  const overflow = await page.evaluate(() => {
    const c = document.getElementById('viewer-container');
    const p = document.querySelector('.page');
    const before = { scrollW: c.scrollWidth, clientW: c.clientWidth, scrollLeft: c.scrollLeft };
    c.scrollLeft = 0; // scrolling fully left must reveal the page's left edge
    const atOrigin = p.getBoundingClientRect().left;
    c.scrollLeft = c.scrollWidth; // and fully right must reveal the right edge
    const atEnd = p.getBoundingClientRect().right;
    return { ...before, atOrigin, atEnd, clientWidth: c.clientWidth };
  });
  check('a page wider than the window scrolls sideways',
    overflow.scrollW > overflow.clientW, `${overflow.scrollW} vs ${overflow.clientW}`);
  check('zooming keeps the view centred',
    overflow.scrollLeft > 0, `scrollLeft was ${Math.round(overflow.scrollLeft)}`);
  check('scrolling left reveals the left edge', overflow.atOrigin >= 0,
    `left edge at ${Math.round(overflow.atOrigin)}px`);
  check('scrolling right reveals the right edge', overflow.atEnd <= overflow.clientWidth + 1,
    `right edge at ${Math.round(overflow.atEnd)}px`);

  const canvasPixels = await page.evaluate(() =>
    [...document.querySelectorAll('.page canvas')].reduce((n, c) => n + c.width * c.height, 0));
  check('canvas memory stays bounded at 500%', canvasPixels <= 67_108_864,
    `${(canvasPixels / 1e6).toFixed(1)}M pixels`);

  await page.locator('#zoom-out').click();
  await page.waitForTimeout(700);
  check('zoom-in re-enables below the ceiling', !(await page.locator('#zoom-in').isDisabled()));

  // back to 100% so the page-jump check runs at a sane size
  await page.evaluate(() => localStorage.setItem('spr:zoom', '1'));
  await page.goto(`${BASE}/#/doc/${doc.id}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.page canvas').length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(500);

  await page.locator('#page-input').fill('8');
  await page.locator('#page-input').press('Enter');
  // A smooth scroll across several pages takes longer than a fixed pause.
  await page.waitForFunction(() => document.getElementById('page-input').value === '8', null, { timeout: 8000 })
    .then(() => check('jumping to a page lands on it', true))
    .catch(async () => check('jumping to a page lands on it', false,
      `landed on ${await page.locator('#page-input').inputValue()}`));

  await page.locator('#back-btn').click();
  await page.waitForSelector('#library:not([hidden])', { timeout: 4000 })
    .then(() => check('back returns to the library', true))
    .catch(() => check('back returns to the library', false));

  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors[0] ?? '');
} catch (err) {
  fail.push(` FAIL  test run threw: ${err.message}`);
} finally {
  await cleanup();
}

console.log([...pass, ...fail].join('\n'));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
