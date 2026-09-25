import { ExplainError } from '../errors.js';

/** The plumbing every provider needs, so each provider file is only its own wire format. */

/** A caller's signal plus a deadline, without either one cancelling the other's cleanup. */
export function deadline(signal, timeoutMs) {
  const timer = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timer]) : timer;
}

/** Providers disagree on where the message goes in an error body; look in the usual places. */
export function errorDetail(payload, status) {
  const err = payload?.error;
  if (typeof err === 'string') return err;
  if (err?.message) return err.message;
  if (typeof payload?.message === 'string') return payload.message;
  if (typeof payload?.detail === 'string') return payload.detail;
  return `HTTP ${status}`;
}

/** Map a failed response to an error that says what to change in .env. */
export function httpError(provider, status, detail) {
  const { label, keyVar, model, modelVar, modelsUrl } = provider;
  if (status === 401) {
    return new ExplainError(`${label} rejected the API key.`, 401, `Check ${keyVar} in .env`);
  }
  if (status === 403) {
    return new ExplainError(`Your key cannot use "${model}".`, 403, `Pick another ${modelVar} in .env — see ${modelsUrl}`);
  }
  if (status === 404 || (/model/i.test(detail) && /not (found|exist)|invalid|unknown/i.test(detail))) {
    return new ExplainError(`Model "${model}" is not available for this key.`, 400, `Pick a current ${modelVar} in .env — see ${modelsUrl}`);
  }
  if (status === 429) {
    return new ExplainError(`${label} rate limit hit. Wait a moment and try again.`, 429);
  }
  return new ExplainError(`${label} error: ${detail}`, 502);
}

/**
 * Schema mode should make this always parse, but a parse failure must never take
 * down the request — the caller decides what to do with bare text.
 */
export function parseAnswer(text) {
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

/**
 * Rewrite a schema for OpenAI-style strict mode (Groq and OpenRouter use it), which demands every property be
 * required: all properties required, the optional ones nullable. Pair with dropNulls()
 * on the answer, so callers see the same shape as when a field is simply left out.
 */
export function strictSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema };
  if (schema.items) out.items = strictSchema(schema.items);
  if (schema.properties) {
    const required = new Set(schema.required ?? []);
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, prop]) => {
      const strict = strictSchema(prop);
      return [name, required.has(name) ? strict : nullable(strict)];
    }));
    out.required = Object.keys(schema.properties);
    out.additionalProperties = false;
  }
  return out;
}

function nullable(prop) {
  const types = Array.isArray(prop.type) ? prop.type : [prop.type];
  const out = { ...prop, type: [...new Set([...types, 'null'])] };
  if (Array.isArray(prop.enum)) out.enum = [...prop.enum, null];
  return out;
}

/** Undo nullable(): a null means the model left the field out. */
export function dropNulls(value) {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)]));
  }
  return value;
}
