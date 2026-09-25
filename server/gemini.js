import { GEMINI_API_KEY, GEMINI_MODEL, GEMINI_API_BASE, GEMINI_API_REVISION, GEMINI_THINKING_LEVEL } from './config.js';

/**
 * The transport for every Gemini call the app makes. Explanations and recaps want
 * different instructions, schemas and budgets but the same wire format, the same
 * error mapping and the same thinking-level negotiation, so that all lives here.
 */

// Named for its first caller. Every AI feature throws it, and the error handler in
// index.js turns any of them into { error, hint } with the right status.
export class ExplainError extends Error {
  constructor(message, status = 502, hint = '') {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

/** Callers check this before touching a cache, so a keyless setup fails the same way every time. */
export function requireKey() {
  if (GEMINI_API_KEY) return;
  throw new ExplainError(
    'No Gemini API key configured.',
    503,
    'Copy .env.example to .env and set GEMINI_API_KEY. Get one at https://aistudio.google.com/apikey'
  );
}

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

/** A caller's signal plus a deadline, without either one cancelling the other's cleanup. */
function deadline(signal, timeoutMs) {
  const timer = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

/**
 * One structured-JSON call. Returns the parsed object plus the raw text, so each
 * caller can fall back its own way when the model ignores the schema.
 *
 * @returns {Promise<{ json: object|null, text: string }>}
 */
export async function callGemini({
  systemInstruction,
  input,
  schema,
  generationConfig = {},
  timeoutMs = 30_000,
  signal,
}) {
  const requested = generationConfig.thinking_level ?? GEMINI_THINKING_LEVEL;

  const send = async (retrying) => {
    const level = corrections.get(requested) ?? requested;
    const body = {
      model: GEMINI_MODEL,
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

    const res = await fetch(`${GEMINI_API_BASE}/interactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
        'Api-Revision': GEMINI_API_REVISION,
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
          console.warn(`Gemini rejected thinking_level "${level}" for ${GEMINI_MODEL}; using "${fallback}".`);
          corrections.set(requested, fallback);
          return send(true);
        }
      }

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
      throw new ExplainError(`Gemini returned nothing (${reason}).`, 502);
    }

    // Schema mode should make this always parse, but a parse failure must never take
    // down the request — the caller decides what to do with bare text.
    try {
      return { json: JSON.parse(text), text };
    } catch {
      return { json: null, text };
    }
  };

  return send(false);
}
