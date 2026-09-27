/*
 * Read-aloud with a neural voice. Kokoro (82M parameters) runs right here on the CPU,
 * so nothing you read is sent anywhere and it costs nothing per word. The model is
 * loaded lazily — the first request downloads it once (~90 MB) into TTS_CACHE_DIR —
 * so a reader who never presses the voice button never pays for it.
 */
import { TTS_ENGINE, TTS_VOICE, TTS_DTYPE, TTS_CACHE_DIR } from '../config.js';
import { ExplainError } from '../errors.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const SAMPLE_RATE = 24_000;
export const MAX_SPEECH_CHARS = 600;

// The best-graded of Kokoro's English voices; the rest are noticeably rougher.
export const VOICES = [
  { id: 'af_heart', label: 'Heart' },
  { id: 'af_bella', label: 'Bella' },
  { id: 'af_nicole', label: 'Nicole (soft)' },
  { id: 'bf_emma', label: 'Emma (British)' },
  { id: 'am_michael', label: 'Michael' },
  { id: 'am_fenrir', label: 'Fenrir' },
  { id: 'bm_george', label: 'George (British)' },
];
const VOICE_IDS = new Set(VOICES.map((v) => v.id));
const DEFAULT_VOICE = VOICE_IDS.has(TTS_VOICE) ? TTS_VOICE : VOICES[0].id;

const ENGINE = ['kokoro', 'stub', 'off'].includes(TTS_ENGINE) ? TTS_ENGINE : 'kokoro';

const model = {
  state: ENGINE === 'kokoro' ? 'idle' : ENGINE === 'stub' ? 'ready' : 'off',
  error: '',
  files: new Map(), // file -> { loaded, total }, for one overall download figure
  promise: null,
  tts: null,
};

function progress() {
  if (model.state === 'ready') return 100;
  let loaded = 0, total = 0;
  for (const f of model.files.values()) { loaded += f.loaded; total += f.total; }
  return total ? Math.round((loaded / total) * 100) : 0;
}

export function speechStatus() {
  return {
    engine: ENGINE,
    state: model.state,
    progress: progress(),
    error: model.error,
    voices: ENGINE === 'off' ? [] : VOICES,
    defaultVoice: DEFAULT_VOICE,
  };
}

/** Start loading the model if nothing has yet. Safe to call as often as you like. */
export function loadSpeech() {
  if (ENGINE !== 'kokoro') return Promise.resolve();
  if (model.promise) return model.promise;
  model.state = 'loading';
  model.error = '';
  model.promise = (async () => {
    // Imported here, not at the top, so the server starts quickly and still starts if
    // the optional voice packages failed to install.
    const { env } = await import('@huggingface/transformers');
    env.cacheDir = TTS_CACHE_DIR;
    const { KokoroTTS } = await import('kokoro-js');
    model.tts = await KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: TTS_DTYPE,
      device: 'cpu',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.file && p.total) model.files.set(p.file, { loaded: p.loaded, total: p.total });
      },
    });
    model.state = 'ready';
  })().catch((err) => {
    model.state = 'error';
    model.error = err?.message || 'The voice model could not be loaded.';
    model.promise = null; // a later request may try again, say once the network is back
    console.error(`  Read aloud: ${model.error}`);
  });
  return model.promise;
}

/** Check a request body; returns the cleaned-up job or throws a 400. */
export function checkSpeechRequest(body) {
  const text = String(body?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new ExplainError('Nothing to read aloud.', 400);
  if (text.length > MAX_SPEECH_CHARS) throw new ExplainError(`Read aloud takes at most ${MAX_SPEECH_CHARS} characters at a time.`, 400);
  const voice = body?.voice ? String(body.voice) : DEFAULT_VOICE;
  if (!VOICE_IDS.has(voice)) throw new ExplainError('That voice is not available.', 400);
  const speed = Math.min(Math.max(Number(body?.speed) || 1, 0.5), 2);
  return { text, voice, speed };
}

// One generation at a time: ONNX already spreads a single one across every core, so
// running two only makes both late. A job whose caller has gone away is skipped.
let queue = Promise.resolve();

/**
 * @param {{text:string, voice:string, speed:number}} job   from checkSpeechRequest
 * @param {() => boolean} gone   true once the caller no longer wants the answer
 * @returns {Promise<Buffer|null>} a WAV, or null if the caller left first
 */
export function synthesize(job, gone) {
  const run = queue.then(async () => {
    if (gone()) return null;
    if (ENGINE === 'off') throw new ExplainError('Reading aloud with the natural voice is turned off.', 503);
    if (ENGINE === 'stub') return stubWav(job);
    await loadSpeech();
    if (model.state !== 'ready') {
      throw new ExplainError('The natural voice is not available.', 503, model.error);
    }
    if (gone()) return null;
    const audio = await model.tts.generate(job.text, { voice: job.voice, speed: job.speed });
    return Buffer.from(audio.toWav());
  });
  queue = run.catch(() => {});
  return run;
}

/* ------------------------------ test stand-in ------------------------------ */

/**
 * A quiet tone shaped like speech, for the test suite: silence either side, a gap at
 * every comma, and a length that follows the text and the speed.
 */
function stubWav({ text, speed }) {
  const secs = (s) => Math.round(s * SAMPLE_RATE);
  const parts = text.split(/(?<=[,;:])\s+/);
  const pieces = [secs(0.2)];
  parts.forEach((part, i) => {
    pieces.push(-secs((part.length * 0.055) / speed));
    pieces.push(secs(i < parts.length - 1 ? 0.3 : 0.4));
  });
  const total = pieces.reduce((n, p) => n + Math.abs(p), 0);

  const wav = Buffer.alloc(44 + total * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + total * 2, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24); wav.writeUInt32LE(SAMPLE_RATE * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(total * 2, 40);

  let at = 44, n = 0;
  for (const p of pieces) {
    for (let k = 0; k < Math.abs(p); k++, n++, at += 2) {
      // Negative lengths are the "spoken" stretches.
      if (p < 0) wav.writeInt16LE(Math.round(Math.sin((n / SAMPLE_RATE) * 2 * Math.PI * 220) * 6000), at);
    }
  }
  return wav;
}
