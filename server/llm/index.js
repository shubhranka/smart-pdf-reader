import { ExplainError } from '../errors.js';
import gemini from './providers/gemini.js';
import mistral from './providers/mistral.js';
import groq from './providers/groq.js';
import openrouter from './providers/openrouter.js';
import nvidia from './providers/nvidia.js';

/**
 * The one door every AI feature goes through. Explanations and recaps want different
 * instructions, schemas and budgets; which provider answers them is decided once, here.
 *
 * Adding a provider means one file in providers/ exporting { id, label, key, keyVar,
 * model, modelVar, keyUrl, modelsUrl, call } and one entry below.
 */

export { ExplainError };

// Order matters: with LLM_PROVIDER unset, the first one with a key wins.
const PROVIDERS = { gemini, mistral, groq, openrouter, nvidia };

/**
 * LLM_PROVIDER picks one outright; left unset, the first provider with a key wins, so
 * pasting a single key into .env is enough.
 */
function pickProvider() {
  const asked = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (asked) {
    const provider = PROVIDERS[asked];
    if (!provider) {
      throw new Error(`Unknown LLM_PROVIDER "${asked}". Use one of: ${Object.keys(PROVIDERS).join(', ')}.`);
    }
    return provider;
  }
  return Object.values(PROVIDERS).find((p) => p.key) ?? gemini;
}

export const PROVIDER = pickProvider();

// Part of every cache key, so switching provider or model never serves an old answer.
export const MODEL = PROVIDER.model;

/** Callers check this before touching a cache, so a keyless setup fails the same way every time. */
export function requireKey() {
  if (PROVIDER.key) return;
  throw new ExplainError(
    `No ${PROVIDER.label} API key configured.`,
    503,
    `Copy .env.example to .env and set ${PROVIDER.keyVar}. Get one at ${PROVIDER.keyUrl}`
  );
}

/**
 * One structured-JSON call to the configured provider.
 *
 * @returns {Promise<{ json: object|null, text: string }>}
 */
export function callModel(options) {
  return PROVIDER.call(options);
}
