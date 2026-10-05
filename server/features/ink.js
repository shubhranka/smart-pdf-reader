import { ExplainError } from '../errors.js';
// The browser checks strokes by the same rules before it sends them, so one module
// holds them for both sides.
import { checkStrokes } from '../../public/ink-format.js';

/** One page's strokes, tidied for storage. Anything malformed is refused with a 400. */
export function checkInkPage(body) {
  const strokes = checkStrokes(body?.strokes);
  if (typeof strokes === 'string') throw new ExplainError(strokes, 400);
  return strokes;
}
