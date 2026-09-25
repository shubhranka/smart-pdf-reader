import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PDF_DIR } from '../config.js';
import { pageText } from '../db.js';
import { ExplainError } from '../errors.js';

/**
 * Text for a range of pages, extracted server-side and cached per page.
 *
 * The browser captures page text in its render loop, but only for pages it has
 * actually drawn — type a page number and that page's text was never seen. A recap
 * spans pages you scrolled past, so it has to come from here instead.
 */

/** Extracting the same document twice at once should open the PDF once. */
const inFlight = new Map();

/**
 * pdf.js emits text in small pieces with explicit space items between words, plus a
 * `hasEOL` flag at the end of each drawn line. Concatenating with no separator is what
 * reproduces the original prose — joining with a space (which the browser does) puts
 * spaces inside words that were split across pieces.
 */
function pageLines(items) {
  const lines = [];
  let line = '';

  for (const item of items) {
    if (typeof item.str !== 'string') continue; // marked-content items carry no text
    line += item.str;
    if (item.hasEOL) { lines.push(line); line = ''; }
  }
  if (line) lines.push(line);

  return lines
    .map((l) => l.replace(/­/g, '').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * Rejoin words broken across a line end. The hyphen a typesetter leaves there is
 * usually U+2010, not ASCII "-", so a naive /-$/ misses almost all of them.
 */
function dehyphenate(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev && /\p{L}[-‐‑]$/u.test(prev) && /^\p{Ll}/u.test(line)) {
      out[out.length - 1] = prev.replace(/[-‐‑]$/u, '') + line;
    } else {
      out.push(line);
    }
  }
  return out;
}

async function extractPages(docId, wanted) {
  const file = path.join(PDF_DIR, `${docId}.pdf`);
  if (!fs.existsSync(file)) throw new ExplainError('That PDF is missing from disk.', 404);

  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let task;
  try {
    // A file URL lets pdf.js stream from disk instead of us holding the whole PDF in
    // memory — noticeably faster to open, and lighter, on a big book.
    task = getDocument({
      url: pathToFileURL(file).href,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: false,
    });
    const doc = await task.promise;

    const rows = [];
    for (const num of wanted) {
      if (num < 1 || num > doc.numPages) continue;
      const page = await doc.getPage(num);
      const content = await page.getTextContent();
      rows.push({ page: num, text: dehyphenate(pageLines(content.items)).join('\n') });
      page.cleanup();
      // pdf.js yields well, but a few hundred pages is still a lot of work to do
      // without letting anything else on the server run.
      await new Promise(setImmediate);
    }

    if (rows.length) pageText.putMany(docId, rows);
    return rows;
  } finally {
    await task?.destroy().catch(() => {});
  }
}

/**
 * Page text for `fromPage..toPage`, extracting whatever is not cached yet.
 * @returns {Promise<{ pages: {page:number, text:string}[], chars: number }>}
 */
export async function pageTextRange(docId, fromPage, toPage) {
  const gaps = pageText.missing(docId, fromPage, toPage);

  if (gaps.length) {
    const key = `${docId}:${gaps[0]}-${gaps[gaps.length - 1]}`;
    const running = inFlight.get(key) ?? extractPages(docId, gaps).finally(() => inFlight.delete(key));
    inFlight.set(key, running);
    await running;
  }

  const pages = pageText.getRange(docId, fromPage, toPage).map(({ page, text }) => ({ page, text }));
  return { pages, chars: pages.reduce((n, p) => n + p.text.length, 0) };
}

/**
 * Drop the running head and foot a book repeats on every page. They are pure token
 * cost and they mislead the model about where sections begin.
 *
 * Counted across the range by shape, with digits normalised, so "96 | Chapter 3" and
 * "97 | Chapter 3" are recognised as the same furniture. Five pages is an absolute
 * threshold rather than a percentage on purpose: a chapter's own footer covers only a
 * few percent of a long book, so a percentage rule would never catch it.
 */
export function stripRunningHeads(pages) {
  if (pages.length < 6) return pages;

  const shape = (line) => line.replace(/\d+/g, '#');
  const tally = new Map();

  for (const { text } of pages) {
    const lines = text.split('\n');
    for (const line of [lines[0], lines[lines.length - 1]]) {
      if (!line || line.length > 100) continue;
      const k = shape(line);
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
  }

  const furniture = new Set([...tally].filter(([, n]) => n >= 5).map(([k]) => k));
  if (!furniture.size) return pages;

  return pages.map(({ page, text }) => {
    const lines = text.split('\n');
    while (lines.length && furniture.has(shape(lines[0]))) lines.shift();
    while (lines.length && furniture.has(shape(lines[lines.length - 1]))) lines.pop();
    return { page, text: lines.join('\n') };
  });
}

/** The prompt's view of a range. Page markers let the model cite pages it can point at. */
export function joinPages(pages) {
  return pages
    .filter((p) => p.text.trim())
    .map((p) => `[p. ${p.page}]\n${p.text}`)
    .join('\n\n');
}

/* ------------------------------- the line cut ------------------------------ */

/**
 * Fold text so the server's string and the browser's can be compared.
 *
 * Three things differ between them: the server joins pieces with nothing while the
 * browser joins with spaces, the browser's selection carries newlines from the <br>
 * pdf.js puts at each line end, and the server has already rejoined hyphenated words
 * the browser still shows broken. The 'tight' pass drops whitespace *and* hyphens,
 * which is what makes a selection spanning a line break match at all.
 */
function fold(text, mode) {
  const map = [];
  let folded = '';
  let atSpace = true;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (mode === 'spaced' && !atSpace) { folded += ' '; map.push(i); atSpace = true; }
      continue;
    }
    if (mode === 'tight' && /[-‐‑­]/.test(ch)) continue;

    let c = ch.toLowerCase();
    if (/[‘’ʼ]/.test(c)) c = "'";
    if (/[“”]/.test(c)) c = '"';
    folded += c;
    map.push(i);
    atSpace = false;
  }
  return { folded, map };
}

function foldNeedle(phrase, mode) {
  return fold(phrase, mode).folded.trim();
}

/**
 * Truncate `text` just after `phrase`, so a recap stops where the reader pointed.
 * Returns the whole text unchanged when the phrase cannot be found — being slightly
 * too generous beats failing the request, and beats cutting in the wrong place.
 */
export function cutAtPhrase(text, phrase) {
  if (!phrase || !phrase.trim()) return { text, matched: false };

  for (const mode of ['spaced', 'tight']) {
    const { folded, map } = fold(text, mode);
    let needle = foldNeedle(phrase, mode);
    if (needle.length < 3) continue;

    let at = folded.indexOf(needle);
    if (at === -1 && needle.length > 60) {
      // The tail is what defines the cut, and a long selection is mangled worst in
      // the middle, so fall back to matching just its end.
      needle = needle.slice(-60);
      at = folded.indexOf(needle);
    }
    if (at === -1) continue;

    const end = map[at + needle.length - 1];
    if (end == null) continue;
    return { text: text.slice(0, end + 1), matched: true };
  }

  return { text, matched: false };
}

/** Identifies a cut in the recaps table. Empty string when the range ends at a page. */
export function cutKey(cutText) {
  const trimmed = (cutText ?? '').trim().replace(/\s+/g, ' ');
  return trimmed ? createHash('sha256').update(trimmed).digest('hex').slice(0, 32) : '';
}
