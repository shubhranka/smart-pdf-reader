/*
 * Drawing on the pages, and on a scratch pad beside them: a pen, a highlighter and an
 * eraser, with real pressure from a pen tablet.
 *
 * Strokes are kept in each page's unscaled units (see ink-format.js). Every page carries
 * one SVG whose viewBox is that unscaled size, stretched over the page box. The box
 * already follows the live zoom, so ink keeps up with a pinch frame by frame and is never
 * redrawn for a zoom. The scratch pad is page 0: a sheet PAD_WIDTH units wide.
 *
 * Every change saves itself. A page goes to the server whole, half a second after the
 * last change to it, one request at a time: the request that lands last always carries
 * the newest version, so an undo can never be overtaken by the stroke it undid.
 */

import { getStrokeOutlinePoints, getStrokePoints } from '/vendor/perfect-freehand/dist/esm/index.mjs';
import { api } from './api.js';
import { LIMITS, SIZES, TOOLS, WIDTHS, round1, simplify } from './ink-format.js';

export const PAD = 0;
export const PAD_WIDTH = 600;

/** Five colours a tool: inks dark enough to read, highlighters light enough to read through. */
export const PALETTES = {
  pen: [
    { name: 'Black', value: '#1c1b19' },
    { name: 'Red', value: '#c8312b' },
    { name: 'Blue', value: '#1f5bc4' },
    { name: 'Green', value: '#23803a' },
    { name: 'Purple', value: '#7b3fb8' },
  ],
  highlighter: [
    { name: 'Yellow', value: '#ffe14d' },
    { name: 'Green', value: '#a3eeac' },
    { name: 'Blue', value: '#a8d4ff' },
    { name: 'Pink', value: '#ffb3d1' },
    { name: 'Orange', value: '#ffc48a' },
  ],
};

const ERASER_PX = 8;          // eraser radius on screen; the cursor is drawn to match
const SIMPLIFY_PX = 0.35;     // a finished stroke drops points this close to its line, on screen
const MIN_STEP_PX = 0.5;      // a sample closer than this to the last one adds nothing
const DENSE_STEP = 6;         // page units between the points a pen outline is built from
const PIECE = 32;             // samples in each piece of a stroke still being drawn
const PRESSURE_RANGE = 0.05;  // a "mouse" whose pressure varies this much is really a tablet
const SAVE_MS = 500;
const RETRY_MS = 3000;
const NOTICE_MS = 6000;
const MAX_UNDO = 200;
const MAX_BODY = 8 * 1024 * 1024; // what the server takes for one page
const SVG_NS = 'http://www.w3.org/2000/svg';

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const fixed = (n) => n.toFixed(2);

/* ------------------------------- geometry -------------------------------- */

/**
 * A stroke's points as perfect-freehand wants them: [x, y, pressure], no further apart
 * than DENSE_STEP. Saved strokes are thinned, and a straight run thinned to its two ends
 * is drawn at full width whatever its pressure, so points are put back along long runs.
 */
function densify(points, pressures) {
  const out = [];
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i], y = points[i + 1], p = pressures?.[i / 2] || 0.5;
    if (out.length) {
      const [px, py, pp] = out.at(-1);
      const n = Math.floor(Math.hypot(x - px, y - py) / DENSE_STEP);
      for (let k = 1; k < n; k++) out.push([px + ((x - px) * k) / n, py + ((y - py) * k) / n, pp + ((p - pp) * k) / n]);
    }
    out.push([x, y, p]);
  }
  return out;
}

/*
 * How a pen line is shaped: tldraw's settings for a pen with real pressure, which smooth
 * out the small wobble a tablet sensor adds. simulatePressure defaults to on, and then
 * replaces real pressure with a guess from speed. `size` is set so a line at a mouse's
 * pressure of 0.5 comes out at the stroke's own width.
 */
