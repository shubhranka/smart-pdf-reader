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
const calls = [];          // every model call, so the map-reduce passes can be counted
const imageCalls = [];
const thinkingLevels = [];
const providerCalls = []; // requests that reached the chat-completions stubs
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

    // --- Mistral, Groq, OpenRouter and NVIDIA NIM: chat completions ---
    if (url.pathname.endsWith('/chat/completions')) {
      const call = { path: url.pathname, headers: req.headers, body: JSON.parse(raw || '{}') };
      providerCalls.push(call);
      // Some NIM models refuse response_format; the app should fall back to guided_json.
      if (url.pathname.startsWith('/nvidia/') && call.body.response_format) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'response_format is not supported for this model' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chat-test',
        choices: [{ index: 0, finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(EXPLAIN_ANSWER) } }],
      }));
    }

    lastCall = { path: req.url, headers: req.headers, body: JSON.parse(raw || '{}') };
    calls.push(lastCall);
    thinkingLevels.push(lastCall.body.generation_config?.thinking_level);

    // Some models refuse 'minimal'; the app should correct itself rather than fail.
    if (lastCall.body.generation_config?.thinking_level === 'minimal'
        && !lastCall.body.system_instruction?.startsWith('You are taking notes')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message:
        "'minimal' is not a supported thinking level for this model. Allowed values are: high, low, medium." } }));
    }

    // Explanations, chunk notes and recaps all post to /interactions, so the shape
    // asked for is the only thing that tells them apart.
    const props = lastCall.body.response_format?.schema?.properties ?? {};
    const answer = props.summary ? RECAP_ANSWER
      : props.points ? CHUNK_ANSWER
      : EXPLAIN_ANSWER;

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'interaction-test',
      status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(answer) }] }],
    }));
  });
});

const EXPLAIN_ANSWER = {
  headline: 'oxidative phosphorylation',
  kind: 'phrase',
  meaning: 'The process that makes ATP using energy released as electrons pass down the respiratory chain.',
  inContext: 'The chapter uses it as the mitochondrion\u2019s defining job.',
  imageQuery: 'mitochondrion',
  details: [
    { label: 'Part of speech', value: 'noun phrase' },
    { label: 'Example', value: 'Most ATP comes from oxidative phosphorylation.' },
  ],
};

const RECAP_ANSWER = {
  title: 'Bioenergetics so far',
  summary: 'You opened on the mitochondrion, then built up chemiosmotic coupling. You stopped at membrane transport.',
  keyPoints: [{ point: 'ATP is made from a proton gradient.', page: 2 }],
  diagram: {
    kind: 'flow',
    caption: 'How the gradient becomes ATP',
    nodes: [
      { id: 'grad', label: 'Proton gradient', page: 2 },
      { id: 'synthase', label: 'ATP synthase', page: 3 },
      { id: 'atp', label: 'ATP' },
    ],
    edges: [
      { from: 'grad', to: 'synthase', label: 'drives' },
      { from: 'synthase', to: 'atp', label: 'phosphorylates' },
      { from: 'atp', to: 'ghost', label: 'dangling' },   // names no node: must be dropped
    ],
  },
};

const CHUNK_ANSWER = {
  pageRange: '1-2',
  narrative: 'These pages restate the mitochondrion as the site of oxidative phosphorylation.',
  points: ['ATP comes from a proton gradient.'],
  terms: [{ term: 'proton gradient', meaning: 'A difference across a membrane.' }],
  entities: ['mitochondrion'],
  threads: [],
  endsWith: 'Stops mid-transport.',
};

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'spr-test-'));
let server, browser, altServer;

// The server loads the real .env, which may name a provider and hold real keys. Pin
// every provider setting here so no test run can reach a live API or spend quota.
const NO_PROVIDERS = {
  LLM_PROVIDER: '',
  GEMINI_API_KEY: '', GEMINI_MODEL: '', GEMINI_API_BASE: 'http://localhost:1',
  MISTRAL_API_KEY: '', MISTRAL_MODEL: '', MISTRAL_API_BASE: 'http://localhost:1',
  GROQ_API_KEY: '', GROQ_MODEL: '', GROQ_API_BASE: 'http://localhost:1',
  OPENROUTER_API_KEY: '', OPENROUTER_MODEL: '', OPENROUTER_API_BASE: 'http://localhost:1',
  NVIDIA_API_KEY: '', NVIDIA_MODEL: '', NVIDIA_API_BASE: 'http://localhost:1',
};

