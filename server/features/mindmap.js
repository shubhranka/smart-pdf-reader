import { createHash } from 'node:crypto';
import { cache } from '../db.js';
import { ExplainError, requireKey, callModel, MODEL } from '../llm/index.js';

/**
 * A mind map of a highlighted passage: one central topic, a few branches, a few leaves.
 *
 * As with the recap diagram, the model hands back a small typed tree and never
 * coordinates — layout is the browser's job, where the panel's width is known.
 */

// Bump when the prompt or schema changes, so cached maps from the old wording are not reused.
const PROMPT_VERSION = 'mindmap-v1';
const MIN_WORDS = 12;
const MAX_SELECTION = 20_000;
const MAX_CONTEXT = 4000;

const MINDMAP_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '3-7 words naming what the passage is about.' },
    root: { type: 'string', description: 'The central topic, at most five words.' },
    branches: {
      type: 'array',
      description: 'Three to six main ideas that hang off the central topic.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'At most four words.' },
          children: {
            type: 'array',
            description: 'Zero to four specifics under this idea.',
            items: {
              type: 'object',
              properties: { label: { type: 'string', description: 'At most six words.' } },
              required: ['label'],
              additionalProperties: false,
            },
          },
        },
        required: ['label', 'children'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'root', 'branches'],
  additionalProperties: false,
};

const SYSTEM_MINDMAP = `You turn a passage someone highlighted in a document into a mind map, so they can see its structure at a glance.

Rules:
- "root" is what the passage is about, in at most five words.
- "branches" are its three to six main ideas — the structure of the argument or explanation, not its sentences in order.
- "children" are the specifics under each idea: examples, parts, causes, steps, defined terms. Fewer is fine; a branch may have none.
- Labels are short noun phrases, not sentences. No full stops.
- Use only what the passage says. Never fill a gap from your own knowledge.
- If the text is garbled by PDF extraction, map what is legible and say so in "title".`;

const str = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

/** Drop what does not hold together rather than handing the renderer a broken tree. */
function normaliseMindmap(raw) {
  const seen = new Set();
  const branches = [];
  for (const b of Array.isArray(raw?.branches) ? raw.branches : []) {
    const label = str(b?.label).slice(0, 48);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());

    const leafSeen = new Set();
    const children = [];
    for (const c of Array.isArray(b?.children) ? b.children : []) {
      const leaf = str(c?.label).slice(0, 60);
      if (!leaf || leafSeen.has(leaf.toLowerCase())) continue;
      leafSeen.add(leaf.toLowerCase());
      children.push({ label: leaf });
      if (children.length === 4) break;
    }
    branches.push({ label, children });
    if (branches.length === 6) break;
  }

  if (branches.length < 2) {
    throw new ExplainError('The model did not return a usable mind map.', 502, 'Try selecting a longer passage.');
  }

  const title = str(raw?.title).slice(0, 80);
  return {
    title: title || 'Mind map',
    root: str(raw?.root).slice(0, 48) || title || 'This passage',
    branches,
  };
}

export async function generateMindmap({ selection, context = '' }) {
  const trimmed = str(selection).slice(0, MAX_SELECTION);
  if (!trimmed) throw new ExplainError('Nothing was selected.', 400);
  if (trimmed.split(' ').length < MIN_WORDS) {
    throw new ExplainError('That is too short to map.', 422, 'Select a paragraph or a whole section.');
  }

  requireKey();

  const contextWindow = context.slice(0, MAX_CONTEXT);
  const key = createHash('sha256')
    .update([PROMPT_VERSION, MODEL, trimmed, contextWindow].join('\u0000'))
    .digest('hex');

  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const contextBlock = contextWindow
    ? `\n\nSurrounding text from the page (for context only — map the highlighted part):\n"""\n${contextWindow}\n"""`
    : '';

  const { json, text } = await callModel({
    systemInstruction: SYSTEM_MINDMAP,
    input: `Make a mind map of this passage.\n\nHighlighted text:\n"""\n${trimmed}\n"""${contextBlock}`,
    schema: MINDMAP_SCHEMA,
    // Structuring one passage is close to extraction; the reader is waiting on it.
    generationConfig: { temperature: 0.2, thinking_level: 'minimal', max_output_tokens: 2048 },
  });
  if (!json) {
    throw new ExplainError(`The model did not return a usable mind map.${text ? '' : ' It returned nothing.'}`, 502);
  }

  const result = normaliseMindmap(json);
  cache.set(key, result);
  return { ...result, cached: false };
}
