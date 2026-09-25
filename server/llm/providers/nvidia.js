import { env } from '../../config.js';
import { ExplainError } from '../../errors.js';
import { deadline, errorDetail, httpError, parseAnswer } from '../shared.js';

/**
 * NVIDIA NIM, over its OpenAI-compatible chat-completions endpoint — the hosted API at
 * integrate.api.nvidia.com, or a NIM container you run yourself (set NVIDIA_API_BASE).
 *
 * NIM models disagree on the details, so two settings correct themselves, the way
 * gemini.js does for thinking levels: try once, and if the server names the setting
 * as the problem, drop back and remember.
 *  - The schema goes in `response_format`; a server that refuses it gets NIM's own
 *    `nvext.guided_json` instead.
 *  - `reasoning_effort` is sent, because DeepSeek on NIM reasons at `high` unless told
 *    otherwise; a model that does not take it gets the request without it.
 *
 * NIM's model references say roles must alternate user/assistant, so the instructions
 * ride in the user turn rather than as a system message.
 */

// DeepSeek on NIM takes none, high and max. A lookup needs no deliberation; a recap's
// 'low' is nearer none than high, which is the slow, expensive default.
const REASONING_EFFORT = { minimal: 'none', low: 'none', medium: 'high', high: 'high' };

// What this server has refused, so later calls skip the failed attempt.
const refused = { responseFormat: false, reasoningEffort: false };

/** Models that are not constrained sometimes wrap the JSON in a markdown fence. */
function unfence(text) {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return fenced ? fenced[1] : text;
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
  const send = async (retrying) => {
    const body = {
      model: nvidia.model,
      messages: [{ role: 'user', content: `${systemInstruction}\n\n${input}` }],
      temperature: generationConfig.temperature ?? 0.2,
      max_tokens: generationConfig.max_output_tokens ?? 2048,
    };
    if (refused.responseFormat) {
      body.nvext = { guided_json: schema };
    } else {
      body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema } };
    }
    if (!refused.reasoningEffort) {
      body.reasoning_effort = REASONING_EFFORT[generationConfig.thinking_level] ?? 'none';
    }

    const res = await fetch(`${nvidia.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${nvidia.key}`,
      },
      body: JSON.stringify(body),
      signal: deadline(signal, timeoutMs),
    });
    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      const detail = errorDetail(payload, res.status);
      if (!retrying && (res.status === 400 || res.status === 422)) {
        if (!refused.reasoningEffort && /reasoning_effort/i.test(detail)) {
          console.warn(`NVIDIA NIM refused reasoning_effort for ${nvidia.model}; sending without it.`);
          refused.reasoningEffort = true;
          return send(true);
        }
        if (!refused.responseFormat && /response_format|json_schema/i.test(detail)) {
          console.warn(`NVIDIA NIM refused response_format for ${nvidia.model}; using nvext.guided_json.`);
          refused.responseFormat = true;
          return send(true);
        }
      }
      throw httpError(nvidia, res.status, detail);
    }

    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text) {
      const reason = payload?.choices?.[0]?.finish_reason || 'no text in response';
      throw new ExplainError(`NVIDIA NIM returned nothing (${reason}).`, 502);
    }
    return parseAnswer(unfence(text));
  };

  return send(false);
}

const nvidia = {
  id: 'nvidia',
  label: 'NVIDIA NIM',
  // nvapi-... from build.nvidia.com.
  key: env('NVIDIA_API_KEY'),
  keyVar: 'NVIDIA_API_KEY',
  model: env('NVIDIA_MODEL', 'deepseek-ai/deepseek-v4.1-flash'),
  modelVar: 'NVIDIA_MODEL',
  // The hosted API, or a self-hosted NIM such as http://localhost:8000/v1. Also how
  // tests point at a stub.
  base: env('NVIDIA_API_BASE', 'https://integrate.api.nvidia.com/v1'),
  keyUrl: 'https://build.nvidia.com/settings/api-keys',
  modelsUrl: 'https://build.nvidia.com/models',
  call,
};

export default nvidia;