const cleanup = async () => {
  await browser?.close().catch(() => {});
  server?.kill();
  altServer?.kill();
  stub.close();
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
};

try {
  await new Promise((r) => stub.listen(STUB_PORT, r));

  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...NO_PROVIDERS,
      LLM_PROVIDER: 'gemini',
      PORT: String(PORT),
      DATA_DIR: path.join(tmp, 'data'),
      PDF_DIR: path.join(tmp, 'pdfs'),
      GEMINI_API_KEY: 'stub-key',
      GEMINI_API_BASE: `http://localhost:${STUB_PORT}`,
      WIKIPEDIA_API_BASE: `http://localhost:${STUB_PORT}`,
      COMMONS_API_BASE: `http://localhost:${STUB_PORT}`,
      OPENVERSE_API_BASE: `http://localhost:${STUB_PORT}`,
      EXTRA_IMAGE_HOSTS: 'localhost',
      // Small enough that the nine-page fixture exercises both the single-call path
      // (pages 1-3) and the map-reduce one (pages 1-8).
      RECAP_BUDGET_CHARS: '8000',
      RECAP_CHUNK_CHARS: '5000',
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

  // Dark pages: the canvas is inverted, the text layer is left alone, and the choice sticks.
  const canvasFilter = () => page.evaluate(() => getComputedStyle(document.querySelector('.page canvas')).filter);
  const startedDark = await page.evaluate(() => document.getElementById('reader').classList.contains('pages-dark'));
  if (startedDark) await page.click('#dark-pages-btn');
  check('pages start light on a light system', !startedDark);
  await page.click('#dark-pages-btn');
  check('dark pages inverts the page canvas', /invert/.test(await canvasFilter()), await canvasFilter());
  check('dark pages leaves the text layer unfiltered',
    await page.evaluate(() => getComputedStyle(document.querySelector('.page .textLayer')).filter) === 'none');
  check('dark pages is remembered',
    await page.evaluate(() => localStorage.getItem('spr:dark-pages')) === '1');
  await page.click('#dark-pages-btn');
  check('toggling again restores light pages', (await canvasFilter()) === 'none');

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
  check('the test server is pinned to the stub Gemini', lastCall.body.model === 'gemini-3.5-flash', lastCall.body.model);
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

  /* ---- recap: the range, the cut, and one call vs several ---- */
  const recapPost = (body) => fetch(`${BASE}/api/recap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: doc.id, ...body }),
  });

  let calledBefore = calls.length;
  const short = await (await recapPost({ toPage: 3 })).json();
  check('a recap covers from page 1 by default', short.from_page === 1 && short.to_page === 3);
  check('the recap comes back structured',
    typeof short.result.summary === 'string' && short.result.summary && short.result.keyPoints.length > 0);
  check('a short range is one call', short.chunks === 1 && calls.length - calledBefore === 1,
    `${calls.length - calledBefore} call(s)`);
  check('the recap carries pages the browser never rendered',
    lastCall.body.input.includes('marker 3131'));
  check('the recap stops at the page asked for', !lastCall.body.input.includes('marker 4141'));
  check('a recap thinks harder than a lookup',
    lastCall.body.generation_config?.thinking_level === 'low',
    lastCall.body.generation_config?.thinking_level);
  check('the recap asks for a diagram it can draw',
    lastCall.body.response_format?.schema?.properties?.diagram?.properties?.nodes?.type === 'array');

  const diagram = short.result.diagram;
  check('the diagram survives with its nodes', diagram?.nodes.length === 3, `${diagram?.nodes.length} nodes`);
  check('an edge naming no node is dropped',
    diagram.edges.length === 2 && !diagram.edges.some((e) => e.to === 'ghost'),
    `${diagram.edges.length} edges`);

  calledBefore = calls.length;
  const repeat = await (await recapPost({ toPage: 3 })).json();
  check('the same range is not paid for twice',
    repeat.cached === true && calls.length === calledBefore);

  // The selection comes from the browser's text layer, whose whitespace differs from
  // the server's — the match has to survive that.
  const cut = await (await recapPost({ toPage: 3, cutText: 'Section  3.3\nmarker 3333' })).json();
  check('a selected line is matched despite the whitespace', cut.cut_applied === 1);
  check('the cut truncates the last page',
    lastCall.body.input.includes('marker 3333') && !lastCall.body.input.includes('marker 3434'));

  const unmatched = await (await recapPost({ toPage: 3, cutText: 'not a line in this document' })).json();
  check('a line that cannot be found still gives a recap', unmatched.cut_applied === 0);

  calledBefore = calls.length;
  const long = await (await recapPost({ fromPage: 1, toPage: 8 })).json();
  check('a long range is summarised in passes', long.chunks > 1, `${long.chunks} chunks`);
  check('each pass is a call, plus one to combine them',
    calls.length - calledBefore === long.chunks + 1, `${calls.length - calledBefore} calls`);
  check('the last call combines notes rather than pages',
    lastCall.body.input.includes('Notes:'));

  // Chunks are packed from page 1 of the document, so reading further reuses them.
  calledBefore = calls.length;
  const extended = await (await recapPost({ fromPage: 1, toPage: 9 })).json();
  check('extending a recap reuses the chunks already paid for',
    calls.length - calledBefore < extended.chunks + 1,
    `${calls.length - calledBefore} calls for ${extended.chunks} chunks`);

  check('a recap of an unknown document 404s',
    (await recapPost({ docId: 'nope', toPage: 2 })).status === 404);

  const savedRecaps = await (await fetch(`${BASE}/api/documents/${doc.id}/recaps`)).json();
  check('recaps are saved per document', savedRecaps.length >= 3, `${savedRecaps.length} saved`);
  check('asking for one range twice does not pile up rows',
    savedRecaps.filter((r) => r.to_page === 3 && !r.cut_text).length === 1);
  check('deleting an unknown recap 404s',
    (await fetch(`${BASE}/api/recaps/999999`, { method: 'DELETE' })).status === 404);

  /* ---- recap in the browser ---- */
  await page.locator('#recap-btn').click();
  await page.waitForSelector('#recap-range:not([hidden])');
  check('the recap range ends at the page you are on',
    (await page.locator('#recap-to').inputValue()) === (await page.locator('#page-input').inputValue()));
  check('the recap range starts at the beginning',
    (await page.locator('#recap-from').inputValue()) === '1');

  await page.locator('#recap-go').click();
  await page.waitForSelector('.panel-headline', { timeout: 20000 });
  check('the panel shows the summary',
    (await page.locator('#panel-body').textContent()).includes('Summary'));

  check('the recap draws a diagram', (await page.locator('.recap-diagram svg').count()) === 1);
  check('every node is drawn', (await page.locator('.recap-diagram .dg-node').count()) === 3);
  check('rough.js sketched it rather than drawing plain boxes',
    (await page.locator('.recap-diagram svg path').count()) > 5,
    `${await page.locator('.recap-diagram svg path').count()} paths`);
  check('the dropped edge is not drawn',
    !(await page.locator('.recap-diagram .dg-edge').allTextContents()).includes('dangling'));

  // rough.js writes colours into its paths, so a theme change has to redraw them.
  const nodeFill = () => page.evaluate(() => {
    const p = [...document.querySelectorAll('.recap-diagram svg path')]
      .find((n) => (n.getAttribute('fill') || 'none') !== 'none');
    return p?.getAttribute('fill') ?? null;
  });
  const lightFill = await nodeFill();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  const darkFill = await nodeFill();
  check('the sketch is redrawn for the other theme',
    lightFill && darkFill && lightFill !== darkFill, `${lightFill} -> ${darkFill}`);
  await page.emulateMedia({ colorScheme: 'light' });

  const scrolledFrom = await page.evaluate(() => document.getElementById('viewer-container').scrollTop);
  await page.locator('.recap-diagram .dg-node-link').first().click();
  await page.waitForTimeout(800);
  check('a node carrying a page number scrolls the viewer',
    (await page.evaluate(() => document.getElementById('viewer-container').scrollTop)) !== scrolledFrom);

  await page.locator('#recap-btn').click();
  await page.waitForSelector('#recap-range:not([hidden])');
  await page.locator('#recaps-open').click();
  await page.waitForSelector('#recaps:not([hidden])');
  check('saved recaps are listed', (await page.locator('#recaps-list .history-item').count()) >= 1);
  check('the recaps drawer displaces the panel', !(await page.locator('#panel').isVisible()));

  await page.locator('#history-btn').click();
  await page.waitForSelector('#history:not([hidden])');
  check('the history drawer displaces the recaps drawer',
    !(await page.locator('#recaps').isVisible()));
  await page.locator('#history-close').click();

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

  /* ---- printed page numbers and the outline, from a PDF that has both ---- */
  check('a PDF without an outline hides the contents button', await page.locator('#outline-btn').isHidden());

  const lform = new FormData();
  lform.append('pdf', new Blob([fs.readFileSync(path.join(HERE, 'fixtures/labelled.pdf'))], { type: 'application/pdf' }), 'labelled.pdf');
  const ldoc = await (await fetch(`${BASE}/api/documents`, { method: 'POST', body: lform })).json();

  await page.evaluate(() => localStorage.removeItem('spr:outline'));
  await page.goto(`${BASE}/#/doc/${ldoc.id}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('.page canvas').length > 0, null, { timeout: 20000 });
  await page.waitForSelector('#outline:not([hidden]) .outline-link', { timeout: 5000 }).catch(() => {});

  const pageInput = () => page.locator('#page-input').inputValue();
  check('the toolbar shows the printed number', (await pageInput()) === 'i', `got ${await pageInput()}`);
  check('and where that is in the file', (await page.locator('#page-physical').textContent()) === '(1 of 6)');
  check('pages are tagged with their printed number',
    (await page.locator('.page[data-page="1"] .page-number-tag').textContent()) === 'i');

  // The input shows the target at once; the position only changes once the scroll lands.
  const jumpTo = async (label, want, physical, name) => {
    await page.locator('#page-input').fill(label);
    await page.locator('#page-input').press('Enter');
    await page.waitForFunction(([w, p]) => document.getElementById('page-input').value === w
      && document.getElementById('page-physical').textContent === p, [want, physical], { timeout: 8000 })
      .then(() => check(name, true))
      .catch(async () => check(name, false,
        `landed on ${await pageInput()} ${await page.locator('#page-physical').textContent()}`));
  };
  await jumpTo('1', '1', '(3 of 6)', 'typing a printed number goes to that page, not the first in the file');
  await jumpTo('II', 'ii', '(2 of 6)', 'roman numerals are matched regardless of case');
  await page.locator('#page-input').fill('nonsense');
  await page.locator('#page-input').press('Enter');
  check('an unknown page puts the current one back', (await pageInput()) === 'ii');

  check('the outline opens on its own for a PDF that has one', await page.locator('#outline').isVisible());
  check('the outline shows top-level entries', (await page.locator('#outline-tree > .outline-item').count()) === 3);
  check('outline entries show printed page numbers',
    (await page.locator('.outline-item', { hasText: 'Chapter 2' }).locator('.outline-page').textContent()) === '4');

  const chapter1 = page.locator('#outline-tree > .outline-item', { hasText: 'Chapter 1' });
  check('chapters start collapsed', (await chapter1.getAttribute('aria-expanded')) === 'false');
  await chapter1.locator('> .outline-row .outline-toggle').click();
  check('the chevron expands a chapter', (await chapter1.getAttribute('aria-expanded')) === 'true');

  // Let the page jump above finish first: its last smooth-scroll frame would land on top of ours.
  await page.waitForFunction(() => new Promise((resolve) => {
    const c = document.getElementById('viewer-container');
    const before = c.scrollTop;
    setTimeout(() => resolve(c.scrollTop === before), 150);
  }), null, { timeout: 5000 });
  await chapter1.locator('.outline-link', { hasText: 'Section 1.2' }).click();
  await page.waitForTimeout(400);
  const landing = await page.evaluate(() => {
    const c = document.getElementById('viewer-container');
    const slot = document.querySelector('.page[data-page="5"]');
    // The entry points 400pt up a 792pt page, so about half way down it.
    return (c.scrollTop + 16 - slot.offsetTop) / slot.offsetHeight;
  });
  check('clicking a section puts its heading at the top of the view', Math.abs(landing - (1 - 400 / 792)) < 0.03,
    `landed ${landing.toFixed(3)} down the page`);
  await page.waitForFunction(() => document.querySelector('.outline-row.active')?.textContent.includes('Section 1.2'), null, { timeout: 3000 })
    .then(() => check('the section being read is highlighted', true))
    .catch(async () => check('the section being read is highlighted', false,
      await page.locator('.outline-row.active').textContent().catch(() => 'none')));

  await page.evaluate(() => {
    const c = document.getElementById('viewer-container');
    c.scrollTop = c.scrollHeight;
  });
  await page.waitForFunction(() => document.querySelector('.outline-row.active')?.textContent.includes('Chapter 2'), null, { timeout: 3000 })
    .then(() => check('the highlight follows scrolling', true))
    .catch(() => check('the highlight follows scrolling', false));

  await page.locator('#outline-btn').click();
  check('the contents button hides the outline', await page.locator('#outline').isHidden());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('outline-btn').hidden, null, { timeout: 5000 });
  check('a hidden outline stays hidden on reopen', await page.locator('#outline').isHidden());
  await page.keyboard.press('\\');
  check('backslash toggles the outline', await page.locator('#outline').isVisible());

  // Following the reader opens a chapter; moving past it closes it again, so a long
  // scroll does not leave every chapter it passed unfolded.
  const expanded = () => page.locator('#outline-tree > .outline-item', { hasText: 'Chapter 1' }).getAttribute('aria-expanded');
  const scrollToFilePage = (n) => page.evaluate((num) => {
    const c = document.getElementById('viewer-container');
    c.scrollTop = document.querySelector(`.page[data-page="${num}"]`).offsetTop - c.clientHeight * 0.35 + 10;
  }, n);
  await scrollToFilePage(4);
  await page.waitForFunction(() => document.querySelector('.outline-row.active')?.textContent.includes('Section 1.1'), null, { timeout: 3000 }).catch(() => {});
  check('reading a section opens its chapter', (await expanded()) === 'true');
  await scrollToFilePage(6);
  await page.waitForFunction(() => document.querySelector('.outline-row.active')?.textContent.includes('Chapter 2'), null, { timeout: 3000 }).catch(() => {});
  check('moving past it closes the chapter again', (await expanded()) === 'false');

  check('no uncaught errors in the page', pageErrors.length === 0, pageErrors[0] ?? '');

  /* ---- other providers: Mistral, Groq, OpenRouter and NVIDIA NIM, all on chat completions ---- */
  for (const [provider, keyVar, baseVar, endpoint] of [
    ['mistral', 'MISTRAL_API_KEY', 'MISTRAL_API_BASE', '/mistral/chat/completions'],
    ['groq', 'GROQ_API_KEY', 'GROQ_API_BASE', '/groq/chat/completions'],
    ['openrouter', 'OPENROUTER_API_KEY', 'OPENROUTER_API_BASE', '/openrouter/chat/completions'],
    ['nvidia', 'NVIDIA_API_KEY', 'NVIDIA_API_BASE', '/nvidia/chat/completions'],
  ]) {
    const prefix = endpoint.slice(0, endpoint.indexOf('/', 1));
    const altPort = STUB_PORT + 1;
    altServer = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...NO_PROVIDERS,
        PORT: String(altPort),
        DATA_DIR: path.join(tmp, `data-${provider}`),
        PDF_DIR: path.join(tmp, `pdfs-${provider}`),
        LLM_PROVIDER: provider,
        [keyVar]: `${provider}-key`,
        [baseVar]: `http://localhost:${STUB_PORT}${prefix}`,
      },
      stdio: 'ignore',
    });
    let health = null;
    for (let i = 0; i < 100 && !health; i++) {
      try { health = await (await fetch(`http://localhost:${altPort}/api/health`)).json(); } catch { /* not up yet */ }
      if (!health) await new Promise((r) => setTimeout(r, 100));
    }
    check(`${provider}: health names the provider`, health?.provider === provider && health.aiConfigured, JSON.stringify(health));
    check(`${provider}: the real .env does not leak into the test`,
      health?.model === { mistral: 'mistral-small-latest', groq: 'openai/gpt-oss-120b', openrouter: 'openai/gpt-oss-120b', nvidia: 'deepseek-ai/deepseek-v4.1-flash' }[provider], health?.model);

    const before = providerCalls.length;
    const res = await fetch(`http://localhost:${altPort}/api/explain`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selection: 'oxidative phosphorylation', context: 'The mitochondrion makes ATP.' }),
    });
    const answer = await res.json();
    check(`${provider}: an explanation arrives`, res.ok && answer.headline === 'oxidative phosphorylation', JSON.stringify(answer).slice(0, 120));

    const call = providerCalls[before];
    check(`${provider}: posts to ${endpoint}`, call?.path === endpoint, call?.path);
    check(`${provider}: sends a bearer key`, call?.headers.authorization === `Bearer ${provider}-key`);
    const turns = call?.body.messages;
    if (provider === 'nvidia') {
      // NIM model references want alternating user/assistant turns, so no system role.
      check('nvidia: instructions ride in a single user turn',
        turns?.length === 1 && turns[0].role === 'user' && turns[0].content.includes('Highlighted text'));
    } else {
      check(`${provider}: system then user turn`,
        turns?.[0]?.role === 'system' && turns[1]?.role === 'user' && turns[1].content.includes('Highlighted text'));
    }
    const format = call?.body.response_format?.json_schema;
    check(`${provider}: asks for the schema`,
      call?.body.response_format?.type === 'json_schema'
        && format?.schema?.properties?.headline?.type === 'string');
    check(`${provider}: no Gemini-only fields leak through`,
      call && !('thinking_level' in call.body) && !('generation_config' in call.body));
    if (provider === 'nvidia') {
      const retry = providerCalls[before + 1];
      check('nvidia: a refused response_format falls back to nvext.guided_json',
        !retry?.body.response_format && retry?.body.nvext?.guided_json?.properties?.headline?.type === 'string');
      check('nvidia: minimal thinking turns reasoning off', call?.body.reasoning_effort === 'none', call?.body.reasoning_effort);
    }
    if (provider === 'openrouter') {
      const sent = call?.body.response_format?.json_schema;
      check('openrouter: asks for strict mode with every property required', sent?.strict === true
        && JSON.stringify(sent.schema?.required) === JSON.stringify(Object.keys(sent.schema?.properties ?? {})));
      check('openrouter: optional fields become nullable', JSON.stringify(sent?.schema?.properties?.details?.type) === '["array","null"]');
      check('openrouter: routes only to providers that honour the schema', call?.body.provider?.require_parameters === true);
      check('openrouter: routes only to providers that do not keep prompts', call?.body.provider?.data_collection === 'deny');
      check('openrouter: thinking level becomes reasoning effort, not returned',
        call?.body.reasoning?.effort === 'minimal' && call.body.reasoning.exclude === true, JSON.stringify(call?.body.reasoning));
      check('openrouter: the output budget leaves room for reasoning', call?.body.max_tokens > 2048, call?.body.max_tokens);
    }
    if (provider === 'groq') {
      const sent = call?.body.response_format?.json_schema;
      check('groq: asks for strict mode', sent?.strict === true);
      check('groq: every property is required, as strict mode demands',
        JSON.stringify(sent?.schema?.required) === JSON.stringify(Object.keys(sent?.schema?.properties ?? {})));
      check('groq: optional fields become nullable', JSON.stringify(sent?.schema?.properties?.details?.type) === '["array","null"]',
        JSON.stringify(sent?.schema?.properties?.details?.type));
      check('groq: nested objects are closed too', sent?.schema?.properties?.details?.items?.additionalProperties === false);
      check('groq: minimal thinking maps to low reasoning effort', call?.body.reasoning_effort === 'low', call?.body.reasoning_effort);
      check('groq: the reasoning does not come back', call?.body.include_reasoning === false);
      check('groq: the output budget leaves room for reasoning', call?.body.max_completion_tokens > 2048, call?.body.max_completion_tokens);
    }

    altServer.kill();
    altServer = null;
  }
} catch (err) {
  fail.push(` FAIL  test run threw: ${err.message}`);
} finally {
  await cleanup();
}

console.log([...pass, ...fail].join('\n'));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
