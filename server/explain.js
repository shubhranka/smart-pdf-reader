import { createHash } from 'node:crypto';
import { GEMINI_API_KEY, GEMINI_MODEL, GEMINI_API_BASE, GEMINI_API_REVISION } from './config.js';
import { cache } from './db.js';

const MAX_CONTEXT = 4000;
const MAX_SELECTION = 6000;

export class ExplainError extends Error {
  constructor(message, status = 502, hint = '') {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

// Plain JSON Schema — the Interactions API takes it under response_format.schema.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'The term itself, or a 2-5 word title for a passage.' },
    kind: { type: 'string', enum: ['word', 'phrase', 'passage'] },
    meaning: { type: 'string', description: 'Plain-language explanation, 1-3 sentences.' },
    inContext: { type: 'string', description: 'What it means specifically here, given the surrounding text.' },
    details: {
      type: 'array',
      description: 'Up to 4 supporting facts: part of speech, example sentence, synonyms, key terms.',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, value: { type: 'string' } },
        required: ['label', 'value'],
        additionalProperties: false,
      },
    },
  },
  required: ['headline', 'kind', 'meaning', 'inContext'],
  additionalProperties: false,
};

const SYSTEM_INSTRUCTION = `You explain things to someone reading a document. They highlighted some text and want to understand it without leaving the page.

Rules:
- Plain language. No filler, no "this term refers to", no restating the question.
- "meaning" is the general explanation. "inContext" is what it means in THIS document specifically — if the surrounding text makes the sense concrete, say so; if the context adds nothing, say so briefly rather than padding.
- Never invent a definition. If the selection is garbled, mangled by PDF extraction, or too fragmentary to interpret, say that plainly in "meaning".
- Match the reader's level to the document: technical document, technical answer.`;

function classify(selection) {
  const words = selection.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) return 'word';
  if (words.length <= 4) return 'phrase';
  return 'passage';
}

function buildPrompt(selection, context, kind) {
  const task = kind === 'passage'
    ? `Explain this passage. Unpack any jargon in "details" (label = the term, value = its meaning).`
    : `Define this ${kind}. In "details" give part of speech, a short example sentence, and close synonyms where they help.`;

  const contextBlock = context
    ? `\n\nSurrounding text from the page (for context only — do not explain this part):\n"""\n${context.slice(0, MAX_CONTEXT)}\n"""`
    : '\n\n(No surrounding context was available.)';

  return `${task}\n\nHighlighted text:\n"""\n${selection.slice(0, MAX_SELECTION)}\n"""${contextBlock}`;
}

/**
 * An Interaction response carries `steps`, each holding content blocks. Mirror the
 * SDKs' `output_text`: take the trailing run of text blocks, so reasoning or tool
 * blocks earlier in the response are left out.
 */
function outputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text) return payload.output_text;

  const blocks = [];
  for (const step of payload?.steps ?? []) {
    for (const block of step?.content ?? []) blocks.push(block);
  }

  const trailing = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    const isText = block?.type === 'text' && typeof block.text === 'string' && !block.thought;
    if (!isText) break;
    trailing.unshift(block.text);
  }
  return trailing.join('');
}

async function callGemini(prompt) {
  const body = {
    model: GEMINI_MODEL,
    system_instruction: SYSTEM_INSTRUCTION,
    input: prompt,
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: RESPONSE_SCHEMA,
    },
    generation_config: {
      temperature: 0.2,
      // A definition does not need deliberation, and thinking roughly doubles latency.
      thinking_level: 'minimal',
      max_output_tokens: 2048,
    },
    // Nothing to gain from Google retaining these lookups.
    store: false,
  };

  const res = await fetch(`${GEMINI_API_BASE}/interactions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
      'Api-Revision': GEMINI_API_REVISION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    const detail = payload?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401 || (res.status === 400 && /API key not valid/i.test(detail))) {
      throw new ExplainError('Gemini rejected the API key.', 401, 'Check GEMINI_API_KEY in .env');
    }
    if (res.status === 403 && /permission|access/i.test(detail)) {
      throw new ExplainError(`Your key cannot use "${GEMINI_MODEL}".`, 403, 'Pick another GEMINI_MODEL in .env — see https://ai.google.dev/gemini-api/docs/models');
    }
    if (res.status === 404) {
      throw new ExplainError(`Model "${GEMINI_MODEL}" is not available for this key.`, 400, 'Pick a current GEMINI_MODEL in .env — see https://ai.google.dev/gemini-api/docs/models');
    }
    if (res.status === 429) {
      throw new ExplainError('Gemini rate limit hit. Wait a moment and try again.', 429);
    }
    throw new ExplainError(`Gemini error: ${detail}`, 502);
  }

  if (payload?.status === 'failed' || payload?.status === 'cancelled') {
    throw new ExplainError(`Gemini could not finish the request (${payload.status}).`, 502);
  }

  const text = outputText(payload);
  if (!text) {
    const reason = payload?.status || 'no text in response';
    throw new ExplainError(`Gemini returned no explanation (${reason}).`, 502);
  }

  try {
    return JSON.parse(text);
  } catch {
    // Schema mode should prevent this, but never let a parse failure take down the request.
    return { headline: 'Explanation', kind: 'passage', meaning: text, inContext: '', details: [] };
  }
}

export async function explain({ selection, context = '' }) {
  const trimmed = selection.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw new ExplainError('Nothing was selected.', 400);

  if (!GEMINI_API_KEY) {
    throw new ExplainError(
      'No Gemini API key configured.',
      503,
      'Copy .env.example to .env and set GEMINI_API_KEY. Get one at https://aistudio.google.com/apikey'
    );
  }

  const kind = classify(trimmed);
  const contextWindow = context.slice(0, MAX_CONTEXT);
  const key = createHash('sha256').update(`${GEMINI_MODEL}\u0000${trimmed}\u0000${contextWindow}`).digest('hex');

  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const result = await callGemini(buildPrompt(trimmed, contextWindow, kind));
  const normalized = {
    headline: result.headline || trimmed,
    kind: result.kind || kind,
    meaning: result.meaning || '',
    inContext: result.inContext || '',
    details: Array.isArray(result.details) ? result.details.slice(0, 4) : [],
  };

  cache.set(key, normalized);
  return { ...normalized, cached: false };
}
