import { env } from '../../config.js';
import { ExplainError } from '../../errors.js';
import { deadline, errorDetail, httpError, parseAnswer, strictSchema, dropNulls } from '../shared.js';

/**
 * Groq, over its OpenAI-compatible chat-completions endpoint.
 *
 * Two things differ from Mistral:
 *  - Strict schemas. Groq guarantees the shape on models like gpt-oss, but only if
 *    every property is required; see strictSchema() in shared.js.
 *  - Real reasoning. Gemini's `thinking_level` maps onto `reasoning_effort`.
 */

// gpt-oss takes low, medium and high; 'minimal' is Gemini's and the nearest is low.
const REASONING_EFFORT = { minimal: 'low', low: 'low', medium: 'medium', high: 'high' };

// Reasoning tokens count against max_completion_tokens. Callers size their budgets for
// the answer alone, so add room for the thinking or it can eat the whole budget.
const REASONING_ALLOWANCE = 2048;

/**
 * One structured-JSON call.
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
  const body = {
    model: groq.model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: input },
    ],
    temperature: generationConfig.temperature ?? 0.2,
    max_completion_tokens: (generationConfig.max_output_tokens ?? 2048) + REASONING_ALLOWANCE,
    reasoning_effort: REASONING_EFFORT[generationConfig.thinking_level] ?? 'low',
    // Only the answer is used; no need to ship the reasoning back.
    include_reasoning: false,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'answer', schema: strictSchema(schema), strict: true },
    },
  };

  const res = await fetch(`${groq.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${groq.key}`,
    },
    body: JSON.stringify(body),
    signal: deadline(signal, timeoutMs),
  });
  const payload = await res.json().catch(() => null);

  if (!res.ok) throw httpError(groq, res.status, errorDetail(payload, res.status));

  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text) {
    const reason = payload?.choices?.[0]?.finish_reason || 'no text in response';
    throw new ExplainError(`Groq returned nothing (${reason}).`, 502);
  }
  const answer = parseAnswer(text);
  return { ...answer, json: answer.json && dropNulls(answer.json) };
}

const groq = {
  id: 'groq',
  label: 'Groq',
  key: env('GROQ_API_KEY'),
  keyVar: 'GROQ_API_KEY',
  model: env('GROQ_MODEL', 'openai/gpt-oss-120b'),
  modelVar: 'GROQ_MODEL',
  // Overridable so tests can point at a stub instead of the real API.
  base: env('GROQ_API_BASE', 'https://api.groq.com/openai/v1'),
  keyUrl: 'https://console.groq.com/keys',
  modelsUrl: 'https://console.groq.com/docs/models',
  call,
};

export default groq;
