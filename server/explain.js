import { createHash } from 'node:crypto';
import { GEMINI_MODEL } from './config.js';
import { cache } from './db.js';
import { ExplainError, requireKey, callGemini } from './gemini.js';

// Re-exported so the many places that already import it from here keep working.
export { ExplainError };

const MAX_CONTEXT = 4000;
const MAX_SELECTION = 6000;

// Plain JSON Schema — the Interactions API takes it under response_format.schema.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'The term itself, or a 2-5 word title for a passage.' },
    kind: { type: 'string', enum: ['word', 'phrase', 'passage'] },
    meaning: { type: 'string', description: 'Plain-language explanation, 1-3 sentences.' },
    inContext: { type: 'string', description: 'What it means specifically here, given the surrounding text.' },
    imageQuery: {
      type: 'string',
      description: 'The subject to illustrate, when a picture would genuinely help — a concrete '
        + 'object, organism, structure, device, place, or a concept normally taught with a diagram. '
        + 'Use the common encyclopaedia name for it. Empty string for anything a picture would not '
        + 'clarify: abstract or relational words, grammar terms, verbs, and vague phrases.',
    },
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
  required: ['headline', 'kind', 'meaning', 'inContext', 'imageQuery'],
  additionalProperties: false,
};

const SYSTEM_INSTRUCTION = `You explain things to someone reading a document. They highlighted some text and want to understand it without leaving the page.

Rules:
- Plain language. No filler, no "this term refers to", no restating the question.
- "meaning" is the general explanation. "inContext" is what it means in THIS document specifically — if the surrounding text makes the sense concrete, say so; if the context adds nothing, say so briefly rather than padding.
- Never invent a definition. If the selection is garbled, mangled by PDF extraction, or too fragmentary to interpret, say that plainly in "meaning".
- Match the reader's level to the document: technical document, technical answer.
- "imageQuery" is a search term, not a sentence. Leave it empty unless a picture would
  really tell the reader something the words do not.`;

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

export async function explain({ selection, context = '' }) {
  const trimmed = selection.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw new ExplainError('Nothing was selected.', 400);

  requireKey();

  const kind = classify(trimmed);
  const contextWindow = context.slice(0, MAX_CONTEXT);
  const key = createHash('sha256').update(`${GEMINI_MODEL}\u0000${trimmed}\u0000${contextWindow}`).digest('hex');

  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const { json, text } = await callGemini({
    systemInstruction: SYSTEM_INSTRUCTION,
    input: buildPrompt(trimmed, contextWindow, kind),
    schema: RESPONSE_SCHEMA,
    // A definition does not need deliberation, and thinking roughly doubles latency
    // while the reader waits on a highlight.
    generationConfig: { temperature: 0.2, thinking_level: 'minimal', max_output_tokens: 2048 },
  });

  const result = json ?? { headline: 'Explanation', kind: 'passage', meaning: text, inContext: '', details: [] };
  const normalized = {
    headline: result.headline || trimmed,
    kind: result.kind || kind,
    meaning: result.meaning || '',
    inContext: result.inContext || '',
    details: Array.isArray(result.details) ? result.details.slice(0, 4) : [],
    imageQuery: typeof result.imageQuery === 'string' ? result.imageQuery.trim() : '',
  };

  cache.set(key, normalized);
  return { ...normalized, cached: false };
}
