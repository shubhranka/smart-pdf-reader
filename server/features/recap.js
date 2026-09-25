import { createHash } from 'node:crypto';
import {
  RECAP_BUDGET_CHARS, RECAP_CHUNK_CHARS,
  RECAP_MAX_CHUNKS, RECAP_CONCURRENCY,
} from '../config.js';

import { recapChunks } from '../db.js';
import { ExplainError, requireKey, callModel, MODEL } from '../llm/index.js';
import { pageTextRange, stripRunningHeads, joinPages, cutAtPhrase } from '../pdf/pagetext.js';

/**
 * "Catch me up": a brief summary of what a stretch of a document covered.
 *
 * Short ranges are one call. Long ones are summarised in chunks and the notes combined,
 * because a single call over a hundred pages goes shallow and front-loaded, and because
 * chunk notes can be cached and reused when the reader gets further into the book.
 */

// Bump when a prompt changes, so cached notes from the old wording are not reused.
const MAP_PROMPT_VERSION = 'map-v1';
const VERBATIM_TAIL_CHARS = 6_000;

/* --------------------------------- schemas -------------------------------- */

const DIAGRAM_SCHEMA = {
  type: 'object',
  description: 'A small picture of how the parts relate. Omit rather than force one.',
  properties: {
    kind: {
      type: 'string',
      enum: ['flow', 'map'],
      description: '"flow" for a progression — an argument, a method, a sequence of events. '
        + '"map" for a set of ideas that relate to each other.',
    },
    caption: { type: 'string', description: 'One short line naming what the picture shows.' },
    nodes: {
      type: 'array',
      description: 'Three to five. Fewer and clearer beats more.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short slug, unique within this diagram.' },
          label: { type: 'string', description: 'At most five words.' },
          page: { type: 'integer', description: 'The page this was introduced on, when the text makes it clear. 0 if not.' },
        },
        required: ['id', 'label'],
        additionalProperties: false,
      },
    },
    edges: {
      type: 'array',
      description: 'How the nodes connect. At most twelve.',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string', description: 'The relationship, at most three words. Never "related to".' },
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
    },
  },
  required: ['kind', 'nodes', 'edges'],
  additionalProperties: false,
};

const RECAP_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '3-7 words naming what this stretch covered. Used as the label in the saved list.' },
    summary: {
      type: 'string',
      description: 'One short paragraph, three to five sentences: what was covered, in order, ending on where the reader stopped.',
    },
    keyPoints: {
      type: 'array',
      description: 'Up to four things worth remembering, each a single short line.',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string' },
          page: { type: 'integer', description: 'Where it was made. 0 when unclear.' },
        },
        required: ['point'],
        additionalProperties: false,
      },
    },
    diagram: DIAGRAM_SCHEMA,
  },
  required: ['title', 'summary', 'keyPoints', 'diagram'],
  additionalProperties: false,
};

const CHUNK_SCHEMA = {
  type: 'object',
  properties: {
    pageRange: { type: 'string' },
    narrative: { type: 'string', description: 'What this stretch covered, in its own order. Dense, factual, no addressing the reader.' },
    points: { type: 'array', description: 'Up to six.', items: { type: 'string' } },
    terms: {
      type: 'array',
      description: 'Up to five defined terms, verbatim.',
      items: {
        type: 'object',
        properties: { term: { type: 'string' }, meaning: { type: 'string' } },
        required: ['term', 'meaning'],
        additionalProperties: false,
      },
    },
    entities: {
      type: 'array',
      description: 'Proper nouns exactly as written: systems, people, datasets, papers.',
      items: { type: 'string' },
    },
    threads: { type: 'array', description: 'Questions raised here and not yet answered.', items: { type: 'string' } },
    endsWith: { type: 'string', description: 'One sentence on exactly where this stretch stops.' },
  },
  required: ['pageRange', 'narrative', 'points'],
  additionalProperties: false,
};

/* --------------------------------- prompts -------------------------------- */

const SYSTEM_RECAP = `You give a reader a brief summary of a document they have been reading, so they can recall what has been covered at a glance. Brevity is the point: they want a reminder, not a retelling.

Rules:
- Write to them, in the second person, in plain language. No preamble, no "this document discusses".
- "summary" is one short paragraph of three to five sentences. Follow the document's order and end on where the reader stopped.
- "keyPoints" are at most four, each one short line. Only what is genuinely worth remembering; fewer is fine.
- Leave out examples, asides and detail. If a sentence would not be missed, cut it.
- Cover only the text you are given. Never fill a gap from your own knowledge.
- If the text is garbled by PDF extraction, say so in a few words and work with what is legible.

The diagram:
- Draw the shape of what was covered — how the parts relate, not a list of them redrawn as boxes.
- "flow" when the stretch is a progression; "map" when it is a set of ideas that relate.
- Label every edge with the actual relationship. Never "related to", never an empty label.
- Three to five nodes. Every node must be reachable by some edge.
- Give a node its page number when the text makes clear where it was introduced.`;

