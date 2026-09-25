import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';

import { PORT, PDF_DIR, PUBLIC_DIR, ROOT, GEMINI_API_KEY, GEMINI_MODEL, IMAGE_USER_AGENT, EXTRA_IMAGE_HOSTS, RECAP_MAX_PAGES } from './config.js';
import { documents, progress, lookups, recaps } from './db.js';
import { explain } from './explain.js';
import { ExplainError } from './gemini.js';
import { generateRecap } from './recap.js';
import { cutKey } from './pagetext.js';
import { inspectPdf } from './pdfinfo.js';
import { findImage, ALLOWED_IMAGE_HOSTS } from './images.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

const upload = multer({
  storage: multer.diskStorage({
    destination: PDF_DIR,
    filename: (_req, _file, cb) => cb(null, `upload-${crypto.randomUUID()}.part`),
  }),
  limits: { fileSize: 512 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf');
    cb(ok ? null : new Error('Only PDF files are accepted.'), ok);
  },
});

const sha256File = (filePath) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex').slice(0, 32)));
  });

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Multer mangles UTF-8 filenames as latin1; recover them so titles aren't garbled.
const decodeName = (name) => Buffer.from(name, 'latin1').toString('utf8');

/* ---------------------------------- API ---------------------------------- */

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, geminiConfigured: Boolean(GEMINI_API_KEY), model: GEMINI_MODEL });
});

app.get('/api/documents', (_req, res) => {
  res.json(documents.list());
});

app.post('/api/documents', upload.single('pdf'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const tempPath = req.file.path;
  // Hash as the id: re-uploading the same PDF reopens it instead of duplicating it.
  const id = await sha256File(tempPath);
  const finalPath = path.join(PDF_DIR, `${id}.pdf`);

  if (fs.existsSync(finalPath)) {
    await fsp.unlink(tempPath);
  } else {
    await fsp.rename(tempPath, finalPath);
  }

  const originalName = decodeName(req.file.originalname);
  const fallbackTitle = originalName.replace(/\.pdf$/i, '');
  const existing = documents.get(id);
  const info = existing?.pages
    ? { pages: existing.pages, title: existing.title }
    : await inspectPdf(finalPath, fallbackTitle);

  const doc = documents.insert({
    id,
    filename: originalName,
    title: info.title,
    pages: info.pages,
    size: req.file.size,
  });

  res.status(existing ? 200 : 201).json({ ...doc, alreadyExisted: Boolean(existing) });
}));

app.get('/api/documents/:id', (req, res) => {
  const doc = documents.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  res.json({ ...doc, progress: progress.get(req.params.id) });
});

app.get('/api/documents/:id/file', (req, res) => {
  const doc = documents.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const filePath = path.join(PDF_DIR, `${req.params.id}.pdf`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'PDF file is missing from disk.' });

  res.type('application/pdf');
  res.sendFile(filePath);
});

app.delete('/api/documents/:id', asyncRoute(async (req, res) => {
  const doc = documents.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  documents.remove(req.params.id);
  await fsp.unlink(path.join(PDF_DIR, `${req.params.id}.pdf`)).catch(() => {});
  res.json({ ok: true });
}));

app.get('/api/documents/:id/progress', (req, res) => {
  if (!documents.get(req.params.id)) return res.status(404).json({ error: 'Document not found.' });
  res.json(progress.get(req.params.id) ?? { page: 1, offset_pct: 0, updated_at: null });
});

app.put('/api/documents/:id/progress', (req, res) => {
  const doc = documents.get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const page = Number.parseInt(req.body?.page, 10);
  if (!Number.isFinite(page) || page < 1) return res.status(400).json({ error: '`page` must be a positive integer.' });

  const rawOffset = Number(req.body?.offsetPct);
  const offsetPct = Number.isFinite(rawOffset) ? Math.min(Math.max(rawOffset, 0), 1) : 0;
  const clampedPage = doc.pages > 0 ? Math.min(page, doc.pages) : page;

  res.json(progress.save(req.params.id, clampedPage, offsetPct));
});

// sendBeacon posts a Blob, so this mirrors the PUT above on a POST route.
app.post('/api/documents/:id/progress-beacon', express.text({ type: '*/*' }), (req, res) => {
  const doc = documents.get(req.params.id);
  if (!doc) return res.status(204).end();

  // express.json() may already have parsed it; a text/plain beacon arrives as a string.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  const page = Number.parseInt(body.page, 10);
  if (Number.isFinite(page) && page >= 1) {
    const rawOffset = Number(body.offsetPct);
    const offsetPct = Number.isFinite(rawOffset) ? Math.min(Math.max(rawOffset, 0), 1) : 0;
    progress.save(req.params.id, doc.pages > 0 ? Math.min(page, doc.pages) : page, offsetPct);
  }
  res.status(204).end();
});

app.get('/api/documents/:id/lookups', (req, res) => {
  res.json(lookups.listByDoc(req.params.id));
});

app.delete('/api/documents/:id/lookups', (req, res) => {
  res.json({ removed: lookups.removeAllForDoc(req.params.id) });
});

app.delete('/api/lookups/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Not a lookup id.' });
  if (!lookups.remove(id)) return res.status(404).json({ error: 'That lookup is already gone.' });
  res.json({ ok: true });
});

