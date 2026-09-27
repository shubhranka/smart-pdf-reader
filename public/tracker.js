/*
 * The reading tracker: a soft pill that walks the real text of the PDF word by word at
 * a chosen pace, hops to the next line with a little bounce, and scrolls the document
 * so the reader never has to.
 *
 * Words are measured once per page from the text layer and kept in unscaled page units,
 * so zooming, pinching and pages being released and re-rendered never invalidate them.
 * Every frame the pill's target is recomputed from those units and the live zoom, and
 * springs carry the pill there — which is what makes it smooth rather than stepped.
 */

export const MIN_WPM = 100;
export const MAX_WPM = 800;
export const WPM_STEP = 25;
const DEFAULT_WPM = 250;

const STEP = 1 / 120;            // fixed spring substep, seconds
const MAX_FRAME = 1 / 20;        // a backgrounded tab resumes without a lurch
const READING_LINE = 0.38;       // the pill is kept this far down the viewport
const FOLLOW_RATE = 4;           // how quickly the scroll catches up, per second
const TELEPORT_LINES = 4;        // hops further than this skip most of the way
const SKIP_EMPTY_PAGES = 5;      // image-only pages passed over before giving up

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/** A damped spring on one axis. `zeta` below 1 overshoots — that is the bounce. */
function spring(zeta) {
  return { x: 0, v: 0, target: 0, zeta };
}

function stepSpring(s, omega, zeta, dt) {
  const a = -omega * omega * (s.x - s.target) - 2 * zeta * omega * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
}

/* ------------------------------ word geometry ------------------------------ */

/**
 * Every word on a rendered page as `{x, y, w, h, text, line}` in unscaled page units.
 * The text layer splits lines into runs by font, and sometimes words with them, so two
 * pieces with no space between them and almost no gap are glued back together.
 */
function measureWords(slot) {
  const layer = slot.inner?.querySelector('.textLayer');
  if (!layer) return null;

  const innerRect = slot.inner.getBoundingClientRect();
  // The wrapper may be mid-pinch; undo its scale, then the zoom it was rendered at.
  const scale = (innerRect.width / slot.inner.offsetWidth || 1) * slot.renderedZoom;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const words = [];
  let joinable = false; // the previous piece ran right up to the end of its text node

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.nodeValue ?? '';
    const re = /\S+/g;
    let m;
    while ((m = re.exec(value))) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const r = range.getBoundingClientRect();
      if (r.width < 0.5 || r.height < 0.5) continue;

      const word = {
        x: (r.left - innerRect.left) / scale,
        y: (r.top - innerRect.top) / scale,
        w: r.width / scale,
        h: r.height / scale,
        text: m[0],
      };
      const prev = words[words.length - 1];
      const glue = joinable && m.index === 0 && prev
        && Math.abs(prev.y + prev.h / 2 - (word.y + word.h / 2)) < prev.h * 0.4
        && word.x - (prev.x + prev.w) < prev.h * 0.15
        && word.x - (prev.x + prev.w) > -prev.h * 0.3;

      if (glue) {
        const right = Math.max(prev.x + prev.w, word.x + word.w);
        const top = Math.min(prev.y, word.y);
        prev.h = Math.max(prev.y + prev.h, word.y + word.h) - top;
        prev.y = top;
        prev.w = right - prev.x;
        prev.text += word.text;
      } else {
        words.push(word);
      }
      joinable = m.index + m[0].length === value.length;
    }
    if (!/\S$/.test(value)) joinable = false;
  }

  // Lines, in reading order: a new one starts when the text drops or runs backwards.
  let line = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i], p = words[i - 1];
    if (p) {
      const dropped = Math.abs(w.y + w.h / 2 - (p.y + p.h / 2)) > Math.max(w.h, p.h) * 0.6;
      const back = w.x < p.x - p.h;
      if (dropped || back) line++;
    }
    w.line = line;
  }
  return words;
}

