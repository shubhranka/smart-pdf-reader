/*
 * The voice behind the tracker. Two engines, one shape: `say(chunk)` reads a chunk
 * from speech-text.js aloud and reports each word as it starts, so the pill can follow.
 *
 *  - neural: Kokoro on our own server (/api/speech). Sounds close to a person. It sends
 *    no word timings, so they are estimated: the clip is scanned for where speech starts
 *    and stops and for the pauses at its commas, and each clause is spread over its own
 *    stretch of sound. The next chunk is fetched while this one plays, so there is no
 *    wait between sentences — only the pause we choose.
 *  - browser: speechSynthesis, which reports words itself. The fallback when the
 *    server has no voice.
 */

export const MIN_SPEAK_WPM = 100;
export const MAX_SPEAK_WPM = 325;
const NEURAL_WPM = 165;          // what Kokoro reads at speed 1
const BROWSER_WPM = 180;         // roughly what a system voice reads at rate 1
const CACHE_SIZE = 20;
const NO_BOUNDARY_MS = 700;      // a system voice this quiet about its words gets estimated
const NOTICE_MS = 6000;

const synth = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window
  ? window.speechSynthesis : null;
const AudioCtx = window.AudioContext || window.webkitAudioContext;
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, method = 'GET') {
  const res = await fetch(url, { method });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/* ------------------------------ reading a clip ------------------------------ */

/** Where speech starts and stops in a clip, and the silent gaps in between. */
function shapeOf(buffer) {
  const data = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const win = Math.max(1, Math.round(rate * 0.01));
  let peak = 0;
  for (let i = 0; i < data.length; i += 4) peak = Math.max(peak, Math.abs(data[i]));
  const floor = Math.max(0.01, peak * 0.06);

  let on = -1, off = -1, quietFrom = -1;
  const gaps = [];
  for (let s = 0; s < data.length; s += win) {
    let p = 0;
    for (let j = s, e = Math.min(s + win, data.length); j < e; j++) p = Math.max(p, Math.abs(data[j]));
    if (p > floor) {
      if (on < 0) on = s;
      else if (quietFrom >= 0 && (s - quietFrom) / rate >= 0.12) gaps.push({ start: quietFrom / rate, end: s / rate });
      quietFrom = -1;
      off = Math.min(s + win, data.length);
    } else if (quietFrom < 0 && on >= 0) {
      quietFrom = s;
    }
  }
  if (on < 0) return { on: 0, off: buffer.duration, gaps: [] };
  return { on: on / rate, off: off / rate, gaps };
}

/** When each word of `chunk` starts in the clip, in seconds. */
function wordTimes(chunk, { on, off, gaps }) {
  const k = chunk.words.length;
  let groups = [];
  let group = [];
  for (let j = 0; j < k; j++) {
    group.push(j);
    if (chunk.clauseAfter[j]) { groups.push(group); group = []; }
  }
  if (group.length) groups.push(group);

  // One stretch of sound per clause, split at the longest pauses — a voice pauses
  // longer at a comma than between words. If the pauses don't add up, spread evenly.
  let spans = [[on, off]];
  if (groups.length > 1 && gaps.length >= groups.length - 1) {
    const picked = [...gaps]
      .sort((x, y) => (y.end - y.start) - (x.end - x.start))
      .slice(0, groups.length - 1)
      .sort((x, y) => x.start - y.start);
    spans = [];
    let from = on;
    for (const g of picked) { spans.push([from, g.start]); from = g.end; }
    spans.push([from, off]);
  } else {
    groups = [[...Array(k).keys()]];
  }

  const times = new Array(k);
  groups.forEach((g, gi) => {
    const [a, b] = spans[gi];
    const cost = (j, inGroup) => chunk.weights[j] + (inGroup ? chunk.pauses[j] : 0);
    const total = g.reduce((n, j, x) => n + cost(j, x < g.length - 1), 0) || 1;
    let acc = 0;
    g.forEach((j, x) => {
      times[j] = a + (acc / total) * (b - a);
      acc += cost(j, x < g.length - 1);
    });
  });
  return times;
}

/* -------------------------------- narrator --------------------------------- */

export function createNarrator({ onChange }) {
  const n = {
    neural: null,        // true once the server has a voice ready; false if it has none
    ready: null,         // the promise of finding out
    loading: false,
    progress: 0,
    busy: false,         // the reader is waiting on audio
    notice: '',
    noticeTimer: 0,
    voices: [],
    voice: loadVoice(),
    current: null,
  };
  let ctx = null;
  const cache = new Map(); // key -> { promise, controller, settled }

  function loadVoice() {
    try { return localStorage.getItem('spr:tracker-voice') || ''; } catch { return ''; }
  }

  const engine = () => (n.neural ? 'neural' : synth ? 'browser' : null);

  function setBusy(v) {
    if (n.busy === v) return;
    n.busy = v;
    onChange();
  }

  function notify(message) {
    n.notice = message;
    clearTimeout(n.noticeTimer);
    n.noticeTimer = setTimeout(() => { n.notice = ''; onChange(); }, NOTICE_MS);
    onChange();
  }

  /**
   * Find out whether the server can speak, and have it load its model if so. `fresh`
   * asks again even if we already know — the reader turning the voice back on.
   */
  function prepare(fresh = false) {
    if (fresh && !n.loading) n.ready = null;
    n.ready ??= (async () => {
      try {
        let s = await json('/api/speech/status');
        if (s.engine === 'off') { n.neural = false; return; }
        n.voices = s.voices;
        if (!n.voices.some((v) => v.id === n.voice)) n.voice = s.defaultVoice;
        if (s.state !== 'ready' && s.state !== 'loading') s = await json('/api/speech/load', 'POST');
        while (s.state === 'loading') {
          n.loading = true;
          n.progress = s.progress;
          onChange();
          await sleep(500);
          s = await json('/api/speech/status');
        }
        n.neural = s.state === 'ready';
        if (!n.neural && synth) notify('Natural voice unavailable — using the system voice');
      } catch {
        n.neural = false;
      } finally {
        n.loading = false;
        onChange();
      }
    })();
    return n.ready;
  }

  /** Must run inside a click or key press, or the browser keeps the audio muted. */
  function unlock() {
    if (!AudioCtx) return;
    ctx ??= new AudioCtx();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  /* ------------------------------ neural voice ------------------------------ */

  const speedFor = (wpm) => clamp(wpm / NEURAL_WPM, 0.5, 2);
  const keyFor = (chunk, wpm) => `${n.voice}|${speedFor(wpm).toFixed(2)}|${chunk.text}`;

  function fetchAudio(chunk, wpm, { prefetch = false } = {}) {
    const key = keyFor(chunk, wpm);
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      if (!prefetch) hit.claimed = true;
      return hit.promise;
    }
    const controller = new AbortController();
    const entry = { controller, settled: false, claimed: !prefetch, promise: null };
    entry.promise = fetch('/api/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: chunk.text, voice: n.voice, speed: speedFor(wpm) }),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw Object.assign(new Error(body?.error || `HTTP ${res.status}`), { status: res.status });
        }
        return res.arrayBuffer();
      })
      .then((bytes) => {
        ctx ??= new AudioCtx();
        return ctx.decodeAudioData(bytes);
      })
      .then((buffer) => {
        entry.settled = true;
        return { buffer, shape: shapeOf(buffer) };
      })
      .catch((err) => {
        if (cache.get(key) === entry) cache.delete(key);
        throw err;
      });
    cache.set(key, entry);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return entry.promise;
  }

  function sayNeural(chunk, wpm, h, onFail) {
    let cancelled = false, source = null;
    const timers = [];
    setBusy(true);
    fetchAudio(chunk, wpm).then(async ({ buffer, shape }) => {
      if (cancelled) return;
      if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => {}), sleep(500)]);
      if (cancelled) return;
      setBusy(false);
      if (ctx.state !== 'running') return onFail(new Error('Audio is blocked'));

      // Skip the clip's own lead-in and tail; the gap between chunks is ours to set.
      const lead = Math.max(0, shape.on - 0.05);
      const at = ctx.currentTime + 0.03;
      source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => { if (!cancelled) h.onEnd(); };
      source.start(at, lead);
      source.stop(at + (shape.off - lead) + chunk.pauseAfter);

      wordTimes(chunk, shape).forEach((t, j) => {
        timers.push(setTimeout(() => { if (!cancelled) h.onWord(j); }, (t - lead + 0.03) * 1000));
      });
    }, (err) => {
      if (cancelled || err.name === 'AbortError') return;
      setBusy(false);
      onFail(err);
    });
    return {
      cancel() {
        cancelled = true;
        timers.forEach(clearTimeout);
        if (source) {
          source.onended = null;
          try { source.stop(); } catch { /* never started */ }
        }
      },
    };
  }

  /* ------------------------------ system voice ------------------------------ */

  let systemVoice = null;
  function pickSystemVoice() {
    const lang = (navigator.language || 'en').toLowerCase();
    const base = lang.split('-')[0];
    let best = null, bestScore = 0;
    for (const v of synth.getVoices()) {
      const vl = v.lang.toLowerCase().replace('_', '-');
      if (vl.split('-')[0] !== base) continue;
      // The good ones say so in their names; local voices report their word boundaries.
      const score = 1
        + (/premium|enhanced|natural|neural/i.test(v.name) ? 8 : 0)
        + (v.default ? 4 : 0) + (v.localService ? 2 : 0) + (vl === lang ? 1 : 0);
      if (score > bestScore) { best = v; bestScore = score; }
    }
    systemVoice = best;
  }
  if (synth) {
    pickSystemVoice();
    synth.addEventListener?.('voiceschanged', pickSystemVoice);
  }

  function sayBrowser(chunk, wpm, h) {
    let cancelled = false, heard = false;
    const timers = [];
    const u = new SpeechSynthesisUtterance(chunk.text);
    u.rate = clamp(wpm / BROWSER_WPM, 0.5, 2);
    if (systemVoice) { u.voice = systemVoice; u.lang = systemVoice.lang; }

    // Some voices never say where they are; estimate from the words' weights instead.
    const estimate = () => {
      if (cancelled || heard) return;
      const units = chunk.weights.reduce((s, w, j) => s + w + chunk.pauses[j], 0) || 1;
      const secs = (chunk.words.length * 60) / wpm;
      let acc = 0;
      chunk.words.forEach((_, j) => {
        const at = (acc / units) * secs * 1000;
        timers.push(setTimeout(() => { if (!cancelled && !heard) h.onWord(j); }, at));
        acc += chunk.weights[j] + chunk.pauses[j];
      });
    };
    u.onstart = () => { if (!cancelled) timers.push(setTimeout(estimate, NO_BOUNDARY_MS)); };
    u.onboundary = (e) => {
      if (cancelled || (e.name && e.name !== 'word')) return;
      heard = true;
      let k = chunk.starts.length - 1;
      while (k > 0 && chunk.starts[k] > e.charIndex) k--;
      h.onWord(k);
    };
    u.onend = () => { if (!cancelled) { timers.forEach(clearTimeout); h.onEnd(); } };
    u.onerror = (e) => {
      if (cancelled || e.error === 'interrupted' || e.error === 'canceled') return;
      h.onError(new Error(e.error || 'Speech failed'));
    };
    synth.speak(u);
    return {
      cancel() {
        cancelled = true;
        timers.forEach(clearTimeout);
        synth.cancel();
      },
    };
  }

  /* --------------------------------- public ---------------------------------- */

  /**
   * Read `chunk` aloud at `wpm`. Calls `onWord(k)` as word k begins, `onEnd` once it
   * and the pause after it are over, `onError` if there is no voice to be had.
   */
  function say(chunk, wpm, h) {
    let cancelled = false, inner = null;
    const handle = { cancel() { cancelled = true; inner?.cancel(); } };
    n.current = handle;
    const browser = () => {
      if (cancelled) return;
      if (synth) inner = sayBrowser(chunk, wpm, h);
      else h.onError(new Error('No voice available'));
    };
    setBusy(true);
    (n.ready ?? prepare()).then(() => {
      if (cancelled) return;
      if (!n.neural) { setBusy(false); return browser(); }
      inner = sayNeural(chunk, wpm, h, (err) => {
        // The server lost its voice mid-read: carry on with the system one.
        n.neural = false;
        if (synth) notify('Natural voice unavailable — using the system voice');
        console.warn('Read aloud:', err.message);
        browser();
      });
    });
    return handle;
  }

  /** Have `chunk` ready before it is needed. */
  function prefetch(chunk, wpm) {
    if (n.neural) fetchAudio(chunk, wpm, { prefetch: true }).catch(() => {});
  }

  /** Stop fetching ahead in a voice or at a speed no longer wanted. */
  function dropStale(wpm) {
    const want = `${n.voice}|${speedFor(wpm).toFixed(2)}|`;
    for (const [k, e] of cache) {
      if (!e.settled && !e.claimed && !k.startsWith(want)) { e.controller.abort(); cache.delete(k); }
    }
  }

  /** Stop talking, and stop fetching what we were about to say. */
  function stop() {
    n.current?.cancel();
    n.current = null;
    for (const [k, e] of cache) if (!e.settled) { e.controller.abort(); cache.delete(k); }
    setBusy(false);
  }

  function setVoice(id) {
    if (!n.voices.some((v) => v.id === id) || id === n.voice) return false;
    n.voice = id;
    try { localStorage.setItem('spr:tracker-voice', id); } catch { /* private mode */ }
    onChange();
    return true;
  }

  window.addEventListener('pagehide', () => { stop(); synth?.cancel(); });

  return {
    get available() { return Boolean(synth) || (Boolean(AudioCtx) && n.neural !== false); },
    get engine() { return engine(); },
    get loading() { return n.loading; },
    get progress() { return n.progress; },
    get busy() { return n.busy; },
    get notice() { return n.notice; },
    get voices() { return n.neural ? n.voices : []; },
    get voice() { return n.voice; },
    prepare,
    unlock,
    say,
    prefetch,
    dropStale,
    stop,
    setVoice,
  };
}