const SYSTEM_CHUNK = `You are taking notes on one stretch of a longer document, so that a summary can later be written from your notes alone. Whoever writes it will not see this text.

Rules:
- Be dense and factual, and keep the document's own order.
- Keep every proper noun, system name, dataset, person and defined term exactly as written — a name you paraphrase away is lost for good.
- Do not address a reader, do not editorialise, and do not add anything the text does not say.
- Do not conclude or wrap up. This is the middle of something.
- If the text is garbled by PDF extraction, say so in "narrative" rather than inventing content.`;

const REDUCE_PREAMBLE = `You are working from notes on consecutive stretches of one document, in reading order. These are notes, not the document. Condense them into a brief summary that spans the whole range — do not favour the opening stretches.

Weight the final stretch most heavily at the end of "summary": that is where the reader actually is. Deduplicate — a point made in three stretches is one point, stated once, citing the earliest page. Keep only the few things that matter across the whole range. Never present the recap stretch by stretch, and never mention that notes were used.`;

/* -------------------------------- utilities ------------------------------- */

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Run `fn` over `items`, at most `limit` at a time, keeping input order in the result. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Pack whole pages into chunks, always starting from the first page given.
 *
 * Callers pass the document from page 1 so boundaries are a property of the document
 * rather than of the request — that is what lets a longer recap reuse a shorter one's
 * chunks instead of re-summarising the same pages under different boundaries.
 */
function planChunks(pages, chunkChars) {
  const chunks = [];
  let current = null;

  for (const page of pages) {
    if (current && current.chars + page.text.length > chunkChars) current = null;
    if (!current) {
      current = { from: page.page, to: page.page, chars: 0, pages: [] };
      chunks.push(current);
    }
    current.pages.push(page);
    current.chars += page.text.length;
    current.to = page.page;
  }
  return chunks;
}

/* ------------------------------ normalisation ----------------------------- */

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const page = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/**
 * The model occasionally points an edge at a node it did not define, or repeats an id.
 * Drop what does not hold together rather than handing the renderer a broken graph.
 */
function normaliseDiagram(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const seen = new Set();
  const nodes = [];
  for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
    const id = str(n?.id);
    const label = str(n?.label);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, label: label.slice(0, 60), page: page(n?.page) });
    if (nodes.length === 6) break;
  }
  if (nodes.length < 2) return null;

  const edges = [];
  for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
    const from = str(e?.from);
    const to = str(e?.to);
    if (!seen.has(from) || !seen.has(to) || from === to) continue;
    const label = str(e?.label);
    edges.push({ from, to, label: /^related to$/i.test(label) ? '' : label.slice(0, 30) });
    if (edges.length === 12) break;
  }
  if (!edges.length) return null;

  return {
    kind: raw.kind === 'map' ? 'map' : 'flow',
    caption: str(raw.caption).slice(0, 140),
    nodes,
    edges,
  };
}

function normaliseRecap(raw, { fromPage, toPage }) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    title: str(raw?.title) || `Pages ${fromPage}–${toPage}`,
    summary: str(raw?.summary),
    keyPoints: arr(raw?.keyPoints)
      .map((p) => ({ point: str(p?.point), page: page(p?.page) }))
      .filter((p) => p.point).slice(0, 4),
    diagram: normaliseDiagram(raw?.diagram),
  };
}

/* --------------------------------- calls ---------------------------------- */

function rangeHeader(doc, fromPage, toPage, cut) {
  const stop = cut.matched ? `\nIt stops at the line they picked: "${cut.phrase}".` : '';
  return `Document: "${doc.title}" (${doc.pages} pages). This recap covers pages ${fromPage}–${toPage}.${stop}`;
}

async function callRecap(input, signal) {
  const { json, text } = await callModel({
    systemInstruction: SYSTEM_RECAP,
    input,
    schema: RECAP_SCHEMA,
    // Selecting and ordering across tens of thousands of words is what deliberation
    // actually helps with — unlike a definition, which is recall.
    generationConfig: { temperature: 0.3, thinking_level: 'low', max_output_tokens: 2048 },
    timeoutMs: 120_000,
    signal,
  });
  if (json) return json;
  throw new ExplainError(`The model did not return a usable recap.${text ? '' : ' It returned nothing.'}`, 502);
}