const PEN_EASING = (t) => t * 0.65 + Math.sin((t * Math.PI) / 2) * 0.35;
const penOptions = (width, last) => ({
  size: width / (2 * PEN_EASING(0.5)),
  thinning: 0.62, streamline: 0.62, smoothing: 0.62, easing: PEN_EASING, simulatePressure: false, last,
});

/** The smoothed centre of a pen line, which its outline is built around. */
const penPoints = (points, pressures, width, last) => getStrokePoints(densify(points, pressures), penOptions(width, last));

/** A pen stroke as a filled outline whose width follows the pressure along it. */
function outlineOf({ points, pressures, width }, last) {
  return outlinePath(getStrokeOutlinePoints(penPoints(points, pressures, width, last), penOptions(width, last)));
}

function outlinePath(outline) {
  if (outline.length < 4) return '';
  // Each outline point is a curve's control point, between midpoints. The shorter
  // smooth-curve (T) form reflects control points instead, and bulges out at the
  // tight turns of a line's ends, which fattens thin strokes.
  const mid = (a, b) => fixed((a + b) / 2);
  const end = outline.at(-1);
  let d = `M${mid(end[0], outline[0][0])},${mid(end[1], outline[0][1])}`;
  outline.forEach(([x, y], i) => {
    const [nx, ny] = outline[(i + 1) % outline.length];
    d += `Q${fixed(x)},${fixed(y)} ${mid(x, nx)},${mid(y, ny)}`;
  });
  return `${d}Z`;
}

