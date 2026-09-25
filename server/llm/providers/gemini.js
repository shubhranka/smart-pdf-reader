import { env } from '../../config.js';
import { ExplainError } from '../../errors.js';
import { deadline, parseAnswer } from '../shared.js';

/**
 * Gemini, over the Interactions API: its wire format, its error mapping and the
 * thinking-level negotiation.
 */

const API_KEY = env('GEMINI_API_KEY');
const MODEL = env('GEMINI_MODEL', 'gemini-3.5-flash');
// Overridable so tests can point at a stub instead of the real API.
const API_BASE = env('GEMINI_API_BASE', 'https://generativelanguage.googleapis.com/v1beta');
// Pins the request/response shape of the Interactions API. Google's own examples send it.
const API_REVISION = env('GEMINI_API_REVISION', '2026-05-20');
// Models differ on which levels they accept, so this is both configurable and, on
// rejection, corrected from what the API says it allows.
const THINKING_LEVEL = env('GEMINI_THINKING_LEVEL', 'low');

/**
 * An Interaction response carries `steps`, each holding content blocks. Mirror the
 * SDKs' `output_text`: take the trailing run of text blocks, so reasoning or tool
 * blocks earlier in the response are left out.
 */
export function outputText(payload) {
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

// Cheapest first: the fallback should cost the least of whatever the model will take.
const THINKING_PREFERENCE = ['minimal', 'low', 'medium', 'high'];

/**
 * A model that rejects a thinking level names the ones it takes; believe it, and
 * remember the answer. Keyed by the level that was asked for, because a lookup wants
 * the cheapest thinking and a recap wants more — one global would let whichever ran
 * first decide for both.
 */
const corrections = new Map();

function allowedLevelFrom(message) {
  const listed = /allowed values are:?\s*([a-z,\s]+)/i.exec(message ?? '');
  if (!listed) return null;
  const allowed = listed[1].split(/[,\s]+/).map((v) => v.trim().toLowerCase()).filter(Boolean);
  return THINKING_PREFERENCE.find((level) => allowed.includes(level)) ?? null;
}

/**
 * One structured-JSON call. Returns the parsed object plus the raw text, so each
 * caller can fall back its own way when the model ignores the schema.
 *
 * @returns {Promise<{ json: object|null, text: string }>}
 */
async function call({
  systemInstruction,
  input,
  schema,
  generationConfig = {},
  timeoutMs = 30_000,
  signal,
}) {
  const requested = generationConfig.thinking_level ?? THINKING_LEVEL;

  const send = async (retrying) => {
    const level = corrections.get(requested) ?? requested;
    const body = {
      model: MODEL,
      system_instruction: systemInstruction,
      input,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema,
      },
      generation_config: {
        temperature: 0.2,
        max_output_tokens: 2048,
        ...generationConfig,
        thinking_level: level,
      },
      // Nothing to gain from Google retaining what we read.
      store: false,
    };

    const res = await fetch(`${API_BASE}/interactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': API_KEY,
        'Api-Revision': API_REVISION,
      },
      body: JSON.stringify(body),
      signal: deadline(signal, timeoutMs),
    });
    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      const detail = payload?.error?.message || `HTTP ${res.status}`;

      // Switch to a level this model accepts and try once more, rather than making the
      // reader edit a config file over a setting we can work out ourselves.
      if (!retrying && /thinking[_ ]level/i.test(detail)) {
        const fallback = allowedLevelFrom(detail);
        if (fallback && fallback !== level) {
          console.warn(`Gemini rejected thinking_level "${level}" for ${MODEL}; using "${fallback}".`);
          corrections.set(requested, fallback);
          return send(true);
        }
      }

      if (res.status === 401 || (res.status === 400 && /API key not valid/i.test(detail))) {
        throw new ExplainError('Gemini rejected the API key.', 401, 'Check GEMINI_API_KEY in .env');
      }
      if (res.status === 403 && /permission|access/i.test(detail)) {
        throw new ExplainError(`Your key cannot use "${MODEL}".`, 403, 'Pick another GEMINI_MODEL in .env — see https://ai.google.dev/gemini-api/docs/models');
      }
      if (res.status === 404) {
        throw new ExplainError(`Model "${MODEL}" is not available for this key.`, 400, 'Pick a current GEMINI_MODEL in .env — see https://ai.google.dev/gemini-api/docs/models');
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
      throw new ExplainError(`Gemini returned nothing (${reason}).`, 502);
    }

    return parseAnswer(text);
  };

  return send(false);
}

export default {
  id: 'gemini',
  label: 'Gemini',
  key: API_KEY,
  keyVar: 'GEMINI_API_KEY',
  model: MODEL,
  modelVar: 'GEMINI_MODEL',
  keyUrl: 'https://aistudio.google.com/apikey',
  modelsUrl: 'https://ai.google.dev/gemini-api/docs/models',
  call,
};
