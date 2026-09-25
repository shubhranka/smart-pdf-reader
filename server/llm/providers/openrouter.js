import { env } from '../../config.js';
import { ExplainError } from '../../errors.js';
import { deadline, errorDetail, httpError, parseAnswer, strictSchema, dropNulls } from '../shared.js';

/**
 * OpenRouter, over its OpenAI-compatible chat-completions endpoint. One key reaches
 * hundreds of models, each served by one or more upstream providers.
 *
 *  - Strict schemas, in OpenAI's form (see strictSchema() in shared.js), and routing
 *    only to providers that honour `response_format` — otherwise a request can land on
 *    one that ignores the schema.
 *  - Real reasoning. Gemini's `thinking_level` names are valid `reasoning.effort` values.
 */

// Reasoning tokens count against max_tokens. Callers size their budgets for the answer
// alone, so add room for the thinking or it can eat the whole budget.
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
    model: openrouter.model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: input },
    ],
    temperature: generationConfig.temperature ?? 0.2,
    max_tokens: (generationConfig.max_output_tokens ?? 2048) + REASONING_ALLOWANCE,
    // Only the answer is used; no need to ship the reasoning back.
    reasoning: { effort: generationConfig.thinking_level ?? 'low', exclude: true },
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'answer', schema: strictSchema(schema), strict: true },
    },
    provider: {
      // Skip upstream providers that would ignore response_format.
      require_parameters: true,
      // Skip upstream providers that store or train on prompts. Nothing to gain from
      // them keeping what we read.
      data_collection: 'deny',
    },
  };

  const res = await fetch(`${openrouter.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${openrouter.key}`,
    },
    body: JSON.stringify(body),
    signal: deadline(signal, timeoutMs),
  });
  const payload = await res.json().catch(() => null);

  if (res.status === 402) {
    throw new ExplainError('OpenRouter is out of credits for this key.', 402, 'Add credits at https://openrouter.ai/settings/credits');
  }
  if (!res.ok) throw httpError(openrouter, res.status, errorDetail(payload, res.status));

  // OpenRouter can return 200 with the upstream provider's failure inside.
  if (payload?.error) throw httpError(openrouter, payload.error.code || 502, errorDetail(payload, 502));

  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text) {
    const reason = payload?.choices?.[0]?.finish_reason || 'no text in response';
    throw new ExplainError(`OpenRouter returned nothing (${reason}).`, 502);
  }
  const answer = parseAnswer(text);
  return { ...answer, json: answer.json && dropNulls(answer.json) };
}

const openrouter = {
  id: 'openrouter',
  label: 'OpenRouter',
  key: env('OPENROUTER_API_KEY'),
  keyVar: 'OPENROUTER_API_KEY',
  model: env('OPENROUTER_MODEL', 'openai/gpt-oss-120b'),
  modelVar: 'OPENROUTER_MODEL',
  // Overridable so tests can point at a stub instead of the real API.
  base: env('OPENROUTER_API_BASE', 'https://openrouter.ai/api/v1'),
  keyUrl: 'https://openrouter.ai/settings/keys',
  modelsUrl: 'https://openrouter.ai/models?supported_parameters=structured_outputs',
  call,
};

export default openrouter;