async function summariseChunk(chunk, doc, signal) {
  const body = joinPages(chunk.pages);
  const key = sha([MAP_PROMPT_VERSION, MODEL, doc.id, chunk.from, chunk.to, sha(body)].join('\u0000'));

  const hit = recapChunks.get(key);
  if (hit) return { ...hit, cached: true };

  const { json, text } = await callModel({
    systemInstruction: SYSTEM_CHUNK,
    input: `Take notes on pages ${chunk.from}–${chunk.to} of "${doc.title}".\n\n"""\n${body}\n"""`,
    schema: CHUNK_SCHEMA,
    // Condensing is near-extractive, and this cost is multiplied by every chunk —
    // the worst place in the feature to pay for thinking.
    generationConfig: { temperature: 0.2, thinking_level: 'minimal', max_output_tokens: 3072 },
    timeoutMs: 90_000,
    signal,
  });

  const note = json ?? { pageRange: `${chunk.from}-${chunk.to}`, narrative: text, points: [] };
  recapChunks.set(key, { docId: doc.id, fromPage: chunk.from, toPage: chunk.to, summary: note });
  return { ...note, cached: false };
}

/* ------------------------------- entry point ------------------------------ */

/**
 * @returns {Promise<{result: object, cutApplied: boolean, chars: number, chunks: number}>}
 */
export async function generateRecap({ doc, fromPage, toPage, cutText = '', signal }) {
  requireKey();

  const { pages } = await pageTextRange(doc.id, fromPage, toPage);
  if (!pages.length) throw new ExplainError('Those pages are not in this document.', 400);

  // Trim the last page at the line the reader picked, before anything is measured.
  let cut = { matched: false, phrase: cutText };
  if (cutText) {
    const last = pages[pages.length - 1];
    const { text, matched } = cutAtPhrase(last.text, cutText);
    pages[pages.length - 1] = { ...last, text };
    cut = { matched, phrase: cutText };
  }

  const clean = stripRunningHeads(pages);
  const chars = clean.reduce((n, p) => n + p.text.length, 0);

  if (chars < 200) {
    throw new ExplainError(
      "There's no text in those pages to recap.",
      422,
      'They look like scanned images — an OCR pass would make them readable.'
    );
  }

  const header = rangeHeader(doc, fromPage, toPage, cut);
  const done = (raw, chunks) => ({
    result: normaliseRecap(raw, { fromPage, toPage }),
    cutApplied: cut.matched,
    chars,
    chunks,
  });

  /* ---- short enough to read in one go ---- */
  if (chars <= RECAP_BUDGET_CHARS) {
    const input = `Catch the reader up on what they have read so far.\n\n${header}\n\n"""\n${joinPages(clean)}\n"""`;
    return done(await callRecap(input, signal), 1);
  }

  /* ---- too long: summarise in stretches, then combine the notes ---- */

  // Chunks are packed from page 1 of the document, not from fromPage, so that reading
  // further reuses the notes already paid for.
  const { pages: all } = await pageTextRange(doc.id, 1, toPage);
  const allClean = stripRunningHeads(all);

  // Deliberately a constant, not something derived from the range asked for. Sizing
  // chunks by the total would shift every boundary as the reader got further into the
  // book, which is exactly what the chunk cache exists to avoid. What bounds the cost
  // here is RECAP_MAX_PAGES; RECAP_MAX_CHUNKS is a guard against pathological pages.
  const wanted = planChunks(allClean, RECAP_CHUNK_CHARS)
    .filter((c) => c.to >= fromPage && c.from <= toPage);

  if (wanted.length > RECAP_MAX_CHUNKS) {
    throw new ExplainError(
      'That range is too large to recap in one go.',
      400,
      'Set a "from page" to narrow it — the last thirty or forty pages is usually what you want.'
    );
  }

  const notes = await mapLimit(wanted, RECAP_CONCURRENCY, (chunk) => summariseChunk(chunk, doc, signal));

  const noteBlocks = notes
    .map((n, i) => `--- pages ${wanted[i].from}–${wanted[i].to} ---\n${JSON.stringify(n, null, 1)}`)
    .join('\n\n');

  // The last stretch also goes in raw. "Where you are" is the whole point of a recap,
  // and it is exactly what a summary of summaries destroys.
  const tail = joinPages(clean).slice(-VERBATIM_TAIL_CHARS);

  const input = `${REDUCE_PREAMBLE}\n\n${header}\n\nNotes:\n\n${noteBlocks}\n\n`
    + `The most recent pages, in full:\n"""\n${tail}\n"""`;

  return done(await callRecap(input, signal), wanted.length);
}