/** A highlighter stroke: a smooth line through the points, curving through each midpoint. */
function centrelineOf(points) {
  const n = points.length / 2;
  const x = (i) => points[2 * i], y = (i) => points[2 * i + 1];
  if (!n) return '';
  // A tap still leaves a mark: a line too short to see, given round caps.
  if (n === 1) return `M${x(0)},${y(0)}h0.01`;
  let d = `M${x(0)},${y(0)}`;
  for (let i = 1; i < n - 1; i++) d += `Q${x(i)},${y(i)} ${fixed((x(i) + x(i + 1)) / 2)},${fixed((y(i) + y(i + 1)) / 2)}`;
  return `${d}L${x(n - 1)},${y(n - 1)}`;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * The colour a stroke shows on a dark page: the same invert(0.9) hue-rotate(180deg) the
 * page canvas gets in CSS, worked out here so the ink layer needs no filter of its own.
 * A filter on a page-sized layer would be redone on every frame of a stroke.
 */
const HUE_180 = [[-0.574, 1.43, 0.144], [0.426, 0.43, 0.144], [0.426, 1.43, -0.856]];
export function darkInk(hex) {
  const c = [1, 3, 5].map((i) => 0.9 - 0.8 * (parseInt(hex.slice(i, i + 2), 16) / 255));
  return `#${HUE_180.map((row) => Math.round(clamp(row[0] * c[0] + row[1] * c[1] + row[2] * c[2], 0, 1) * 255)
    .toString(16).padStart(2, '0')).join('')}`;
}

/* --------------------------------- ink ----------------------------------- */

export function createInk(host) {
  const d = {
    docId: null,
    ready: false,        // strokes loaded; drawing before then would wipe them on save
    pageDrawing: false,  // the pad takes ink whenever it is open; the pages only when this is on
    dark: false,
    notice: '',          // something worth saying for a moment
    noticeTimer: 0,
    problem: '',         // something that stays wrong until it is put right
    saved: false,        // something reached the server this visit
    ...loadPrefs(),      // tool, drawTool, colors, sizes
  };
  let pages = new Map();          // page -> strokes, oldest first; page 0 is the pad
  const layers = new Map();       // page -> its <svg>, while the page is rendered
  const paths = new WeakMap();    // stroke -> its <path> in the current layer
  const boxes = new WeakMap();    // stroke -> its bounds, for a quick miss when erasing
  let undoStack = [], redoStack = [];
  let gesture = null;             // the stroke being drawn, or the swipe being erased
  const dirty = new Set();
  let saveTimer = 0;
  let saving = Promise.resolve(); // every save waits for the one before it
  let inFlight = 0;
  let loads = 0;                  // the latest load; an older one's answer is ignored
  let loading = false;

  function loadPrefs() {
    const prefs = {
      tool: 'pen', drawTool: 'pen',
      colors: { pen: PALETTES.pen[0].value, highlighter: PALETTES.highlighter[0].value },
      sizes: { pen: 'medium', highlighter: 'medium' },
    };
    try {
      const saved = JSON.parse(localStorage.getItem('spr:ink') || '{}');
      if (TOOLS.includes(saved.tool)) prefs.tool = prefs.drawTool = saved.tool;
      for (const tool of TOOLS) {
        if (PALETTES[tool].some((c) => c.value === saved.colors?.[tool])) prefs.colors[tool] = saved.colors[tool];
        if (SIZES.includes(saved.sizes?.[tool])) prefs.sizes[tool] = saved.sizes[tool];
      }
    } catch { /* private mode, or nothing readable */ }
    return prefs;
  }

  function savePrefs() {
    try {
      // The eraser is never where a fresh visit should start, so the drawing tool is kept.
      localStorage.setItem('spr:ink', JSON.stringify({ tool: d.drawTool, colors: d.colors, sizes: d.sizes }));
    } catch { /* private mode */ }
  }

  function notify(message) {
    d.notice = message;
    clearTimeout(d.noticeTimer);
    d.noticeTimer = setTimeout(() => { d.notice = ''; host.onChange(); }, NOTICE_MS);
    host.onChange();
  }

  const listOf = (page) => {
    let list = pages.get(page);
    if (!list) pages.set(page, (list = []));
    return list;
  };

  /* ------------------------------ layers ------------------------------ */

  /** The ink layer for a page `w` by `h` units, kept across re-renders and zooms. */
  function layer(page, w, h) {
    let svg = layers.get(page);
    if (!svg) {
      svg = document.createElementNS(SVG_NS, 'svg');
      svg.classList.add('ink-layer');
      svg.dataset.page = String(page);
      svg.setAttribute('aria-hidden', 'true');
      // A PDF page box is exactly the page's shape; the pad's height follows its viewBox.
      if (page !== PAD) svg.setAttribute('preserveAspectRatio', 'none');
      // Highlighter under pen, whatever order they went down in, so a highlight never
      // paints over writing.
      svg.append(document.createElementNS(SVG_NS, 'g'), document.createElementNS(SVG_NS, 'g'));
      layers.set(page, svg);
      fill(page);
    }
    const box = `0 0 ${w} ${h}`;
    if (svg.getAttribute('viewBox') !== box) svg.setAttribute('viewBox', box);
    return svg;
  }

  /** The page has been released; a stroke still in progress on it ends here. */
  function release(page) {
    if (gesture?.page === page) finish();
    layers.delete(page);
  }

  const groupFor = (svg, stroke) => svg.children[stroke.tool === 'highlighter' ? 0 : 1];

  function paint(path, stroke, last = true) {
    colour(path, stroke);
    path.setAttribute('d', stroke.tool === 'pen' ? outlineOf(stroke, last) : centrelineOf(stroke.points));
  }

  /** A pen line is a filled outline; a highlighter's is a wide stroke. */
  function colour(path, stroke) {
    const color = d.dark ? darkInk(stroke.color) : stroke.color;
    if (stroke.tool === 'pen') {
      path.setAttribute('fill', color);
    } else {
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', String(stroke.width));
    }
  }

  function pathFor(stroke) {
    const path = document.createElementNS(SVG_NS, 'path');
    paint(path, stroke);
    paths.set(stroke, path);
    return path;
  }

  /** Draw a page's layer afresh from its strokes. */
  function fill(page) {
    const svg = layers.get(page);
    if (!svg) return;
    for (const g of svg.children) g.replaceChildren();
    for (const stroke of pages.get(page) ?? []) groupFor(svg, stroke).append(pathFor(stroke));
    if (gesture?.stroke && gesture.page === page) groupFor(svg, gesture.stroke).append(...gesture.pieces, gesture.path);
  }

  /** How far down a page its ink reaches, in units: what the pad grows from. */
  function extent(page) {
    let bottom = 0;
    for (const stroke of pages.get(page) ?? []) bottom = Math.max(bottom, boxOf(stroke).y1);
    return bottom;
  }

  function boxOf(stroke) {
    let box = boxes.get(stroke);
    if (!box) {
      const p = stroke.points;
      box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (let i = 0; i < p.length; i += 2) {
        box.x0 = Math.min(box.x0, p[i]); box.x1 = Math.max(box.x1, p[i]);
        box.y0 = Math.min(box.y0, p[i + 1]); box.y1 = Math.max(box.y1, p[i + 1]);
      }
      const reach = stroke.width * (stroke.pressures ? 0.8 : 0.5);
      box.x0 -= reach; box.y0 -= reach; box.x1 += reach; box.y1 += reach;
      boxes.set(stroke, box);
    }
    return box;
  }

  /* ------------------------------ drawing ----------------------------- */

  const live = (svg) => Number(svg.dataset.page) === PAD || d.pageDrawing;

  /** Screen to page units for `page`, measured once for a batch of samples. */
  function projector(page) {
    const svg = layers.get(page);
    if (!svg?.isConnected) return null;
    const r = svg.getBoundingClientRect();
    const box = svg.viewBox.baseVal;
    if (!r.width || !r.height || !box?.width) return null;
    const sx = box.width / r.width, sy = box.height / r.height;
    const project = (ev) => [round1((ev.clientX - r.left) * sx), round1((ev.clientY - r.top) * sy)];
    project.scale = r.width / box.width; // screen pixels per unit
    return project;
  }

  const samplesOf = (e) => {
    const list = e.getCoalescedEvents?.();
    return list?.length ? list : [e];
  };

  function startStroke(e, page) {
    if ((pages.get(page)?.length ?? 0) >= LIMITS.strokes) {
      return notify('This page is full of ink. Erase some to draw more.');
    }
    const tool = d.drawTool;
    gesture = liveStroke(e.pointerId, page, e.pointerType === 'pen',
      { tool, color: d.colors[tool], width: WIDTHS[tool][d.sizes[tool]], points: [], pressures: [] });
    addSamples(e);
  }

  function liveStroke(id, page, pen, stroke) {
    const g = {
      id, page, pen, stroke, scale: 1,
      from: 0,          // first sample of the piece being drawn
      pieces: [],       // pieces already drawn, left alone while the pen moves on
      predicted: [],    // where the browser expects the pen next, until the next sample
      path: document.createElementNS(SVG_NS, 'path'),
    };
    colour(g.path, stroke);
    groupFor(layers.get(page), stroke).append(g.path);
    return g;
  }

  /** A stretch of a stroke, samples `from` to `to`, to be drawn on its own. */
  const stretch = (stroke, from, to) => ({
    ...stroke, points: stroke.points.slice(2 * from, 2 * to), pressures: stroke.pressures.slice(from, to),
  });

  /**
   * Draw the stroke in progress. Only its newest piece changes: every PIECE samples the
   * piece is finished and left alone, and the next starts on its last two samples so the
   * round ends overlap. A long line then costs no more to extend than a short one. The tip
   * runs out to where the browser predicts the pen will be, which hides a frame or so of
   * the delay between pen and screen.
   */
  function renderLive() {
    const g = gesture;
    if (!g?.stroke) return;
    if (g.stroke.tool === 'pen') return renderLivePen(g);
    const count = g.stroke.points.length / 2;
    if (count - g.from > PIECE) {
      paint(g.path, stretch(g.stroke, g.from, count), true);
      nextPiece(g, count - 2);
    }
    const live = stretch(g.stroke, g.from, count);
    for (const [x, y] of g.predicted) {
      live.points.push(x, y);
      live.pressures.push(live.pressures.at(-1));
    }
    paint(g.path, live, false);
  }

  /**
   * A pen line is smoothed as a whole and then cut, so its pieces are slices of one
   * smoothing pass, and where they meet is exactly where the finished line runs. Cutting
   * the samples instead would restart the smoothing at every join and leave a kink.
   */
  function renderLivePen(g) {
    const { stroke } = g;
    const real = penPoints(stroke.points, stroke.pressures, stroke.width, false);
    if (real.length - g.from > PIECE) {
      g.path.setAttribute('d', outlinePath(getStrokeOutlinePoints(real.slice(g.from), penOptions(stroke.width, true))));
      nextPiece(g, real.length - 2);
    }
    let line = real;
    if (g.predicted.length) {
      const points = [...stroke.points], pressures = [...stroke.pressures];
      for (const [x, y] of g.predicted) points.push(x, y), pressures.push(pressures.at(-1));
      line = penPoints(points, pressures, stroke.width, false);
    }
    g.path.setAttribute('d', outlinePath(getStrokeOutlinePoints(line.slice(g.from), penOptions(stroke.width, false))));
  }

  /** Leave the current piece as it is and start the next at `from`. */
  function nextPiece(g, from) {
    g.pieces.push(g.path);
    g.from = from;
    g.path = document.createElementNS(SVG_NS, 'path');
    colour(g.path, g.stroke);
    groupFor(layers.get(g.page), g.stroke).append(g.path);
  }

  function addSamples(e) {
    const project = projector(gesture.page);
    if (!project) return;
    gesture.scale = project.scale;
    const minStep = MIN_STEP_PX / project.scale;

    for (const ev of samplesOf(e)) {
      const [x, y] = project(ev);
      let { points, pressures } = gesture.stroke;
      const n = points.length;
      if (n && Math.hypot(x - points[n - 2], y - points[n - 1]) < minStep) continue;

      if (n / 2 >= LIMITS.points) {
        // A stroke at its limit is carried on by a fresh one from the same spot.
        const was = gesture;
        endStroke(was);
        gesture = liveStroke(was.id, was.page, was.pen,
          { ...was.stroke, points: points.slice(-2), pressures: pressures.slice(-1) });
        gesture.scale = was.scale;
        ({ points, pressures } = gesture.stroke);
      }

      // A pen touching down often says 0 at first; it takes the first real reading instead.
      const p = ev.pressure > 0 ? ev.pressure : (pressures.at(-1) ?? 0);
      if (p > 0) for (let i = 0; i < pressures.length && pressures[i] === 0; i++) pressures[i] = p;
      points.push(x, y);
      pressures.push(p);
    }
    gesture.predicted = (e.getPredictedEvents?.() ?? []).slice(0, 1).map(project);
    // Drawn now, in the event. Leaving it to requestAnimationFrame looks tidier and costs a
    // whole frame: pen to screen went from 6.8 ms to 23.7 ms in Chrome when it was tried.
    renderLive();
  }

  function endStroke(g) {
    const { page, stroke, path } = g;
    for (const piece of g.pieces) piece.remove();
    if (!stroke.points.length) return path.remove();

    // Pressure is kept from a pen, and from a "mouse" whose pressure really varies — some
    // tablet drivers say mouse — but not when every reading is the 0.5 a mouse sends.
    const prs = stroke.pressures;
    const varies = Math.max(...prs) - Math.min(...prs) > PRESSURE_RANGE;
    const real = (g.pen || varies) && prs.some((p) => p > 0 && Math.abs(p - 0.5) > 0.01);

    // A highlighter is one width throughout, so it has no use for pressure.
    if (real && stroke.tool === 'pen') stroke.pressures = prs;
    else delete stroke.pressures;
    // A pen line keeps every sample: its smoothing depends on how far apart they are, so
    // a thinned copy would be drawn a little differently from the line that was drawn.
    // A highlighter's plain centreline can be thinned without changing.
    if (stroke.tool === 'highlighter') stroke.points = simplify(stroke.points, null, SIMPLIFY_PX / g.scale).points;

    paint(path, stroke);
    paths.set(stroke, path);
    const list = listOf(page);
    record([{ type: 'add', page, stroke, index: list.length }]);
    list.push(stroke);
    changed(page);
  }

  /* ------------------------------ erasing ----------------------------- */

  function touches(stroke, x, y, radius) {
    const box = boxOf(stroke);
    if (x < box.x0 - radius || x > box.x1 + radius || y < box.y0 - radius || y > box.y1 + radius) return false;
    const reach = radius + stroke.width * (stroke.pressures ? 0.8 : 0.5);
    const p = stroke.points;
    if (p.length === 2) return Math.hypot(x - p[0], y - p[1]) <= reach;
    for (let i = 2; i < p.length; i += 2) {
      if (segmentDistance(x, y, p[i - 2], p[i - 1], p[i], p[i + 1]) <= reach) return true;
    }
    return false;
  }

  function eraseAt(page, x, y, radius) {
    const list = pages.get(page);
    if (!list) return;
    for (let i = list.length - 1; i >= 0; i--) {
      if (!touches(list[i], x, y, radius)) continue;
      const [stroke] = list.splice(i, 1);
      gesture.removed.push({ type: 'remove', page, stroke, index: i });
      paths.get(stroke)?.remove();
      changed(page);
    }
    if (!list.length) pages.delete(page);
  }

  function eraseAlong(e) {
    const g = gesture;
    // Whatever page is under the eraser now: a swipe may cross a page break.
    const svg = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.ink-layer');
    const page = svg && live(svg) ? Number(svg.dataset.page) : null;
    const project = page !== null && projector(page);
    if (!project) { g.last = null; return; }

    const radius = ERASER_PX / project.scale;
    for (const ev of samplesOf(e)) {
      const [x, y] = project(ev);
      const from = g.last?.page === page ? g.last : { x, y };
      // A quick swipe reports points far apart, so the gap between them is swept too.
      const steps = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / radius));
      for (let s = 1; s <= steps; s++) {
        eraseAt(page, from.x + ((x - from.x) * s) / steps, from.y + ((y - from.y) * s) / steps, radius);
      }
      g.last = { page, x, y };
    }
  }

  /* ------------------------------ gestures ---------------------------- */

  document.addEventListener('pointerdown', (e) => {
    const svg = e.target.closest?.('.ink-layer');
    if (!svg || gesture || !live(svg)) return;
    // The right button, a pen's barrel button or its eraser end rub out, whatever is picked.
    const rubbing = d.tool === 'eraser' || e.button === 2 || e.button === 5;
    if (e.button !== 0 && !rubbing) return;
    e.preventDefault(); // no text selection, no focus change
    if (!d.ready) {
      if (d.problem) notify(d.problem);
      return;
    }
    host.onStrokeStart();
    // Captured by the page, not the layer: re-appending a layer would drop the capture.
    try { svg.parentElement.setPointerCapture(e.pointerId); } catch { /* already gone */ }

    const page = Number(svg.dataset.page);
    if (rubbing) {
      gesture = { id: e.pointerId, page, removed: [], last: null };
      eraseAlong(e);
    } else {
      startStroke(e, page);
    }
  });

  window.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    // A pen lifted without a pointerup arrives as a move with nothing pressed.
    if (e.buttons === 0) return finish();
    if (gesture.stroke) addSamples(e);
    else eraseAlong(e);
  });

  // pointerup always reports zero pressure, so it ends the stroke without adding to it.
  const ended = (e) => { if (gesture && e.pointerId === gesture.id) finish(); };
  window.addEventListener('pointerup', ended);
  window.addEventListener('pointercancel', ended);

  // A barrel button is a right-click to the system; over live ink it erases instead.
  document.addEventListener('contextmenu', (e) => {
    const svg = e.target.closest?.('.ink-layer');
    if (gesture || (svg && live(svg))) e.preventDefault();
  });

  function finish() {
    const g = gesture;
    if (!g) return;
    gesture = null;
    if (g.stroke) endStroke(g);
    else if (g.removed.length) record(g.removed);
    host.onChange();
  }

  /* ---------------------------- undo / redo --------------------------- */

  function record(ops) {
    undoStack.push(ops);
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack = [];
  }

  function apply(op, forward) {
    const list = listOf(op.page);
    if ((op.type === 'add') === forward) list.splice(Math.min(op.index, list.length), 0, op.stroke);
    else {
      const i = list.indexOf(op.stroke);
      if (i !== -1) list.splice(i, 1);
    }
    if (!list.length) pages.delete(op.page);
    changed(op.page);
  }

  function step(from, to, forward) {
    if (gesture) finish();
    const ops = from.pop();
    if (!ops) return;
    for (const op of forward ? ops : [...ops].reverse()) apply(op, forward);
    to.push(ops);
    for (const page of new Set(ops.map((op) => op.page))) fill(page);
    host.onChange();
  }

  /** Wipe a page in one step that undo can bring back. */
  function clear(page) {
    if (gesture?.page === page) finish();
    const list = pages.get(page);
    if (!list?.length) return;
    // Last first, so undoing in reverse puts every stroke back where it was.
    record(list.map((stroke, index) => ({ type: 'remove', page, stroke, index })).reverse());
    pages.delete(page);
    changed(page);
    fill(page);
    host.onChange();
  }

  /* ------------------------------- saving ----------------------------- */

  function changed(page) {
    dirty.add(page);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flush(), SAVE_MS);
  }

  /**
   * Send every page changed since the last save. `keepalive` is for a tab that may be
   * going away: those requests outlive it, but the browser lets them carry only about
   * 64 KB between them, so the smallest pages go that way, up to `budget`, and the rest
   * go the ordinary way and take their chances.
   */
  function flush({ keepalive = false, budget = Infinity } = {}) {
    clearTimeout(saveTimer);
    if (!dirty.size || !d.docId) return saving;

    const docId = d.docId;
    // Each page as it stands right now; later changes make a later save.
    const batch = [];
    for (const page of dirty) {
      const body = JSON.stringify({ strokes: pages.get(page) ?? [] });
      if (body.length <= MAX_BODY) batch.push({ page, body });
      else notify(`${page === PAD ? 'The scratch pad' : `Page ${page}`} has too much ink to save. Erase some of it.`);
    }
    dirty.clear();

    let room = keepalive ? budget : 0;
    const now = [], queued = [];
    for (const item of batch.sort((a, b) => a.body.length - b.body.length)) {
      ((room -= item.body.length) >= 0 ? now : queued).push(item);
    }

    const send = async ({ page, body }, keepalive) => {
      inFlight++;
      try {
        await api.saveInk(docId, page, body, { keepalive });
        if (d.docId === docId) { d.saved = true; d.problem = ''; }
      } catch (err) {
        if (err.status >= 400 && err.status < 500) {
          notify(err.message); // refused outright; sending it again would be refused again
        } else if (d.docId === docId) {
          // Out of reach for now: the page goes again shortly, as it then stands.
          d.problem = 'Not saved yet. Trying again…';
          dirty.add(page);
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => flush(), RETRY_MS);
        }
      } finally {
        inFlight--;
        host.onChange();
      }
    };

    // A closing tab cannot wait its turn behind a request already in flight, so keepalive
    // requests go at once; everything else keeps to the one-at-a-time chain.
    const chained = saving.then(async () => { for (const item of queued) await send(item, false); });
    saving = Promise.all([chained, ...now.map((item) => send(item, true))]);
    host.onChange();
    return saving;
  }

  /* ---------------------------- open / close -------------------------- */

  async function load(docId) {
    const token = ++loads;
    loading = true;
    host.onChange();
    // A book closed a moment ago may still be saving; this has to read what it wrote.
    await saving;
    try {
      const rows = await api.getInk(docId);
      if (token !== loads) return;
      pages = new Map(rows.map((row) => [row.page, row.strokes]));
      d.ready = true;
      d.problem = '';
      for (const page of layers.keys()) fill(page);
    } catch {
      if (token !== loads) return;
      d.problem = "Couldn't load your drawings, so drawing is paused.";
    } finally {
      if (token === loads) loading = false;
      host.onChange();
    }
  }

  function open(docId) {
    d.docId = docId;
    load(docId);
  }

  function close() {
    finish();
    flush();
    loads++; // whatever is still loading belongs to the book being closed
    loading = false;
    d.docId = null;
    d.ready = false;
    d.problem = '';
    d.saved = false;
    pages = new Map();
    layers.clear();
    undoStack = [];
    redoStack = [];
    setPageDrawing(false);
    host.onChange();
  }

  /* ------------------------------ settings ---------------------------- */

  function setPageDrawing(on) {
    if (d.pageDrawing === on) return;
    d.pageDrawing = on;
    // A stroke in progress is kept, not thrown away, when the pen is put down mid-line.
    if (!on && gesture && gesture.page !== PAD) finish();
    if (on) retry();
    host.onChange();
  }

  /** Try loading again if the last attempt failed. */
  function retry() {
    if (d.docId && !d.ready && !loading) load(d.docId);
  }

  function setTool(tool) {
    if (tool !== 'eraser' && !TOOLS.includes(tool)) return;
    d.tool = tool;
    if (tool !== 'eraser') d.drawTool = tool;
    savePrefs();
    host.onChange();
  }

  // Picking a colour or a size while erasing means going back to drawing with it.
  function setColor(value) {
    d.colors[d.drawTool] = value;
    setTool(d.drawTool);
  }

  function setSize(size) {
    if (!SIZES.includes(size)) return;
    d.sizes[d.drawTool] = size;
    setTool(d.drawTool);
  }

  function setDark(on) {
    if (d.dark === on) return;
    d.dark = on;
    for (const page of layers.keys()) fill(page);
  }

  return {
    get pageDrawing() { return d.pageDrawing; },
    get tool() { return d.tool; },
    /** The tool whose colours and size the bar shows: the eraser hands back to it. */
    get drawTool() { return d.drawTool; },
    get color() { return d.colors[d.drawTool]; },
    get size() { return d.sizes[d.drawTool]; },
    get palette() { return PALETTES[d.drawTool]; },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    get ready() { return d.ready; },
    /** Ink that would be lost if the tab closed now. */
    get unsaved() { return dirty.size > 0 || inFlight > 0; },
    get status() {
      if (d.notice || d.problem) return d.notice || d.problem;
      if (dirty.size || inFlight) return 'Saving…';
      return d.saved ? 'Saved' : '';
    },
    get failing() { return Boolean(d.notice || d.problem); },
    layer,
    release,
    extent,
    open,
    close,
    flush,
    idle: () => saving,
    retry,
    clear,
    undo: () => step(undoStack, redoStack, false),
    redo: () => step(redoStack, undoStack, true),
    setPageDrawing,
    setTool,
    setColor,
    setSize,
    cycleSize: () => setSize(SIZES[(SIZES.indexOf(d.sizes[d.drawTool]) + 1) % SIZES.length]),
    setDark,
  };
}
