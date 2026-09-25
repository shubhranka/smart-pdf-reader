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
const imageCalls = [];
const thinkingLevels = [];
// smallest valid PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://localhost');

    // --- a 1x1 PNG, so the browser has something real to decode ---
    if (url.pathname === '/img/diagram.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    // --- Wikipedia article summary ---
    if (url.pathname.startsWith('/api/rest_v1/page/summary/')) {
      const title = decodeURIComponent(url.pathname.split('/').pop());
      imageCalls.push(title);
      if (!/mitochondrion/i.test(title)) { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        title: 'Mitochondrion',
        thumbnail: { source: `http://localhost:${STUB_PORT}/img/diagram.png`, width: 320, height: 200 },
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Mitochondrion' } },
      }));
    }
    // --- Wikipedia / Commons search: nothing, so misses fall through cleanly ---
    if (url.pathname === '/w/api.php') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ query: { search: [], pages: {} } }));
    }
    // --- Openverse: an intentionally irrelevant hit, to test the relevance filter ---
    if (url.pathname === '/v1/images/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ results: [{
        title: 'Yellow Bush Dart dragonfly', creator: 'someone', license: 'by',
        thumbnail: `http://localhost:${STUB_PORT}/img/diagram.png`,
        foreign_landing_url: 'https://example.org/photo',
      }] }));
    }

    lastCall = { path: req.url, headers: req.headers, body: JSON.parse(raw || '{}') };
    thinkingLevels.push(lastCall.body.generation_config?.thinking_level);

    // Some models refuse 'minimal'; the app should correct itself rather than fail.
    if (lastCall.body.generation_config?.thinking_level === 'minimal') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message:
        "'minimal' is not a supported thinking level for this model. Allowed values are: high, low, medium." } }));
    }

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
          imageQuery: 'mitochondrion',
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
      WIKIPEDIA_API_BASE: `http://localhost:${STUB_PORT}`,
      COMMONS_API_BASE: `http://localhost:${STUB_PORT}`,
      OPENVERSE_API_BASE: `http://localhost:${STUB_PORT}`,
      EXTRA_IMAGE_HOSTS: 'localhost',
      GEMINI_THINKING_LEVEL: 'minimal',
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
      === JSON.stringify(['headline', 'kind', 'meaning', 'inContext', 'imageQuery']));
  check('the schema asks when a picture would help',
    lastCall.body.response_format.schema.properties.imageQuery?.type === 'string');
  check('a rejected thinking level is corrected, not fatal',
    thinkingLevels[0] === 'minimal' && thinkingLevels[1] === 'low',
    `tried ${thinkingLevels.slice(0, 2).join(' -> ')}`);
  check('and the corrected level sticks for later lookups',
    !thinkingLevels.slice(2).includes('minimal'),
    `later calls used ${[...new Set(thinkingLevels.slice(2))].join(', ') || '(none yet)'}`);
  check('the explanation still arrived despite the rejection',
    lastCall.body.generation_config?.thinking_level === 'low');
  check('opts out of server-side storage', lastCall.body.store === false);

  /* history drawer */
  await page.locator('#history-btn').click();
  await page.waitForSelector('#history:not([hidden])');
  check('history lists past lookups', (await page.locator('.history-item').count()) >= 1);
  const iconPath = await page.locator('#history-btn svg path').first().getAttribute('d');
  check('the history icon is a list, not a refresh arc', !/a9 9 0|A9 9 0/.test(iconPath), iconPath);
  check('history replaces the panel rather than overlapping it',
    !(await page.locator('#panel').isVisible()));

  /* ---- a picture in the Meaning section, when one exists ---- */
  await page.waitForFunction(() => document.querySelector('.meaning-figure img') !== null,
    null, { timeout: 8000 })
    .then(() => check('the meaning section shows a picture', true))
    .catch(() => check('the meaning section shows a picture', false));

  const figure = await page.evaluate(() => {
    const img = document.querySelector('.meaning-figure img');
    if (!img) return null;
    const meaning = img.closest('.panel-section');
    return {
      loaded: img.complete && img.naturalWidth > 0,
      proxied: img.getAttribute('src').startsWith('/api/image/file?src='),
      alt: img.getAttribute('alt'),
      // it must sit in the Meaning section, not somewhere else in the panel
      inMeaning: meaning?.querySelector('.panel-label')?.textContent.trim() === 'Meaning',
      caption: img.closest('figure')?.querySelector('figcaption')?.textContent.trim(),
      creditLink: img.closest('figure')?.querySelector('figcaption a')?.getAttribute('href'),
    };
  });
  check('the picture actually decoded', figure?.loaded === true);
  check('it is served through our proxy, not hotlinked', figure?.proxied === true);
  check('it sits in the Meaning section', figure?.inMeaning === true);
  check('it has alt text', Boolean(figure?.alt), figure?.alt);
  check('it credits the source', /Wikipedia/.test(figure?.caption ?? ''), figure?.caption);
  check('the credit links back', (figure?.creditLink ?? '').includes('wikipedia.org'), figure?.creditLink);

  /* ---- the image API itself ---- */
  check('Wikipedia is asked before the broader searches',
    imageCalls.length > 0 && /mitochondrion/i.test(imageCalls[0]), imageCalls[0]);

  const hit = await (await fetch(`${BASE}/api/image?q=mitochondrion`)).json();
  check('the image endpoint resolves a subject', Boolean(hit.image), JSON.stringify(hit).slice(0, 60));
  check('it reports which source answered', hit.image?.source === 'Wikipedia', hit.image?.source);

  const bytes = await fetch(`${BASE}${hit.image.url}`);
  check('the proxy serves image bytes', bytes.ok && (bytes.headers.get('content-type') ?? '').startsWith('image/'),
    `${bytes.status} ${bytes.headers.get('content-type')}`);

  // an irrelevant match must be rejected rather than shown
  const junk = await (await fetch(`${BASE}/api/image?q=${encodeURIComponent('write-ahead log')}`)).json();
  check('an unrelated picture is refused', junk.image === null,
    junk.image ? `showed "${junk.image.title}"` : 'nothing shown');

  // the proxy must not be usable to fetch arbitrary addresses
  const ssrf = await fetch(`${BASE}/api/image/file?src=${encodeURIComponent('http://127.0.0.1:1/secret')}`);
  check('the proxy refuses hosts it did not choose', ssrf.status === 403, `HTTP ${ssrf.status}`);
  const ssrf2 = await fetch(`${BASE}/api/image/file?src=${encodeURIComponent('file:///etc/passwd')}`);
  check('the proxy refuses non-http schemes', ssrf2.status === 403, `HTTP ${ssrf2.status}`);

  /* ---- deleting lookups ---- */
  // a second highlight of a different term, so there are two to work with
  await page.evaluate(() => {
    const bounds = document.getElementById('viewer-container').getBoundingClientRect();
    const spans = [...document.querySelectorAll('.page .textLayer span')].filter((s) => {
      const r = s.getBoundingClientRect();
      return s.textContent.trim().length > 4 && r.top > bounds.top + 40 && r.bottom < bounds.bottom - 40;
    });
    const node = spans[spans.length - 1].firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('viewer-container').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('#explain-btn').click().catch(() => {});
  await page.waitForTimeout(700);

  await page.locator('#history-btn').click();
  await page.waitForSelector('#history:not([hidden])');
  const beforeDelete = await page.locator('.history-item').count();
  check('two lookups to work with', beforeDelete >= 2, `${beforeDelete} listed`);

  check('each lookup offers a delete button', await page.locator('.history-item .delete-btn').first().count() === 1);
  await page.locator('.history-item .delete-btn').first().click();
  await page.waitForTimeout(400);
  const afterDelete = await page.locator('.history-item').count();
  check('deleting a lookup removes it from the list', afterDelete === beforeDelete - 1,
    `${beforeDelete} -> ${afterDelete}`);

  const persisted = await (await fetch(`${BASE}/api/documents/${doc.id}/lookups`)).json();
  check('the delete reaches the server', persisted.length === afterDelete,
    `server has ${persisted.length}`);

  // clicking a lookup must still open it, not delete it
  await page.locator('.history-item').first().click();
  await page.waitForTimeout(1200);
  check('clicking the row still opens the lookup', await page.locator('#panel').isVisible());

  /* ---- clicking a lookup goes to the words, not the top of the page ---- */
  const marks = await page.locator('.lookup-highlight').count();
  check('the looked-up phrase is highlighted', marks > 0, `${marks} mark(s)`);

  const landed = await page.evaluate(() => {
    const mark = document.querySelector('.lookup-highlight');
    const view = document.getElementById('viewer-container').getBoundingClientRect();
    const r = mark.getBoundingClientRect();
    const pageEl = mark.closest('.page');
    const pageRect = pageEl.getBoundingClientRect();
    return {
      inView: r.top >= view.top && r.bottom <= view.bottom,
      fromViewTop: r.top - view.top,
      viewHeight: view.height,
      // how far down its page the phrase sits, to prove we did not just go to the top
      fracDownPage: (r.top - pageRect.top) / pageRect.height,
      width: r.width, height: r.height,
    };
  });
  check('the highlighted phrase is on screen', landed.inView,
    `${Math.round(landed.fromViewTop)}px from the top of a ${Math.round(landed.viewHeight)}px view`);
  check('the mark has real size', landed.width > 4 && landed.height > 4,
    `${Math.round(landed.width)}x${Math.round(landed.height)}`);
  check('the mark is not simply at the top of its page',
    landed.fracDownPage > 0.02,
    `phrase sits ${(landed.fracDownPage * 100).toFixed(1)}% down its page`);

  // The real proof: a phrase near the BOTTOM of a page. Scrolling to the page top
  // would leave it off screen; scrolling to the phrase must not.
  await fetch(`${BASE}/api/explain`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: doc.id, page: 3, selection: 'Section 3.6 marker 3636', context: 'deep phrase' }),
  });
  await page.locator('#history-btn').click();
  await page.waitForSelector('#history:not([hidden])');
  await page.locator('.history-item').first().click();
  await page.waitForTimeout(1500);

  const deep = await page.evaluate(() => {
    const mark = document.querySelector('.lookup-highlight');
    if (!mark) return null;
    const view = document.getElementById('viewer-container').getBoundingClientRect();
    const pageEl = mark.closest('.page');
    const pageRect = pageEl.getBoundingClientRect();
    const r = mark.getBoundingClientRect();
    // where the page top would sit had we scrolled to the page instead
    return {
      page: +pageEl.dataset.page,
      fracDownPage: (r.top - pageRect.top) / pageRect.height,
      inView: r.top >= view.top && r.bottom <= view.bottom,
      pageTopOnScreen: pageRect.top - view.top,
      viewHeight: view.height,
    };
  });
  check('a phrase low on the page is found', deep !== null && deep.fracDownPage > 0.5,
    deep ? `${(deep.fracDownPage * 100).toFixed(0)}% down page ${deep.page}` : 'no mark');
  check('a phrase low on the page is scrolled into view', deep?.inView === true);
  check('the page top is pushed off screen to show it',
    deep !== null && deep.pageTopOnScreen < 0,
    deep ? `page top is ${Math.round(deep.pageTopOnScreen)}px from the view top` : '');


  /* ---- the journey there is a glide, not a teleport ---- */
  // start far away, so the scroll has real distance to cover
  await page.evaluate(() => {
    const c = document.getElementById('viewer-container');
    const target = document.querySelector('.page[data-page="8"]');
    c.scrollTop = target.offsetTop;
  });
  await page.waitForTimeout(700);

  await page.locator('#history-btn').click();
  await page.waitForSelector('#history:not([hidden])');

  await page.evaluate(() => {
    const c = document.getElementById('viewer-container');
    window.__samples = [c.scrollTop];
    window.__sampler = setInterval(() => window.__samples.push(c.scrollTop), 16);
  });
  await page.locator('.history-item').first().click();
  await page.waitForTimeout(2000);

  const trip = await page.evaluate(() => {
    clearInterval(window.__sampler);
    const s = window.__samples;
    const mark = document.querySelector('.lookup-highlight');
    const view = document.getElementById('viewer-container').getBoundingClientRect();
    const r = mark?.getBoundingClientRect();
    return {
      from: s[0],
      to: s[s.length - 1],
      steps: new Set(s).size,
      // positions strictly between the endpoints prove it was animated
      between: s.filter((v) => v > Math.min(s[0], s[s.length - 1]) + 1
                            && v < Math.max(s[0], s[s.length - 1]) - 1).length,
      arrived: r ? r.top >= view.top && r.bottom <= view.bottom : false,
    };
  });

  check('the trip covers real distance', Math.abs(trip.to - trip.from) > 500,
    `${Math.round(trip.from)} -> ${Math.round(trip.to)}`);
  check('it glides rather than jumping', trip.between > 3,
    `${trip.between} intermediate positions across ${trip.steps} distinct values`);
  check('and lands with the phrase in view', trip.arrived === true);

  // the highlight must survive a zoom, which rebuilds the text layer
  await page.locator('#zoom-in').click();
  await page.waitForTimeout(1400);
  check('the highlight survives zooming', (await page.locator('.lookup-highlight').count()) > 0);
  const scaled = await page.evaluate(() => {
    const m = document.querySelector('.lookup-highlight');
    const t = [...document.querySelectorAll('.page .textLayer span')]
      .find((s) => s.textContent.trim().length > 4);
    if (!m || !t) return null;
    const mr = m.getBoundingClientRect();
    return { markH: mr.height, textH: t.getBoundingClientRect().height };
  });
  check('the mark scales with the text', scaled && Math.abs(scaled.markH - scaled.textH) < scaled.textH * 0.8,
    scaled ? `mark ${Math.round(scaled.markH)}px vs text ${Math.round(scaled.textH)}px` : 'not found');
  await page.locator('#zoom-out').click();
  await page.waitForTimeout(1000);

  // closing the explanation puts the page back to normal
  await page.locator('#panel-close').click();
  await page.waitForTimeout(300);
  check('closing the panel clears the highlight',
    (await page.locator('.lookup-highlight').count()) === 0);

  await page.locator('#history-btn').click();
  await page.waitForSelector('#history:not([hidden])');

  page.once('dialog', (d) => d.accept());
  await page.locator('#history-clear').click();
  await page.waitForTimeout(500);
  check('clear all empties the list', (await page.locator('.history-item').count()) === 0);
  check('the empty note shows once cleared', await page.locator('#history-empty').isVisible());

  const cleared = await (await fetch(`${BASE}/api/documents/${doc.id}/lookups`)).json();
  check('clear all reaches the server', cleared.length === 0, `server has ${cleared.length}`);

  const libraryAfter = await (await fetch(`${BASE}/api/documents`)).json();
  check('the library lookup count follows', libraryAfter[0].lookup_count === 0,
    `count is ${libraryAfter[0].lookup_count}`);

  // deleting is not permanent: looking the term up again re-records it
  await page.locator('#history-close').click();
  await page.evaluate(() => {
    const bounds = document.getElementById('viewer-container').getBoundingClientRect();
    const span = [...document.querySelectorAll('.page .textLayer span')].find((s) => {
      const r = s.getBoundingClientRect();
      return s.textContent.trim().length > 4 && r.top > bounds.top + 40 && r.bottom < bounds.bottom - 40;
    });
    const node = span.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('viewer-container').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('#explain-btn').click().catch(() => {});
  await page.waitForTimeout(800);
  const readded = await (await fetch(`${BASE}/api/documents/${doc.id}/lookups`)).json();
  check('a deleted lookup comes back if you highlight it again', readded.length === 1,
    `${readded.length} recorded`);

  // ...but highlighting the same term twice does not duplicate it
  await page.evaluate(() => {
    const bounds = document.getElementById('viewer-container').getBoundingClientRect();
    const span = [...document.querySelectorAll('.page .textLayer span')].find((s) => {
      const r = s.getBoundingClientRect();
      return s.textContent.trim().length > 4 && r.top > bounds.top + 40 && r.bottom < bounds.bottom - 40;
    });
    const node = span.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('viewer-container').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('#explain-btn').click().catch(() => {});
  await page.waitForTimeout(800);
  const again = await (await fetch(`${BASE}/api/documents/${doc.id}/lookups`)).json();
  check('the same term is not listed twice', again.length === 1, `${again.length} recorded`);

  check('deleting an unknown lookup 404s',
    (await fetch(`${BASE}/api/lookups/999999`, { method: 'DELETE' })).status === 404);

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
  await page.reload({ waitUntil: 'networkidle' }); // goto() with an unchanged hash would not reload
  await page.waitForFunction(() => document.querySelectorAll('.page canvas').length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(500);

  /* ---- trackpad pinch zooms the document, not the browser ---- */
  const pinch = (deltaY, x = 640, y = 500) => page.evaluate(([dy, cx, cy]) => {
    const target = document.getElementById('viewer-container');
    const ev = new WheelEvent('wheel', {
      deltaY: dy, ctrlKey: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true,
    });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  }, [deltaY, x, y]);

  const zoomNow = async () => parseInt(await page.locator('#zoom-level').textContent(), 10);

  // where the cursor is pointing, as a fraction of the page beneath it
  const underCursor = (x = 640, y = 500) => page.evaluate(([cx, cy]) => {
    const c = document.getElementById('viewer-container');
    const rect = c.getBoundingClientRect();
    const docY = c.scrollTop + (cy - rect.top);
    for (const el of document.querySelectorAll('.page')) {
      if (docY < el.offsetTop + el.offsetHeight) {
        return { page: +el.dataset.page, frac: (docY - el.offsetTop) / el.offsetHeight };
      }
    }
    return null;
  }, [x, y]);

  const startZoom = await zoomNow();
  check('zoom resets to 100% for the pinch checks', startZoom === 100, `${startZoom}%`);
  const before = await underCursor();
  const consumed = await pinch(-40);
  check('pinch is consumed so the browser does not zoom', consumed === true);
  await page.waitForTimeout(60);
  const pinchedZoom = await zoomNow();
  check('pinching in zooms the document', pinchedZoom > startZoom, `${startZoom}% -> ${pinchedZoom}%`);

  // mid-gesture the pages are scaled with a transform rather than re-rendered
  const midGesture = await page.evaluate(() => {
    const inner = document.querySelector('.page-inner');
    return inner ? getComputedStyle(inner).transform : 'none';
  });
  check('pinch previews with a transform instead of re-rendering', midGesture !== 'none', midGesture);

  const after = await underCursor();
  check('the point under the cursor stays put',
    before && after && before.page === after.page && Math.abs(before.frac - after.frac) < 0.03,
    `page ${before?.page} frac ${before?.frac.toFixed(3)} -> page ${after?.page} frac ${after?.frac.toFixed(3)}`);

  // once the gesture settles the page is re-rendered and the preview scale returns to 1
  const previewScale = () => page.evaluate(() => {
    const inner = document.querySelector('.page-inner');
    return inner ? new DOMMatrix(getComputedStyle(inner).transform).a : null;
  });
  await page.waitForFunction(() => {
    const inner = document.querySelector('.page-inner');
    if (!inner) return false;
    return Math.abs(new DOMMatrix(getComputedStyle(inner).transform).a - 1) < 0.001;
  }, null, { timeout: 8000 })
    .then(() => check('the pages re-render sharply once pinching stops', true))
    .catch(async () => check('the pages re-render sharply once pinching stops', false,
      `preview scale still ${(await previewScale()).toFixed(3)}`));

  const sharp = await page.evaluate(() => {
    const canvas = document.querySelector('.page canvas');
    const dpr = window.devicePixelRatio || 1;
    return { backing: canvas.width, css: parseFloat(canvas.style.width), dpr };
  });
  check('the re-rendered canvas matches its on-screen size',
    Math.abs(sharp.backing - sharp.css * sharp.dpr) <= 2,
    `${sharp.backing} backing vs ${Math.round(sharp.css * sharp.dpr)} expected`);

  // zooming must never leave the viewer blank, even for a frame
  const blanked = await page.evaluate(async () => {
    const target = document.getElementById('viewer-container');
    let sawBlank = false;
    const watch = setInterval(() => {
      if (document.querySelectorAll('.page canvas').length === 0) sawBlank = true;
    }, 8);
    for (let i = 0; i < 6; i++) {
      target.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -12, ctrlKey: true, clientX: 640, clientY: 500, bubbles: true, cancelable: true,
      }));
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 900));
    clearInterval(watch);
    return sawBlank;
  });
  check('zooming never blanks the page out', blanked === false);

  const overToolbar = await page.evaluate(() => {
    const ev = new WheelEvent('wheel', {
      deltaY: -10, ctrlKey: true, clientX: 640, clientY: 20, bubbles: true, cancelable: true,
    });
    document.querySelector('.toolbar').dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('pinching over the toolbar still zooms the PDF', overToolbar === true);

  // a plain wheel must still scroll
  const plainConsumed = await page.evaluate(() => {
    const target = document.getElementById('viewer-container');
    const ev = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('a plain wheel is left alone for scrolling', plainConsumed === false);

  // pinching out hard clamps at the floor rather than going silly
  for (let i = 0; i < 25; i++) await pinch(60);
  await page.waitForTimeout(400);
  check('pinching out clamps at 50%', (await zoomNow()) === 50, `${await zoomNow()}%`);

  for (let i = 0; i < 60; i++) await pinch(-60);
  await page.waitForTimeout(400);
  check('pinching in clamps at 500%', (await zoomNow()) === 500, `${await zoomNow()}%`);

  // back to 100% for the page-jump check
  await page.evaluate(() => localStorage.setItem('spr:zoom', '1'));
  await page.reload({ waitUntil: 'networkidle' }); // goto() with an unchanged hash would not reload
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
