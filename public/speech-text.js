/*
 * What a voice should say for a stretch of a page. A PDF's text layer is written for
 * eyes, not ears: it has page numbers, footnote marks, words broken across lines, and
 * headings with no full stop that a voice would run straight into the paragraph below.
 * This turns the words the tracker measured into sentences worth listening to, while
 * remembering which word on the page each spoken word came from so the pill can follow.
 *
 * Pure functions over plain word boxes, so they are testable away from the browser.
 */

export const SENTENCE_END = /[.!?:]["'”’)\]]*$/;
const CLAUSE_END = /[,;—–]["'”’)\]]*$/;
const ABBREVIATION = /^(?:e\.g|i\.e|etc|al|cf|fig|figs|eq|eqs|vs|dr|mr|mrs|ms|prof|no|nos|pp?|vol|ch|sec|approx|st|jr|sr|inc|ltd|co|ca|resp)\.$/i;
const INITIAL = /^\p{Lu}\.$/u;
const PAGE_NUMBER = /^(?:page\s+)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:of|\/)\s*\d{1,4})?$/i;
const FOOTNOTE_MARK = /^(?:[\d,–-]{1,7}|[*†‡§¶]+)$/;
const BULLET = /^[•▪◦●■□▫‣⁃∙·*]$/;
const DASH = /^[–—-]$/;
const URL = /^(?:https?:\/\/|www\.)\S+$/i;
// A citation spread over several words: "[7," "8," "9]."
const CITE_OPEN = /^\[\d[\d,–-]*$/;
const CITE_MIDDLE = /^[\d,–-]+$/;
const CITE_CLOSE = /^[\d,–-]*\]\p{P}*$/u;
const MAX_CHARS = 500;          // the server takes 600; leave room for the odd long word
const EDGE = 0.08;              // top and bottom of a page where running heads live

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** A word's text as it should be said, before anything is known about its neighbours. */
function clean(text) {
  let s = text.normalize('NFKC').replace(/[­​-‍﻿]/g, '');
  s = s.replace(/\[\d[\d,\s–-]*\]/g, '');                    // citations: [12], [7,8,9], [3–5]
  s = s.replace(/(\d)–(?=\d)/g, '$1 to ');                   // a range: "pp. 3–5", "1990–1995"
  s = s.replace(/(\p{L}[.,;:!?"'”’)\]]+)\d{1,3}$/u, '$1');   // a footnote mark glued on: "cell.12"
  if (URL.test(s)) return 'link';
  if (s === '&') return 'and';
  return s;
}

const analysed = new WeakMap();

/**
 * Per word: what to say (null to skip it), whether it joins the next word with no
 * space (a hyphenated line break), and whether a heading or paragraph ends after it.
 * Cached per page, keyed by the words array the tracker keeps for that page.
 */
export function analysePage(words, height) {
  const known = analysed.get(words);
  if (known) return known;

  const n = words.length;
  const say = new Array(n).fill(null);
  const joinNext = new Array(n).fill(false);
  const blockAfter = new Array(n).fill(false);

  const lines = [];
  for (let i = 0; i < n; i++) {
    const w = words[i];
    let line = lines[lines.length - 1];
    if (!line || line.id !== w.line) {
      line = { id: w.line, first: i, last: i, top: w.y, bottom: w.y + w.h, hs: [], mids: [] };
      lines.push(line);
    }
    line.last = i;
    line.top = Math.min(line.top, w.y);
    line.bottom = Math.max(line.bottom, w.y + w.h);
    line.hs.push(w.h);
    line.mids.push(w.y + w.h / 2);
  }
  for (const line of lines) {
    line.h = median(line.hs);
    line.mid = median(line.mids);
  }

  // Citations aren't read. One spread over several words is found first, and its closing
  // word keeps only what follows the bracket — the full stop or comma still counts.
  const override = new Map();
  for (let i = 0; i < n; i++) {
    if (!CITE_OPEN.test(words[i].text)) continue;
    for (let j = i + 1; j < Math.min(n, i + 12); j++) {
      const t = words[j].text;
      if (CITE_MIDDLE.test(t)) continue;
      if (CITE_CLOSE.test(t)) {
        for (let k = i; k < j; k++) override.set(k, '');
        override.set(j, t.slice(t.lastIndexOf(']') + 1));
        i = j;
      }
      break;
    }
  }

  // How far apart lines usually are, in line heights; a much bigger step is a new block.
  const steps = [];
  for (let k = 1; k < lines.length; k++) {
    const step = (lines[k].top - lines[k - 1].top) / (lines[k - 1].h || 1);
    if (step > 0) steps.push(step);
  }
  const usual = median(steps) || 1.3;

  let prevSaid = -1;
  lines.forEach((line, k) => {
    const texts = [];
    for (let i = line.first; i <= line.last; i++) texts.push(words[i].text);
    const atEdge = line.top < height * EDGE || line.bottom > height * (1 - EDGE);
    if (atEdge && PAGE_NUMBER.test(texts.join(' ').trim())) return; // the page number

    let lastSaid = -1;
    for (let i = line.first; i <= line.last; i++) {
      const w = words[i];
      const s = override.has(i) ? override.get(i) : clean(w.text);
      if (!s || BULLET.test(s)) continue;
      const raised = w.h < line.h * 0.75 && w.y + w.h / 2 < line.mid - line.h * 0.15;
      if (raised && FOOTNOTE_MARK.test(s)) continue;
      if (DASH.test(s)) {
        // A dash between clauses is a pause, not a word.
        if (prevSaid >= 0 && !/\p{P}$/u.test(say[prevSaid])) say[prevSaid] += ',';
        continue;
      }
      if (/^\p{P}+$/u.test(s)) {
        // Punctuation on its own — what a dropped citation leaves — belongs to the word before.
        if (prevSaid >= 0 && !say[prevSaid].endsWith(s)) say[prevSaid] += s;
        continue;
      }
      say[i] = s;
      lastSaid = i;
      prevSaid = i;
    }

    // A word broken over the line end: "mito-" + "chondria". The hyphen there is usually
    // U+2010 rather than ASCII.
    const tail = say[line.last];
    const next = words[line.last + 1];
    if (tail && next && /\p{L}[-\u2010]$/u.test(tail) && /^\p{Ll}/u.test(clean(next.text))) {
      say[line.last] = tail.slice(0, -1);
      joinNext[line.last] = true;
    }

    // A heading, or the end of a paragraph: a big step down, or a change of type size.
    const below = lines[k + 1];
    if (below && lastSaid >= 0 && !joinNext[line.last]) {
      const step = (below.top - line.top) / (line.h || 1);
      const resized = Math.abs(below.h - line.h) / Math.max(below.h, line.h) > 0.15;
      if ((below.top > line.top && step > usual * 1.4) || resized) {
        blockAfter[lastSaid] = true;
        // Said without a full stop, a heading runs into what follows it.
        if (!/[\p{P}]$/u.test(say[lastSaid])) say[lastSaid] += '.';
      }
    }
  });

  const result = { say, joinNext, blockAfter };
  analysed.set(words, result);
  return result;
}

const isSentenceEnd = (s) => {
  if (!SENTENCE_END.test(s)) return false;
  const bare = s.replace(/^[("'“‘[]+/, '');
  return !ABBREVIATION.test(bare) && !INITIAL.test(bare);
};

/**
 * The next thing to say, starting at `from`: a sentence, or a heading, or — for one
 * that runs long — as far as its last comma. It carries on over a page turn, since a
 * sentence does.
 *
 * @param {(page:number) => Promise<{words:object[], height:number}|null>} getPage
 * @param {{page:number, i:number}} from
 * @param {{maxWords?:number, softWords?:number}} opts
 *   maxWords  never more than this many words
 *   softWords once this many are in, stop at the next comma too (a quick first chunk)
 * @returns {Promise<null | {
 *   text: string, words: {page:number, i:number}[], starts: number[],
 *   weights: number[], pauses: number[], clauseAfter: boolean[],
 *   pauseAfter: number, next: {page:number, i:number} | null }>}
 */
export async function buildChunk(getPage, from, { maxWords = 40, softWords = Infinity } = {}) {
  let pos = { page: from.page, i: from.i };
  let pg = await getPage(pos.page);
  let a = pg && analysePage(pg.words, pg.height);
  let emptyPages = 0;
  let chars = 0;
  let ending = 'cut';
  const pieces = [];

  while (pg) {
    if (pos.i >= pg.words.length) {
      pos = { page: pos.page + 1, i: 0 };
      pg = await getPage(pos.page);
      if (!pg) break;
      a = analysePage(pg.words, pg.height);
      // A picture-only page ends a sentence in progress; a fresh one looks past a few.
      if (!pg.words.length && (pieces.length || ++emptyPages > 5)) break;
      continue;
    }
    const i = pos.i;
    pos = { page: pos.page, i: i + 1 };
    const text = a.say[i];
    if (!text) continue;

    const piece = { page: pos.page, i, text, join: a.joinNext[i] };
    piece.sentence = isSentenceEnd(text);
    piece.block = a.blockAfter[i];
    piece.clause = !piece.sentence && !piece.block && CLAUSE_END.test(text);
    pieces.push(piece);
    chars += text.length + 1;

    if (piece.block) { ending = 'block'; break; }
    if (piece.sentence) { ending = 'sentence'; break; }
    if (piece.clause && pieces.length >= softWords) { ending = 'clause'; break; }
    if (pieces.length >= maxWords || chars >= MAX_CHARS) {
      // Too long to say in one go: back up to its last comma, if that keeps enough.
      for (let q = pieces.length - 2; q >= 7; q--) {
        if (!pieces[q].clause) continue;
        const [first] = pieces.splice(q + 1);
        pos = { page: first.page, i: first.i };
        ending = 'clause';
        break;
      }
      break;
    }
  }
  if (!pieces.length) return null;

  let text = '';
  const starts = [], weights = [], pauses = [], clauseAfter = [];
  pieces.forEach((p, k) => {
    if (k > 0 && !pieces[k - 1].join) text += ' ';
    starts.push(text.length);
    text += p.text;
    // Rough time to say it: letters, with numbers taking longer than they look.
    const letters = p.text.replace(/[^\p{L}]/gu, '').length;
    const digits = p.text.replace(/[^\p{N}]/gu, '').length;
    weights.push(1 + letters + digits * 2.5);
    const last = k === pieces.length - 1;
    pauses.push(last ? 0 : p.sentence || p.block ? 4 : p.clause || /[:;]$/.test(p.text) ? 2.5 : 0);
    clauseAfter.push(!last && (p.sentence || p.block || p.clause));
  });

  return {
    text,
    words: pieces.map((p) => ({ page: p.page, i: p.i })),
    starts,
    weights,
    pauses,
    clauseAfter,
    // Seconds of quiet before the next chunk: a breath after a heading, less after a
    // sentence, hardly any where a long one was split.
    pauseAfter: { block: 0.55, sentence: 0.32, clause: 0.16, cut: 0.08 }[ending],
    next: pg ? pos : null,
  };
}
