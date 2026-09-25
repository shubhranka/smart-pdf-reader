import { env } from '../../config.js';
import { ExplainError } from '../../errors.js';
import { deadline, errorDetail, httpError, parseAnswer } from '../shared.js';

/**
 * Mistral, over its chat-completions endpoint.
 *
 * `thinking_level` is Gemini's setting and has no equivalent here, so it is dropped;
 * pick a reasoning or non-reasoning model instead.
 */

/** Content is usually a string, but may come back as typed parts. Keep only the text. */
function messageText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('');
  }
  return '';
}

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
    model: mistral.model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: input },
    ],
    temperature: generationConfig.temperature ?? 0.2,
    max_tokens: generationConfig.max_output_tokens ?? 2048,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'answer', schema, strict: true },
    },
  };

  const res = await fetch(`${mistral.base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${mistral.key}`,
    },
    body: JSON.stringify(body),
    signal: deadline(signal, timeoutMs),
  });
  const payload = await res.json().catch(() => null);

  console.log("res", res)
  console.log("payload", payload)
  if (!res.ok) throw httpError(mistral, res.status, errorDetail(payload, res.status));

  const text = messageText(payload);
  if (!text) {
    const reason = payload?.choices?.[0]?.finish_reason || 'no text in response';
    throw new ExplainError(`Mistral returned nothing (${reason}).`, 502);
  }
  return parseAnswer(text);
}

const mistral = {
  id: 'mistral',
  label: 'Mistral',
  key: env('MISTRAL_API_KEY'),
  keyVar: 'MISTRAL_API_KEY',
  model: env('MISTRAL_MODEL', 'mistral-small-latest'),
  modelVar: 'MISTRAL_MODEL',
  // Overridable so tests can point at a stub instead of the real API.
  base: env('MISTRAL_API_BASE', 'https://api.mistral.ai/v1'),
  keyUrl: 'https://console.mistral.ai/api-keys',
  modelsUrl: 'https://docs.mistral.ai/getting-started/models/models_overview/',
  call,
};

export default mistral;
