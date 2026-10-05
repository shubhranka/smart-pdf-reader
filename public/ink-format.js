/*
 * What a stroke of ink is, shared by the browser (ink.js), the server (features/ink.js)
 * and the tests. No DOM and no imports, so Node loads it exactly as the browser does.
 *
 * A stroke is { tool, color, width, points: [x0, y0, x1, y1, …], pressures?: [p0, p1, …] }
 * in its page's unscaled units — PDF points, the size the page has at 100% — so zooming
 * never touches it. `pressures` is there only when a pen reported real pressure.
 */

export const TOOLS = ['pen', 'highlighter'];
export const SIZES = ['fine', 'medium', 'bold'];

/** Widths in page units: 1.8pt is a fine-liner, and 12pt covers a line of body text. */
export const WIDTHS = {
  pen: { fine: 1.2, medium: 1.8, bold: 3 },
  highlighter: { fine: 8, medium: 12, bold: 18 },
};

export const LIMITS = {
  strokes: 5000,  // per page
  points: 4000,   // per stroke; a longer one is carried on in a new stroke
  coord: 1e5,     // generous, since a stroke may run off the edge of its page
  minWidth: 0.5,
  maxWidth: 40,
};

// A point stays when its pressure strays this far from the straight-line estimate.
const PRESSURE_DRIFT = 0.08;
const COLOR = /^#[0-9a-f]{6}$/i;

/** A tenth of a point is finer than any pen. */
export const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / len2, 0), 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Drop the points that sit within `tolerance` of the line through their neighbours
 * (Ramer–Douglas–Peucker). A point whose pressure strays from the estimate between its
 * neighbours counts as far off the line, so a pen pressed harder mid-stroke keeps it.
 * Returns `{ points, pressures }`, with `pressures` null when none came in.
 */
export function simplify(points, pressures, tolerance) {
  const n = points.length / 2;
  if (n < 3) return { points, pressures };

  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let worst = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      let d = segmentDistance(points[2 * i], points[2 * i + 1], points[2 * a], points[2 * a + 1], points[2 * b], points[2 * b + 1]);
      if (pressures) {
        const expected = pressures[a] + (pressures[b] - pressures[a]) * ((i - a) / (b - a));
        d = Math.max(d, (Math.abs(pressures[i] - expected) / PRESSURE_DRIFT) * tolerance);
      }
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }

  const out = { points: [], pressures: pressures ? [] : null };
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    out.points.push(points[2 * i], points[2 * i + 1]);
    out.pressures?.push(pressures[i]);
  }
  return out;
}

/**
 * A stroke tidied for storage, or a string saying what is wrong with it. Coordinates are
 * rounded to a tenth of a point and pressures to a hundredth, which keeps a page small.
 */
export function checkStroke(s) {
  if (!s || typeof s !== 'object') return 'A stroke must be an object.';
  if (!TOOLS.includes(s.tool)) return `There is no "${s.tool}" tool.`;
  if (typeof s.color !== 'string' || !COLOR.test(s.color)) return 'A colour must look like #rrggbb.';

  const width = Number(s.width);
  if (!Number.isFinite(width) || width < LIMITS.minWidth || width > LIMITS.maxWidth) {
    return `A stroke is ${LIMITS.minWidth} to ${LIMITS.maxWidth} units wide.`;
  }

  const { points, pressures } = s;
  if (!Array.isArray(points) || points.length < 2 || points.length % 2) return 'A stroke needs x, y pairs.';
  if (points.length / 2 > LIMITS.points) return `A stroke holds at most ${LIMITS.points} points.`;
  if (!points.every((v) => Number.isFinite(v) && Math.abs(v) <= LIMITS.coord)) {
    return 'Stroke points must be finite numbers.';
  }

  const out = { tool: s.tool, color: s.color.toLowerCase(), width: round2(width), points: points.map(round1) };
  if (pressures != null) {
    if (!Array.isArray(pressures) || pressures.length !== points.length / 2) return 'A stroke needs one pressure per point.';
    if (!pressures.every((p) => Number.isFinite(p) && p >= 0 && p <= 1)) return 'Pressures run from 0 to 1.';
    out.pressures = pressures.map(round2);
  }
  return out;
}

/** A page's strokes tidied for storage, or a string saying what is wrong. */
export function checkStrokes(list) {
  if (!Array.isArray(list)) return '`strokes` must be a list.';
  if (list.length > LIMITS.strokes) return `A page holds at most ${LIMITS.strokes} strokes.`;
  const out = [];
  for (const stroke of list) {
    const tidy = checkStroke(stroke);
    if (typeof tidy === 'string') return tidy;
    out.push(tidy);
  }
  return out;
}