app.post('/api/explain', asyncRoute(async (req, res) => {
  const { docId, page, selection, context } = req.body ?? {};
  if (typeof selection !== 'string' || !selection.trim()) {
    return res.status(400).json({ error: 'Nothing was selected.' });
  }
  const result = await explain({ selection, context: typeof context === 'string' ? context : '' });

  const pageNo = Number.parseInt(page, 10) || 1;
  const term = selection.trim().replace(/\s+/g, ' ');

  if (docId && documents.get(docId) && !lookups.exists(docId, pageNo, term)) {
    lookups.insert({ docId, page: pageNo, selection: term, kind: result.kind, result });
  }

  res.json(result);
}));

/* ---------------------------------- recap --------------------------------- */

// One recap per document at a time: there is a single panel, so an older result would
// only be thrown away. Starting a new one stops the old one paying for calls.
const runningRecaps = new Map();

app.post('/api/recap', asyncRoute(async (req, res) => {
  const { docId, fromPage, toPage, cutText, refresh } = req.body ?? {};
  const doc = documents.get(docId);
  if (!doc) return res.status(404).json({ error: 'Document not found.' });

  const last = doc.pages > 0 ? doc.pages : Number.MAX_SAFE_INTEGER;
  const to = Math.min(Math.max(Number.parseInt(toPage, 10) || 1, 1), last);
  const from = Math.min(Math.max(Number.parseInt(fromPage, 10) || 1, 1), to);

  if (to - from + 1 > RECAP_MAX_PAGES) {
    return res.status(400).json({
      error: `A recap covers at most ${RECAP_MAX_PAGES} pages at a time.`,
      hint: 'Set a "from page" to narrow the range.',
    });
  }

  const cut = typeof cutText === 'string' ? cutText.trim().slice(0, 400) : '';
  const hash = cutKey(cut);

  if (!refresh) {
    const saved = recaps.find(doc.id, from, to, hash);
    if (saved) return res.json({ ...saved, cached: true });
  }

  runningRecaps.get(doc.id)?.abort(new Error('superseded'));
  const controller = new AbortController();
  runningRecaps.set(doc.id, controller);

  try {
    const out = await generateRecap({
      doc, fromPage: from, toPage: to, cutText: cut, signal: controller.signal,
    });
    const row = recaps.upsert({
      docId: doc.id, fromPage: from, toPage: to,
      cutText: cut, cutHash: hash, cutApplied: out.cutApplied,
      chars: out.chars, chunks: out.chunks, result: out.result,
    });
    res.json({ ...row, cached: false });
  } finally {
    if (runningRecaps.get(doc.id) === controller) runningRecaps.delete(doc.id);
  }
}));

app.get('/api/documents/:id/recaps', (req, res) => {
  res.json(recaps.listByDoc(req.params.id));
});

app.delete('/api/documents/:id/recaps', (req, res) => {
  res.json({ removed: recaps.removeAllForDoc(req.params.id) });
});

app.delete('/api/recaps/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Not a recap id.' });
  if (!recaps.remove(id)) return res.status(404).json({ error: 'That recap is already gone.' });
  res.json({ ok: true });
});

/**
 * Pictures are fetched separately from the explanation so a slow encyclopaedia never
 * holds up the meaning, and proxied rather than hotlinked so the browser never talks
 * to a third party about what you are reading.
 */
app.get('/api/image', asyncRoute(async (req, res) => {
  const image = await findImage(req.query.q);
  if (!image) return res.json({ image: null });

  res.json({
    image: { ...image, url: `/api/image/file?src=${encodeURIComponent(image.url)}` },
  });
}));

app.get('/api/image/file', asyncRoute(async (req, res) => {
  let target;
  try {
    target = new URL(String(req.query.src));
  } catch {
    return res.status(400).json({ error: 'Not a URL.' });
  }

  // Only the hosts our own sources hand back, so this cannot be pointed anywhere else.
  // Plain http is permitted solely for hosts an operator listed in EXTRA_IMAGE_HOSTS,
  // which is how the test suite points this at a local stub.
  const protocolOk = target.protocol === 'https:'
    || (target.protocol === 'http:' && EXTRA_IMAGE_HOSTS.includes(target.hostname));
  if (!protocolOk || !ALLOWED_IMAGE_HOSTS.has(target.hostname)) {
    return res.status(403).json({ error: 'That image host is not allowed.' });
  }

  const upstream = await fetch(target, {
    headers: { 'user-agent': IMAGE_USER_AGENT, accept: 'image/*' },
    signal: AbortSignal.timeout(10_000),
  });
  const type = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !type.startsWith('image/')) {
    return res.status(502).json({ error: 'Could not fetch that image.' });
  }

  res.type(type);
  res.set('cache-control', 'public, max-age=604800, immutable');
  res.send(Buffer.from(await upstream.arrayBuffer()));
}));

/* -------------------------------- static --------------------------------- */

app.use('/vendor/pdfjs', express.static(path.join(ROOT, 'node_modules/pdfjs-dist')));
app.use('/vendor/roughjs', express.static(path.join(ROOT, 'node_modules/roughjs')));
app.use(express.static(PUBLIC_DIR));

/* ------------------------------ error handling ---------------------------- */

app.use((err, _req, res, _next) => {
  if (err instanceof ExplainError) {
    return res.status(err.status).json({ error: err.message, hint: err.hint });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That PDF is larger than the 512 MB limit.' });
  }
  console.error(err);
  res.status(500).json({ error: err?.message || 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`\n  Smart PDF Reader  ->  http://localhost:${PORT}`);
  console.log(GEMINI_API_KEY
    ? `  Gemini: ${GEMINI_MODEL}\n`
    : `  Gemini: not configured — copy .env.example to .env and add GEMINI_API_KEY\n`);
});
