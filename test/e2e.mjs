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
import { fileURLToPath, pathToFileURL } from 'node:url';

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
      : props.branches ? MINDMAP_ANSWER
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

const MINDMAP_ANSWER = {
  title: 'How cells make energy',
  root: 'Cellular energy',
  branches: [
    { label: 'Proton gradient', children: [{ label: 'Built across the membrane' }, { label: '' }] },
    { label: 'ATP synthase', children: [{ label: 'Turned by the gradient' }] },
    { label: '', children: [{ label: 'belongs to no branch' }] },   // no label: must be dropped
    { label: 'proton gradient', children: [] },                      // duplicate: must be dropped
    { label: 'Uses of ATP', children: [] },
  ],
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
  // Never load (or download) the real voice model; the stub answers with a tone.
  TTS_ENGINE: 'stub',
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

  /* ---- ink: the stroke format the browser and the server share ---- */
  const inkFormat = await import(pathToFileURL(path.join(ROOT, 'public/ink-format.js')));
  const inkLine = [0, 0, 1, 0.01, 2, 0, 3, 0.01, 4, 0];
  const inkFlat = inkFormat.simplify(inkLine, null, 0.1);
  check('ink: simplifying keeps the ends and drops the points on the line',
    JSON.stringify(inkFlat.points) === '[0,0,4,0]', JSON.stringify(inkFlat.points));
  // Its neighbours stay too: without them the spike would smear into a slow ramp.
  const inkPressed = inkFormat.simplify(inkLine, [0.5, 0.5, 0.9, 0.5, 0.5], 0.1);
  check('ink: a point pressed harder mid-line is kept',
    inkPressed.points.length > inkFlat.points.length && inkPressed.pressures.includes(0.9), JSON.stringify(inkPressed));
  const inkRamp = inkFormat.simplify(inkLine, [0.1, 0.3, 0.5, 0.7, 0.9], 0.1);
  check('ink: pressure that changes steadily needs no extra points',
    inkRamp.points.length === 4 && JSON.stringify(inkRamp.pressures) === '[0.1,0.9]', JSON.stringify(inkRamp));
  const aStroke = { tool: 'pen', color: '#1c1b19', width: 1.8, points: [10, 10, 50, 40] };
  check('ink: a colour that is not #rrggbb is refused', typeof inkFormat.checkStroke({ ...aStroke, color: 'red' }) === 'string');
  check('ink: a point that is not a number is refused', typeof inkFormat.checkStroke({ ...aStroke, points: [1, NaN] }) === 'string');
  check('ink: a stroke past the point limit is refused',
    typeof inkFormat.checkStroke({ ...aStroke, points: new Array(2 * (inkFormat.LIMITS.points + 1)).fill(1) }) === 'string');
  check('ink: pressures must match the points', typeof inkFormat.checkStroke({ ...aStroke, pressures: [0.5] }) === 'string');
  const inkTidy = inkFormat.checkStroke({ ...aStroke, color: '#C8312B', points: [1.234, 2.25], pressures: [0.333] });
  check('ink: a good stroke is tidied for storage',
    inkTidy.color === '#c8312b' && inkTidy.points[0] === 1.2 && inkTidy.pressures[0] === 0.33, JSON.stringify(inkTidy));

  /* ---- ink: the API ---- */
  const putInk = (p, body) => fetch(`${BASE}/api/documents/${doc.id}/ink/${p}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const inkOnServer = async () => (await fetch(`${BASE}/api/documents/${doc.id}/ink`)).json();
  check('ink: a page saves', (await putInk(2, { strokes: [aStroke] })).ok);
  check('ink: the scratch pad is page 0', (await putInk(0, { strokes: [aStroke] })).ok);
  const inkBoth = await inkOnServer();
  check('ink: both come back, in page order',
    inkBoth.length === 2 && inkBoth[0].page === 0 && inkBoth[1].strokes[0].points[2] === 50, JSON.stringify(inkBoth).slice(0, 120));
  check('ink: past the last page is refused', (await putInk(10, { strokes: [] })).status === 400);
  check('ink: a malformed stroke is refused', (await putInk(2, { strokes: [{ ...aStroke, color: 'red' }] })).status === 400);
  check('ink: JSON that does not parse is a 400, not a 500', (await putInk(2, '{"strokes":')).status === 400);
  check('ink: more than the usual 1 MB is taken for ink',
    (await putInk(2, { strokes: [aStroke], note: 'x'.repeat(2 * 1024 * 1024) })).ok);
  const inkHuge = await putInk(2, `{"strokes":[],"note":"${'x'.repeat(9 * 1024 * 1024)}"}`);
  check('ink: past 8 MB is a 413, not a 500', inkHuge.status === 413, `got ${inkHuge.status}`);
  await putInk(2, { strokes: [] });
  await putInk(0, { strokes: [] });
  check('ink: an emptied page is gone', (await inkOnServer()).length === 0);
  check('ink: an unknown document is a 404', (await fetch(`${BASE}/api/documents/nope/ink`)).status === 404);

  /* ---- read aloud: what gets said ---- */
  const { buildChunk } = await import(pathToFileURL(path.join(ROOT, 'public/speech-text.js')));
  // Words laid out the way the tracker measures them. A line is a string, or
  // { text, h, y } for a different size or place; "^12" is a raised footnote mark.
  const layout = (lines, height = 800) => {
    const words = [];
    let y = 60;
    lines.forEach((line, n) => {
      const { text, h = 10, y: at } = typeof line === 'string' ? { text: line } : line;
      if (at !== undefined) y = at;
      let x = 50;
      for (const token of text.split(' ')) {
        const raised = token.startsWith('^');
        const t = raised ? token.slice(1) : token;
        const wh = raised ? h * 0.6 : h;
        words.push({ x, y: raised ? y - h * 0.25 : y, w: t.length * wh * 0.5, h: wh, text: t, line: n });
        x += t.length * wh * 0.5 + h * 0.3;
      }
      y += h * 1.25;
    });
    return { words, height };
  };
  const chunkOf = (pages, opts, from = { page: 1, i: 0 }) =>
    buildChunk(async (n) => pages[n - 1] ?? null, from, opts);
  const said = async (pages, opts) => (await chunkOf(pages, opts))?.text;

  check('read aloud: "e.g." does not end a sentence',
    await said([layout(['Plants make sugar, e.g. glucose, from light. Then more.'])])
      === 'Plants make sugar, e.g. glucose, from light.');
  const headed = [layout([{ text: 'Membrane Transport', h: 16 }, 'Cells move ions across membranes.'])];
  const heading = await chunkOf(headed);
  check('read aloud: a heading is said on its own, with a full stop', heading?.text === 'Membrane Transport.', heading?.text);
  check('read aloud: and takes a longer pause after it', heading?.pauseAfter > 0.4);
  check('read aloud: the paragraph follows the heading',
    (await chunkOf(headed, {}, heading.next))?.text === 'Cells move ions across membranes.');
  check('read aloud: footnote marks are not read out',
    await said([layout(['Energy is stored ^3 as ATP in the cell.12'])]) === 'Energy is stored as ATP in the cell.',
    await said([layout(['Energy is stored ^3 as ATP in the cell.12'])]));
  const turned = await chunkOf([layout(['The pump moves', { text: '7', y: 770 }]), layout(['sodium out of the cell.'])]);
  check('read aloud: a sentence runs on over the page turn, skipping the page number',
    turned?.text === 'The pump moves sodium out of the cell.', turned?.text);
  check('read aloud: each spoken word knows its page', turned?.words.at(-1).page === 2 && turned?.words.at(-1).i === 4);
  check('read aloud: a word hyphenated over a line break is said whole',
    await said([layout(['Most ATP comes from mito-', 'chondria in the cell.'])]) === 'Most ATP comes from mitochondria in the cell.'
    && await said([layout(['Most ATP comes from mito\u2010', 'chondria in the cell.'])]) === 'Most ATP comes from mitochondria in the cell.');
  for (const [cited, spoken] of [
    ['As shown in [7, 8, 9].', 'As shown in.'],
    ['As shown in [7,8,9].', 'As shown in.'],
    ['As shown in [12].', 'As shown in.'],
    ['As shown in [3–5].', 'As shown in.'],
    ['As shown [7, 8], the pump works.', 'As shown, the pump works.'],
    ['Found in membranes[4].', 'Found in membranes.'],
    ['See pp. 3–5 of it.', 'See pp. 3 to 5 of it.'],
  ]) {
    const got = await said([layout([cited])]);
    check(`read aloud: citations are skipped — ${cited}`, got === spoken, got);
  }
  check('read aloud: a dash between clauses is a pause',
    await said([layout(['Pumps use energy – lots of it.'])]) === 'Pumps use energy, lots of it.');
  const rambling = Array.from({ length: 50 }, (_, k) => (k === 19 ? `w${k},` : `w${k}`)).join(' ') + '.';
  check('read aloud: a very long sentence is split at a comma',
    (await said([layout([rambling])]))?.endsWith('w19,'));
  check('read aloud: the first chunk stops at an early comma, so the voice starts sooner',
    await said([layout(['One two three four five six seven, eight nine ten.'])], { maxWords: 18, softWords: 6 })
      === 'One two three four five six seven,');

  /* ---- read aloud: the voice API ---- */
  const speechStatus = await (await fetch(`${BASE}/api/speech/status`)).json();
  check('speech status names the stub engine, ready, with voices',
    speechStatus.engine === 'stub' && speechStatus.state === 'ready' && speechStatus.voices.length > 1,
    JSON.stringify(speechStatus).slice(0, 80));
  const speechPost = (body) => fetch(`${BASE}/api/speech`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  check('speech refuses empty text', (await speechPost({ text: '  ' })).status === 400);
  check('speech refuses too much text at once', (await speechPost({ text: 'word '.repeat(200) })).status === 400);
  check('speech refuses an unknown voice', (await speechPost({ text: 'Hello.', voice: 'nobody' })).status === 400);
  const shortWav = await speechPost({ text: 'Hello there.' });
  const longWav = await speechPost({ text: 'Hello there, this is a much longer sentence to read.' });
  const shortBytes = (await shortWav.arrayBuffer()).byteLength;
  const longBytes = (await longWav.arrayBuffer()).byteLength;
  check('speech answers with a WAV', shortWav.headers.get('content-type')?.startsWith('audio/wav'));
  check('longer text makes longer audio', longBytes > shortBytes, `${shortBytes} < ${longBytes}`);

  /* ---- the reader itself ---- */
  browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // A stand-in voice: headless Chrome has none, and a test shouldn't talk anyway. It
  // "says" one word every 80ms, reporting each one the way a local voice does.
  await page.addInitScript(() => {
    const log = { spoken: [], cancels: 0 };
    let timers = [];
    window.__speech = log;
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        getVoices: () => [],
        addEventListener() {},
        cancel() { log.cancels++; timers.forEach(clearTimeout); timers = []; },
        speak(u) {
          log.spoken.push(u.text);
          const at = [...u.text.matchAll(/\S+/g)].map((m) => m.index);
          timers.push(setTimeout(() => u.onstart?.({}), 0));
          at.forEach((charIndex, k) => timers.push(setTimeout(() => u.onboundary?.({ name: 'word', charIndex }), 80 * k)));
          timers.push(setTimeout(() => u.onend?.({}), 80 * at.length));
        },
      },
    });
  });
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

  // Reading tracker: click a word, the pill starts walking; speed sticks; Escape stops it.
  const scrollBefore = await page.evaluate(() => document.getElementById('viewer-container').scrollTop);
  await page.click('#tracker-btn');
  check('tracker button shows its controls', await page.locator('#tracker-bar').isVisible());
  await page.locator('.page .textLayer span').filter({ hasText: /\w{3,}/ }).first().click();
  await page.waitForFunction(() => document.getElementById('tracker-marker').classList.contains('visible'), null, { timeout: 5000 });
  const markerAt = () => page.evaluate(() => document.getElementById('tracker-marker').style.transform);
  const firstAt = await markerAt();
  await page.waitForTimeout(900);
  const laterAt = await markerAt();
  check('tracker pill moves while playing', firstAt && laterAt && firstAt !== laterAt, `${firstAt} -> ${laterAt}`);
  check('tracker shows as playing', await page.locator('#tracker-play.playing').count() === 1);
  const wpmBefore = await page.evaluate(() => Number(document.getElementById('tracker-speed').value));
  await page.keyboard.press(']');
  check('] speeds the tracker up and remembers it',
    await page.evaluate(() => Number(localStorage.getItem('spr:tracker-wpm'))) === wpmBefore + 25);
  await page.keyboard.press(' ');
  check('space pauses the tracker', await page.locator('#tracker-play.playing').count() === 0);

  // Read aloud with the natural voice (the stub engine answers with a tone).
  const speechPosts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/speech') speechPosts.push(r.postDataJSON());
  });
  const until = async (fn, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(50)) if (await fn()) return true;
    return false;
  };
  const trackerWpmBefore = await page.evaluate(() => localStorage.getItem('spr:tracker-wpm'));
  await page.keyboard.press('v');
  check('v turns reading aloud on and remembers it',
    await page.locator('#tracker-voice.active[aria-pressed="true"]').count() === 1
    && await page.evaluate(() => localStorage.getItem('spr:tracker-narrate')) === '1');
  check('the slider becomes the speaking speed',
    await page.evaluate(() => { const s = document.getElementById('tracker-speed'); return s.value === '175' && s.max === '325'; }));
  check('turning reading aloud on while paused says nothing', speechPosts.length === 0);
  await page.keyboard.press(' ');
  check('play asks the server to say the first sentence', await until(() => speechPosts.length > 0), speechPosts[0]?.text);
  const firstText = speechPosts[0]?.text ?? '';
  check('the first chunk is short, so the voice starts quickly', firstText.split(' ').length <= 18, firstText);
  check('it is said at the speaking pace', Math.abs((speechPosts[0]?.speed ?? 0) - 175 / 165) < 0.01);
  check('the voice picker shows, with the server\'s voices',
    await page.locator('#tracker-voice-pick').isVisible()
    && await page.locator('#tracker-voice-pick option').count() === speechStatus.voices.length);
  await until(async () => !(await page.locator('#tracker-voice.busy').count()), 3000);
  const voiceFrom = await markerAt();
  await page.waitForTimeout(900);
  check('the pill follows the voice', voiceFrom !== await markerAt());
  check('the next sentence is fetched while this one plays', await until(() => speechPosts.length > 1));

  await page.keyboard.press(' ');
  check('space pauses reading aloud', await page.locator('#tracker-play.playing').count() === 0);
  await page.waitForTimeout(700);
  const restAt = await markerAt();
  const postsWhilePaused = speechPosts.length;
  await page.waitForTimeout(500);
  check('the pill rests while paused', restAt === await markerAt());
  check('nothing more is fetched while paused', speechPosts.length === postsWhilePaused);
  await page.keyboard.press(' ');
  await page.waitForTimeout(600);
  check('resuming says the interrupted sentence again, without fetching it anew',
    speechPosts.filter((p) => p.text === firstText).length === 1);

  await page.locator('#tracker-voice-pick').selectOption('bf_emma');
  check('picking a voice switches to it straight away',
    await until(() => speechPosts.some((p) => p.voice === 'bf_emma'), 1500));
  check('the voice is remembered', await page.evaluate(() => localStorage.getItem('spr:tracker-voice')) === 'bf_emma');

  await page.keyboard.press(']');
  check('] changes the speaking speed, not the reading speed',
    await page.evaluate(() => localStorage.getItem('spr:tracker-narrate-wpm')) === '200'
    && await page.evaluate(() => localStorage.getItem('spr:tracker-wpm')) === trackerWpmBefore);
  check('the next sentence is fetched again at the new pace',
    await until(() => speechPosts.some((p) => Math.abs(p.speed - 200 / 165) < 0.01)));
  await page.keyboard.press(' ');

  // With no voice on the server, the browser's own voice reads instead.
  const offStatus = { engine: 'off', state: 'off', progress: 0, error: '', voices: [], defaultVoice: '' };
  await page.route('**/api/speech/status', (route) => route.fulfill({ json: offStatus }));
  await page.keyboard.press('v');
  await page.keyboard.press('v');
  await page.keyboard.press(' ');
  check('without a server voice, the system voice reads',
    await until(() => page.evaluate(() => window.__speech.spoken.length > 0)));
  check('the voice picker hides for the system voice', !(await page.locator('#tracker-voice-pick').isVisible()));
  const systemFrom = await markerAt();
  await page.waitForTimeout(700);
  check('the pill follows the system voice too', systemFrom !== await markerAt());
  const cancelsBefore = await page.evaluate(() => window.__speech.cancels);
  await page.keyboard.press(' ');
  check('pausing silences the system voice', await page.evaluate(() => window.__speech.cancels) > cancelsBefore);
  await page.unroute('**/api/speech/status');
  await page.click('#tracker-voice');
  check('the button turns reading aloud off',
    await page.locator('#tracker-voice.active').count() === 0
    && await page.evaluate(() => localStorage.getItem('spr:tracker-narrate')) === '0');
  await page.keyboard.press('Escape');
  check('escape turns the tracker off, not the document',
    !(await page.locator('#tracker-bar').isVisible()) && await page.locator('#reader:not([hidden])').count() === 1);
  await page.evaluate(() => {
    for (const k of ['spr:tracker-wpm', 'spr:tracker-narrate', 'spr:tracker-narrate-wpm', 'spr:tracker-voice']) localStorage.removeItem(k);
  });
  await page.evaluate((top) => { document.getElementById('viewer-container').scrollTop = top; }, scrollBefore);

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
  check('a short highlight does not offer a mind map', !(await page.locator('#mindmap-btn').isVisible()));

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

  /* ---- mind map of a passage ---- */
  const mindmapPost = (body) => fetch(`${BASE}/api/mindmap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId: doc.id, page: 1, ...body }),
  });
  const passage = 'The mitochondrion builds a proton gradient across its inner membrane, '
    + 'and ATP synthase uses that gradient to make ATP for the rest of the cell.';

  const callsBeforeMap = calls.length;
  const map = await (await mindmapPost({ selection: passage, context: 'page text' })).json();
  check('a mind map comes back as a tree', map.root === 'Cellular energy' && map.title === 'How cells make energy');
  check('the mind map drops unlabelled and repeated branches',
    JSON.stringify(map.branches.map((b) => b.label)) === JSON.stringify(['Proton gradient', 'ATP synthase', 'Uses of ATP']),
    JSON.stringify(map.branches?.map((b) => b.label)));
  check('the mind map drops empty leaves', map.branches[0].children.length === 1);
  check('the mind map asks for a tree',
    Boolean(calls.at(-1).body.response_format?.schema?.properties?.branches));

  const callsAfterMap = calls.length;
  const mapAgain = await (await mindmapPost({ selection: passage, context: 'page text' })).json();
  check('mapping the same passage twice is cached', mapAgain.cached === true && calls.length === callsAfterMap);
  check('a first mind map is not cached', map.cached === false && callsAfterMap > callsBeforeMap);

  check('a passage too short to map is refused',
    (await mindmapPost({ selection: 'just a few words' })).status === 422);
  check('an empty selection is refused',
    (await mindmapPost({ selection: '   ' })).status === 400);

  const longSelected = await page.evaluate(() => {
    const bounds = document.getElementById('viewer-container').getBoundingClientRect();
    const spans = [...document.querySelectorAll('.page .textLayer span')].filter((s) => {
      const r = s.getBoundingClientRect();
      return s.textContent.trim() && r.top > bounds.top + 40 && r.bottom < bounds.bottom - 40;
    });
    if (spans.length < 2) return 0;
    const pageEl = spans[0].closest('.page');
    const onPage = spans.filter((s) => s.closest('.page') === pageEl);
    const range = document.createRange();
    range.setStart(onPage[0].firstChild, 0);
    const last = onPage.at(-1).firstChild;
    range.setEnd(last, last.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.getElementById('viewer-container').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return sel.toString().trim().split(/\s+/).length;
  });
  check('found a passage long enough to map', longSelected >= 12, `${longSelected} words`);

  await page.waitForSelector('#mindmap-btn:not([hidden])', { timeout: 4000 })
    .then(() => check('a long highlight offers a mind map', true))
    .catch(() => check('a long highlight offers a mind map', false));
  await page.locator('#mindmap-btn').click().catch(() => {});
  await page.waitForSelector('#panel .mindmap svg', { timeout: 15000 })
    .then(() => check('the mind map is drawn in the panel', true))
    .catch(() => check('the mind map is drawn in the panel', false));
  const drawn = await page.evaluate(() => ({
    wide: document.getElementById('panel').classList.contains('panel-wide'),
    text: document.querySelector('#panel .mindmap svg')?.textContent ?? '',
    paths: document.querySelectorAll('#panel .mindmap svg path').length,
  }));
  check('the mind map shows its topic and branches',
    drawn.text.includes('Cellular energy') && drawn.text.includes('ATP synthase'), drawn.text);
  check('the mind map is sketched with rough.js', drawn.paths > 5, `${drawn.paths} paths`);
  check('the panel widens for a mind map', drawn.wide);

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

  /* ---- drawing on the pages, and the scratch pad ---- */
  await page.evaluate(() => {
    for (const key of ['spr:ink', 'spr:pad']) localStorage.removeItem(key);
    localStorage.setItem('spr:zoom', '1');
  });
  await page.goto(`${BASE}/#/doc/${doc.id}`, { waitUntil: 'networkidle' });
  // A hash change resolves before the book is open, and opening it restores the saved
  // place; go to the top only after that, and wait for page 1 to have its ink layer.
  const inkTop = async () => {
    await page.waitForFunction(() => document.getElementById('page-count').textContent === '9'
      && document.querySelector('.page canvas'), null, { timeout: 20000 });
    await page.evaluate(() => { document.getElementById('viewer-container').scrollTop = 0; });
    await page.waitForSelector('.page[data-page="1"] .ink-layer', { timeout: 10000 });
  };
  await inkTop();

  const page1 = '.page[data-page="1"]';
  const layer1 = `${page1} .ink-layer`;
  const padLayer = '#pad-sheet .ink-layer';
  const strokesOn = async (n) => (await inkOnServer()).find((p) => p.page === n)?.strokes ?? [];
  const pathsIn = (sel) => page.locator(`${sel} path`).count();
  const inkAt = async (sel, fx, fy) => {
    const b = await page.locator(sel).boundingBox();
    return [b.x + b.width * fx, b.y + b.height * fy];
  };
  const inkDrag = async (from, to, steps = 12) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    }
    await page.mouse.up();
  };
  const inkSaved = () => page.waitForFunction(() => document.getElementById('draw-status').textContent === 'Saved',
    null, { timeout: 5000 }).then(() => true, () => false);
  const pointerEventsOf = (sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).pointerEvents, sel);

  check('the ink layer ignores the pointer until the pen is out', (await pointerEventsOf(layer1)) === 'none');
  await page.keyboard.press('d');
  check('d puts the pen out and shows the drawing tools',
    await page.locator('#draw-bar').isVisible() && (await page.locator('#draw-btn').getAttribute('aria-pressed')) === 'true');

  await inkDrag(await inkAt(page1, 0.2, 0.3), await inkAt(page1, 0.6, 0.34));
  check('a drag on the page draws a stroke', (await pathsIn(layer1)) === 1);
  check('drawing selects no text', await page.evaluate(() => getSelection().isCollapsed));
  check('and brings up no lookup button', await page.locator('#sel-actions').isHidden());
  check('the stroke saves by itself', await inkSaved());
  const [inkFirst] = await strokesOn(1);
  const inkBase = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return {
      w: Number(el.style.getPropertyValue('--base-w')), h: Number(el.style.getPropertyValue('--base-h')),
      box: el.querySelector('.ink-layer').getAttribute('viewBox'),
    };
  }, page1);
  check('the ink layer is the page at 100%, in page units', inkBase.box === `0 0 ${inkBase.w} ${inkBase.h}`,
    `${inkBase.box} vs ${inkBase.w}x${inkBase.h}`);
  check('the stroke is stored where it was drawn',
    inkFirst && Math.abs(inkFirst.points[0] - inkBase.w * 0.2) < 2 && Math.abs(inkFirst.points[1] - inkBase.h * 0.3) < 2,
    JSON.stringify(inkFirst?.points.slice(0, 2)));
  check('a mouse draws an even line, with no pressures stored', inkFirst && !('pressures' in inkFirst));

  // Ink is in page units, so a zoom moves and scales it exactly with the page.
  const strokeFraction = () => page.evaluate((s) => {
    const p = document.querySelector(`${s} .ink-layer path`).getBoundingClientRect();
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: (p.left - r.left) / r.width, y: (p.top - r.top) / r.height, w: p.width / r.width };
  }, page1);
  const inkBefore = await strokeFraction();
  await page.locator('#zoom-in').click();
  await page.waitForTimeout(1400);
  const inkAfter = await strokeFraction();
  check('zooming keeps the stroke on the same spot of the page',
    ['x', 'y', 'w'].every((k) => Math.abs(inkBefore[k] - inkAfter[k]) < 0.005),
    `${JSON.stringify(inkBefore)} -> ${JSON.stringify(inkAfter)}`);
  check('and the layer survives the re-render', (await pathsIn(layer1)) === 1);
  await page.locator('#zoom-out').click();
  await page.waitForTimeout(1000);
  await inkTop();

  await page.keyboard.press('h');
  await inkDrag(await inkAt(page1, 0.15, 0.45), await inkAt(page1, 0.7, 0.45));
  check('a highlighter stroke goes under the pen ink', await page.evaluate((s) => {
    const [marks, lines] = document.querySelector(s).children;
    return marks.children.length === 1 && lines.children.length === 1;
  }, layer1));

  await page.keyboard.press('p');
  await page.keyboard.press('3');
  await inkDrag(await inkAt(page1, 0.2, 0.6), await inkAt(page1, 0.5, 0.6));
  await inkSaved();
  check('the thickness picker sets the width', (await strokesOn(1)).at(-1)?.width === 3,
    String((await strokesOn(1)).at(-1)?.width));
  check('and the bar shows it', (await page.locator('#draw-size').getAttribute('data-size')) === 'bold');
  await page.keyboard.press('2');

  const inkDrawn = await pathsIn(layer1);
  await page.keyboard.press('e');
  await inkDrag(await inkAt(page1, 0.35, 0.2), await inkAt(page1, 0.35, 0.4), 16);
  check('the eraser takes out the stroke it crosses', (await pathsIn(layer1)) === inkDrawn - 1);
  await page.keyboard.press('ControlOrMeta+z');
  check('undo puts it back', (await pathsIn(layer1)) === inkDrawn);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  check('redo takes it out again', (await pathsIn(layer1)) === inkDrawn - 1);
  check('and the server keeps up', await inkSaved() && (await strokesOn(1)).length === inkDrawn - 1);
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('p');

  const penFill = () => page.evaluate((s) => document.querySelector(`${s} g:last-child path`).getAttribute('fill'), layer1);
  const inkLight = await penFill();
  await page.click('#dark-pages-btn');
  const inkDark = await penFill();
  check('dark pages turn the ink the way they turn the page',
    inkLight === '#1c1b19' && inkDark !== inkLight && parseInt(inkDark.slice(1, 3), 16) > 160, `${inkLight} -> ${inkDark}`);
  await page.click('#dark-pages-btn');

  await page.keyboard.press('t');
  check('turning the tracker on puts the pen down',
    (await page.locator('#draw-btn').getAttribute('aria-pressed')) === 'false' && await page.locator('#draw-bar').isHidden());
  await page.keyboard.press('d');
  check('and taking the pen out turns the tracker off', (await page.locator('#tracker-btn').getAttribute('aria-pressed')) === 'false');
  await page.keyboard.press('Escape');
  check('Escape puts the pen down', (await page.locator('#draw-btn').getAttribute('aria-pressed')) === 'false');
  check('and the page selects text as before', (await pointerEventsOf(layer1)) === 'none');

  // A pen, as a tablet driver reports one.
  await page.keyboard.press('d');
  const cdp = await page.context().newCDPSession(page);
  const stylus = (type, [x, y], o = {}) => cdp.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'pen', ...o,
  });
  const stylusLine = async (fy, force, o = {}) => {
    const from = await inkAt(page1, 0.2, fy), to = await inkAt(page1, 0.6, fy);
    await stylus('mousePressed', from, { force: typeof force === 'function' ? force(0) : force, ...o });
    for (let i = 1; i <= 20; i++) {
      await stylus('mouseMoved', [from[0] + ((to[0] - from[0]) * i) / 20, from[1]],
        { force: typeof force === 'function' ? force(i / 20) : force, ...o });
    }
    await stylus('mouseReleased', to, { force: 0, ...o });
  };
  await stylusLine(0.7, 0.2);
  await stylusLine(0.8, 0.9);
  await inkSaved();
  const [inkSoft, inkHard] = (await strokesOn(1)).slice(-2);
  check('a pen stroke keeps its pressure',
    inkSoft?.pressures?.every((p) => Math.abs(p - 0.2) < 0.01) && inkHard?.pressures?.every((p) => Math.abs(p - 0.9) < 0.01),
    JSON.stringify([inkSoft?.pressures, inkHard?.pressures]));
  const inkWidths = await page.evaluate((s) => [...document.querySelectorAll(`${s} g:last-child path`)]
    .slice(-2).map((p) => p.getBoundingClientRect().height), layer1);
  check('pressing harder draws a thicker line', inkWidths[1] > inkWidths[0] * 1.6, inkWidths.map((w) => w.toFixed(1)).join(' vs '));

  // A long line is drawn in pieces while the pen is down, so each frame redraws only the
  // newest; lifting the pen leaves one stroke.
  const inkPathsBefore = await pathsIn(layer1);
  const longFrom = await inkAt(page1, 0.15, 0.75);
  await stylus('mousePressed', longFrom, { force: 0.5 });
  for (let i = 1; i <= 120; i++) {
    await stylus('mouseMoved', [longFrom[0] + i * 3, longFrom[1] + Math.sin(i / 4) * 6], { force: 0.5 });
  }
  const inkPieces = (await pathsIn(layer1)) - inkPathsBefore;
  await stylus('mouseReleased', [longFrom[0] + 360, longFrom[1]], { force: 0 });
  check('a long line is drawn in pieces while the pen is down', inkPieces > 2, `${inkPieces} pieces`);
  check('and is one stroke once it lifts', (await pathsIn(layer1)) === inkPathsBefore + 1);
  await page.keyboard.press('ControlOrMeta+z');

  // Pen to screen within a frame, as Chrome itself measures it. Redrawing in a
  // requestAnimationFrame instead of in the event once cost a whole frame (6.8 -> 23.7 ms).
  await browser.startTracing(page, { categories: ['input', 'latencyInfo', 'benchmark'] });
  await stylus('mousePressed', longFrom, { force: 0.5 });
  for (let i = 1; i <= 60; i++) {
    await stylus('mouseMoved', [longFrom[0] + i * 4, longFrom[1] + Math.sin(i / 4) * 6], { force: 0.5 });
    await page.waitForTimeout(8);
  }
  await stylus('mouseReleased', [longFrom[0] + 240, longFrom[1]], { force: 0 });
  const inkTrace = JSON.parse((await browser.stopTracing()).toString());
  const inkStarts = new Map(), inkLatency = [];
  for (const e of inkTrace.traceEvents ?? inkTrace) {
    if (e.name !== 'InputLatency::MouseMove') continue;
    const key = e.id2?.local ?? e.id2?.global ?? e.id;
    if (e.ph === 'b') inkStarts.set(key, e.ts);
    else if (e.ph === 'e' && inkStarts.has(key)) inkLatency.push((e.ts - inkStarts.get(key)) / 1000);
  }
  inkLatency.sort((a, b) => a - b);
  const inkMedian = inkLatency[inkLatency.length >> 1];
  check('the ink reaches the screen within a frame of the pen moving',
    inkLatency.length > 30 && inkMedian < 16, `median ${inkMedian?.toFixed(1)} ms over ${inkLatency.length} moves`);
  await page.keyboard.press('ControlOrMeta+z');

  await stylusLine(0.88, (t) => 0.2 + t * 0.6, { pointerType: 'mouse' });
  await inkSaved();
  check('a tablet that calls itself a mouse still gets its pressure',
    Boolean((await strokesOn(1)).at(-1)?.pressures), JSON.stringify((await strokesOn(1)).at(-1)?.pressures?.slice(0, 4)));

  const inkBeforeBarrel = await pathsIn(layer1);
  await page.evaluate(() => {
    window.inkMenuBlocked = null;
    window.addEventListener('contextmenu', (e) => { window.inkMenuBlocked = e.defaultPrevented; }, { once: true });
  });
  const onHard = await inkAt(page1, 0.4, 0.8);
  await stylus('mousePressed', onHard, { button: 'right', buttons: 2, force: 0.5 });
  await stylus('mouseMoved', [onHard[0] + 4, onHard[1]], { button: 'right', buttons: 2, force: 0.5 });
  await stylus('mouseReleased', [onHard[0] + 4, onHard[1]], { button: 'right', buttons: 0 });
  check("a pen's barrel button erases", (await pathsIn(layer1)) === inkBeforeBarrel - 1);
  check('without opening the context menu', await page.evaluate(() => window.inkMenuBlocked) === true);
  await cdp.detach();

  const inkKept = await pathsIn(layer1);
  await inkSaved();
  await page.reload({ waitUntil: 'networkidle' });
  await inkTop();
  await page.waitForFunction(([s, n]) => document.querySelectorAll(`${s} path`).length === n, [layer1, inkKept], { timeout: 10000 })
    .catch(() => {});
  check('the ink is all there after a reload', (await pathsIn(layer1)) === inkKept, `${await pathsIn(layer1)} of ${inkKept}`);

  // Closing the tab inside the half second before a save: warned, and saved regardless.
  await page.keyboard.press('d');
  const inkBeforeQuit = (await strokesOn(1)).length;
  await inkDrag(await inkAt(page1, 0.2, 0.5), await inkAt(page1, 0.5, 0.52));
  let inkWarned = false;
  page.once('dialog', (dlg) => { inkWarned = dlg.type() === 'beforeunload'; dlg.accept(); });
  await page.reload({ waitUntil: 'networkidle' });
  check('leaving with ink unsaved asks first', inkWarned);
  check('and the ink reaches the server all the same',
    await until(async () => (await strokesOn(1)).length === inkBeforeQuit + 1, 3000));

  /* ---- the scratch pad ---- */
  await page.keyboard.press('n');
  check('n opens the scratch pad', await page.locator('#pad').isVisible());
  check('with the drawing tools, though the pages are not being drawn on',
    await page.locator('#draw-bar').isVisible() && await page.locator('#draw-close').isHidden());
  const padHeight = async () => Number((await page.locator(padLayer).getAttribute('viewBox')).split(' ')[3]);
  const padStart = await padHeight();
  await inkDrag(await inkAt('#pad-sheet', 0.1, 0.05), await inkAt('#pad-sheet', 0.6, 0.07));
  check('the pad takes ink without the pen out on the pages', (await pathsIn(padLayer)) === 1);
  const padView = await page.locator('#pad-scroll').boundingBox();
  const padSheet = await page.locator('#pad-sheet').boundingBox();
  const padLow = Math.min(padView.y + padView.height, padSheet.y + padSheet.height) - 30;
  await inkDrag([padSheet.x + 40, padLow], [padSheet.x + 200, padLow]);
  check('the pad grows as you write near its end', (await padHeight()) > padStart, `${padStart} -> ${await padHeight()}`);
  check('the pad saves as page 0', await inkSaved() && (await strokesOn(0)).length === 2);

  page.once('dialog', (dlg) => dlg.accept());
  await page.locator('#pad-clear').click();
  check('Clear empties the pad', (await pathsIn(padLayer)) === 0);
  await page.locator('#draw-undo').click();
  check('and undo brings it all back', (await pathsIn(padLayer)) === 2);

  await page.locator('#history-btn').click();
  const historyGap = await page.evaluate(() => innerWidth - document.getElementById('history').getBoundingClientRect().right);
  check('drawers move aside for the pad', historyGap > 300, `${Math.round(historyGap)}px from the edge`);
  await page.locator('#history-close').click();

  await inkSaved();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction((s) => document.querySelectorAll(`${s} path`).length === 2, padLayer, { timeout: 8000 }).catch(() => {});
  check('the pad stays open, notes and all, across a reload',
    await page.locator('#pad').isVisible() && (await pathsIn(padLayer)) === 2);
  await page.keyboard.press('n');
  check('n closes it again', await page.locator('#pad').isHidden() && await page.locator('#draw-bar').isHidden());
  await page.evaluate(() => { for (const key of ['spr:ink', 'spr:pad']) localStorage.removeItem(key); });

  await fetch(`${BASE}/api/documents/${ldoc.id}/ink/1`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ strokes: [aStroke] }),
  });
  await fetch(`${BASE}/api/documents/${ldoc.id}`, { method: 'DELETE' });
  const ldocAgain = await (await fetch(`${BASE}/api/documents`, { method: 'POST', body: lform })).json();
  check('removing a book removes its ink',
    (await (await fetch(`${BASE}/api/documents/${ldocAgain.id}/ink`)).json()).length === 0);

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