/** How long to rest on a word: longer words and the ends of clauses take longer. */
function dwellMs(word, wpm) {
  const base = 60000 / wpm;
  const len = word.text.replace(/[^\p{L}\p{N}]/gu, '').length;
  let factor = clamp(0.7 + len * 0.09, 0.7, 1.6);
  if (/[.!?:]["'”’)\]]*$/.test(word.text)) factor *= 1.6;
  else if (/[,;]["'”’)\]]*$/.test(word.text)) factor *= 1.25;
  return base * factor;
}

/* --------------------------------- tracker --------------------------------- */

/**
 * @param {object} host
 * @param {HTMLElement} host.container   the scrolling viewer
 * @param {HTMLElement} host.marker      the pill, a child of the container
 * @param {() => object[]} host.getSlots
 * @param {() => number} host.getLiveZoom
 * @param {(slot) => Promise} host.renderPage
 * @param {() => {page:number, offsetPct:number}} host.readingLine
 * @param {() => void} host.onChange     the mode, play state or speed changed
 */
export function createTracker(host) {
  const { container, marker } = host;

  const t = {
    on: false,
    playing: false,
    wpm: loadWpm(),
    cursor: null,        // { slot, i }
    elapsed: 0,          // ms spent on the current word
    waiting: false,      // the next page is still rendering
    visible: false,
    frame: 0,
    last: 0,
  };

  const pos = { x: spring(0.85), y: spring(0.5), w: spring(0.85), h: spring(0.85) };
  const pop = spring(0.35);  // squash on landing a new line
  let landing = false;
  let placed = false;        // springs start where the first word is, not at 0,0

  function loadWpm() {
    try {
      const saved = Number(localStorage.getItem('spr:tracker-wpm'));
      if (saved) return clamp(saved, MIN_WPM, MAX_WPM);
    } catch { /* private mode */ }
    return DEFAULT_WPM;
  }

  async function ensureWords(slot) {
    if (slot.words) return slot.words;
    if (!slot.inner) await host.renderPage(slot).catch(() => {});
    if (!slot.inner) return null;
    slot.words = measureWords(slot);
    return slot.words;
  }

  /** Where the pill should be for `word`, in container scroll coordinates. */
  function targetOf(slot, word) {
    const z = host.getLiveZoom();
    const padX = word.h * 0.22, padY = word.h * 0.14;
    return {
      x: slot.el.offsetLeft + (word.x - padX) * z,
      y: slot.el.offsetTop + (word.y - padY) * z,
      w: (word.w + padX * 2) * z,
      h: (word.h + padY * 2) * z,
    };
  }

  function setVisible(v) {
    if (t.visible === v) return;
    t.visible = v;
    marker.classList.toggle('visible', v);
  }

  function moveTo(slot, i) {
    const prev = t.cursor && t.cursor.slot.words?.[t.cursor.i];
    const next = slot.words[i];
    const newLine = !prev || t.cursor.slot !== slot || prev.line !== next.line;
    t.cursor = { slot, i };
    t.elapsed = 0;
    if (newLine && placed) landing = true;

    const target = targetOf(slot, next);
    // A long hop — a new page, a new column, a click far away — would overshoot by
    // a mile. Jump most of the way and let the spring bounce in for the last bit.
    const far = target.h * TELEPORT_LINES;
    if (!placed) {
      pos.x.x = target.x; pos.y.x = target.y - target.h * 0.8; pos.w.x = target.w; pos.h.x = target.h;
      for (const s of Object.values(pos)) s.v = 0;
      placed = true;
      landing = true;
    } else if (Math.abs(target.y - pos.y.x) > far) {
      pos.y.x = target.y - Math.sign(target.y - pos.y.x) * target.h * 1.2;
      pos.y.v = 0;
      pos.x.x = target.x;
      pos.x.v = 0;
    }
  }

  async function advance() {
    const { slot, i } = t.cursor;
    if (i + 1 < slot.words.length) return moveTo(slot, i + 1);

    // End of the page: on to the next one with any words on it.
    t.waiting = true;
    const slots = host.getSlots();
    for (let n = slot.num + 1, tries = 0; n <= slots.length && tries <= SKIP_EMPTY_PAGES; n++, tries++) {
      const words = await ensureWords(slots[n - 1]);
      if (!t.on || t.cursor?.slot !== slot) return; // stopped or moved meanwhile
      if (words?.length) {
        t.waiting = false;
        return moveTo(slots[n - 1], 0);
      }
    }
    t.waiting = false;
    pause(); // the end of the document, or of its text
  }

  /* ------------------------------ the frame ------------------------------- */

  function frame(now) {
    t.frame = 0;
    if (!t.on || !t.cursor) return;
    const dt = Math.min((now - (t.last || now)) / 1000, MAX_FRAME);
    t.last = now;

    const { slot, i } = t.cursor;
    const word = slot.words[i];

    // Reads first, writes after, so the frame never forces a layout of its own.
    const target = targetOf(slot, word);
    const viewH = container.clientHeight;
    const viewW = container.clientWidth;
    const scrollTop = container.scrollTop;
    const scrollLeft = container.scrollLeft;

    if (t.playing && !t.waiting) {
      t.elapsed += dt * 1000;
      if (t.elapsed >= dwellMs(word, t.wpm)) advance();
    }

    pos.x.target = target.x; pos.y.target = target.y;
    pos.w.target = target.w; pos.h.target = target.h;

    // Glide speed tracks reading speed: fast readers get a snappier pill.
    const dwell = dwellMs(word, t.wpm) / 1000;
    const omegaX = clamp((2 * Math.PI) / (dwell * 1.1), 14, 42);
    const omegaY = 24;
    const calm = reducedMotion.matches;

    for (let left = dt; left > 1e-6; left -= STEP) {
      const h = Math.min(STEP, left);
      stepSpring(pos.x, omegaX, calm ? 1 : pos.x.zeta, h);
      stepSpring(pos.w, omegaX, calm ? 1 : pos.w.zeta, h);
      stepSpring(pos.y, omegaY, calm ? 1 : pos.y.zeta, h);
      stepSpring(pos.h, omegaY, calm ? 1 : pos.h.zeta, h);
      stepSpring(pop, 30, pop.zeta, h);
    }

    if (landing && Math.abs(pos.y.x - pos.y.target) < target.h * 0.2) {
      landing = false;
      if (!calm) pop.v -= 5; // squash flat, then jelly back
    }

    // Stretch along the direction of travel while hopping; squash when it lands.
    let sx = 1, sy = 1;
    if (!calm) {
      const stretch = clamp(Math.abs(pos.y.v) / (target.h * 90), 0, 0.22);
      sy = 1 + stretch + pop.x;
      sx = 1 - stretch * 0.5 - pop.x * 0.6;
    }

    marker.style.width = `${Math.max(pos.w.x, 2)}px`;
    marker.style.height = `${Math.max(pos.h.x, 2)}px`;
    marker.style.transform = `translate3d(${pos.x.x}px, ${pos.y.x}px, 0) scale(${sx}, ${sy})`;

    // Keep the pill on the reading line, and in view sideways when zoomed in.
    if (t.playing) {
      const ease = 1 - Math.exp(-dt * FOLLOW_RATE);
      const wantTop = pos.y.x + pos.h.x / 2 - viewH * READING_LINE;
      if (Math.abs(wantTop - scrollTop) > 0.5) container.scrollTop = scrollTop + (wantTop - scrollTop) * ease;
      const cx = pos.x.x + pos.w.x / 2 - scrollLeft;
      if (container.scrollWidth > viewW && (cx < viewW * 0.12 || cx > viewW * 0.88)) {
        container.scrollLeft = scrollLeft + (pos.x.x + pos.w.x / 2 - viewW / 2 - scrollLeft) * ease;
      }
    }

    const settled = [pos.x, pos.y, pos.w, pos.h, pop].every((s) =>
      Math.abs(s.v) < 0.05 && Math.abs(s.x - s.target) < 0.1);
    if (t.playing || !settled) kick();
  }

  function kick() {
    if (t.frame) return;
    t.frame = requestAnimationFrame(frame);
  }

  /* ------------------------------ controls -------------------------------- */

  async function startFromReadingLine() {
    const { page, offsetPct } = host.readingLine();
    const slots = host.getSlots();
    for (let n = page; n <= Math.min(slots.length, page + SKIP_EMPTY_PAGES); n++) {
      const slot = slots[n - 1];
      const words = await ensureWords(slot);
      if (!t.on) return false;
      if (!words?.length) continue;
      const line = n === page ? offsetPct * slot.baseH : 0;
      const i = Math.max(0, words.findIndex((w) => w.y + w.h >= line));
      moveTo(slot, i);
      return true;
    }
    return false;
  }

  function play() {
    if (!t.on) return;
    t.last = 0;
    if (!t.cursor) {
      t.playing = true;
      host.onChange();
      startFromReadingLine().then((ok) => {
        if (!ok) { t.playing = false; host.onChange(); return; }
        setVisible(true);
        kick();
      });
      return;
    }
    t.playing = true;
    setVisible(true);
    kick();
    host.onChange();
  }

  function pause() {
    if (!t.playing) return;
    t.playing = false;
    host.onChange();
  }

  function togglePlay() {
    if (t.playing) pause();
    else play();
  }

  /** Start from the word nearest a click on page `slot`. */
  async function startAt(slot, clientX, clientY) {
    if (!t.on || !slot) return;
    const words = await ensureWords(slot);
    if (!t.on || !words?.length) return;
    const rect = slot.el.getBoundingClientRect();
    const z = host.getLiveZoom();
    const bx = (clientX - rect.left) / z, by = (clientY - rect.top) / z;

    let best = 0, bestD = Infinity;
    words.forEach((w, i) => {
      const dx = Math.max(w.x - bx, 0, bx - (w.x + w.w));
      const dy = Math.max(w.y - by, 0, by - (w.y + w.h));
      const d = dx * dx + dy * dy * 4; // being on the right line matters more
      if (d < bestD) { bestD = d; best = i; }
    });

    moveTo(slot, best);
    play();
  }

  function setWpm(next) {
    t.wpm = clamp(Math.round(next / WPM_STEP) * WPM_STEP, MIN_WPM, MAX_WPM);
    try { localStorage.setItem('spr:tracker-wpm', String(t.wpm)); } catch { /* private mode */ }
    host.onChange();
  }

  function setOn(on) {
    if (t.on === on) return;
    t.on = on;
    if (!on) {
      t.playing = false;
      t.cursor = null;
      t.waiting = false;
      placed = false;
      landing = false;
      setVisible(false);
      if (t.frame) cancelAnimationFrame(t.frame);
      t.frame = 0;
    }
    host.onChange();
  }

  // Scrolling by hand means the reader has taken over; stop following rather than fight.
  const takeOver = () => { if (t.playing) pause(); };
  container.addEventListener('wheel', (e) => { if (!e.ctrlKey && !e.metaKey) takeOver(); }, { passive: true });
  container.addEventListener('touchmove', takeOver, { passive: true });
  // A press on the container itself, not a page, is a press on its scrollbar.
  container.addEventListener('mousedown', (e) => { if (e.target === container) takeOver(); });

  return {
    get on() { return t.on; },
    get playing() { return t.playing; },
    get started() { return Boolean(t.cursor); },
    get wpm() { return t.wpm; },
    setOn,
    play,
    pause,
    togglePlay,
    startAt,
    setWpm,
    /** Something moved the pages (a zoom); let a resting pill catch up. */
    refresh: () => { if (t.cursor) kick(); },
    nudge: (dir) => setWpm(t.wpm + dir * WPM_STEP),
  };
}
