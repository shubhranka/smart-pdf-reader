import rough from '/vendor/roughjs/bundled/rough.esm.js';
import { palette, seedOf, watchTheme } from './diagram.js';

/**
 * Draws a mind map of a highlighted passage: a central topic, branches either side of
 * it, and each branch's leaves fanning outward.
 *
 * The model hands over a tree of labels only. Layout happens here, from label lengths,
 * so a long label grows its row instead of overlapping the next one.
 */

const NS = 'http://www.w3.org/2000/svg';

// Laid out at roughly the wide panel's width, so text renders close to 1:1 there and
// scales down on a phone.
const WIDTH = 760;
const CX = WIDTH / 2;
const PAD = 14;

const ROOT_RX = 66;
const ROOT_CHARS = 16;
const ROOT_LINE = 16;

const BRANCH_W = 118;
const BRANCH_GAP = 34;       // between the root's edge and a branch box
const BRANCH_CHARS = 15;
const BRANCH_LINE = 15;

const LEAF_GAP = 26;         // between a branch box and its leaves
const LEAF_CHARS = 20;
const LEAF_LINE = 14;
const LEAF_CHAR_W = 6.3;     // rough advance at the leaf font size, for underlines
const LEAF_SPACING = 8;

const BLOCK_GAP = 18;        // between one branch's block and the next

/** Greedy word wrap into at most `maxLines` lines, ending on an ellipsis if cut. */
export function wrap(label, maxChars, maxLines) {
  const lines = [];
  let line = '';
  for (let word of label.split(/\s+/).filter(Boolean)) {
    // A single word longer than a line is cut rather than allowed to overflow the box.
    if (word.length > maxChars) word = `${word.slice(0, maxChars - 1)}…`;
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1];
    kept[maxLines - 1] = `${last.slice(0, maxChars - 1).replace(/\s+\S*$/, '') || last.slice(0, maxChars - 1)}…`;
    return kept;
  }
  return lines;
}

function multiline(parent, x, y, lines, lineHeight, cls, anchor) {
  const el = document.createElementNS(NS, 'text');
  el.setAttribute('class', cls);
  el.setAttribute('text-anchor', anchor);
  lines.forEach((value, i) => {
    const span = document.createElementNS(NS, 'tspan');
    span.setAttribute('x', x);
    span.setAttribute('y', y + i * lineHeight);
    span.textContent = value;
    el.append(span);
  });
  parent.append(el);
  return el;
}

/**
 * Place every node. Branches split between the right (first half) and the left, each
 * side stacked top to bottom and centred on the root.
 */
export function layout(spec) {
  const rootLines = wrap(spec.root, ROOT_CHARS, 3);
  const root = {
    lines: rootLines,
    rx: ROOT_RX,
    ry: Math.max(28, rootLines.length * ROOT_LINE / 2 + 16),
  };

  const branches = spec.branches.map((b, i) => {
    const lines = wrap(b.label, BRANCH_CHARS, 3);
    const leaves = (b.children ?? []).map((c) => {
      const leafLines = wrap(c.label, LEAF_CHARS, 2);
      return { label: c.label, lines: leafLines, h: leafLines.length * LEAF_LINE + LEAF_SPACING };
    });
    const boxH = lines.length * BRANCH_LINE + 16;
    const leavesH = leaves.reduce((n, l) => n + l.h, 0);
    return { index: i, label: b.label, lines, leaves, boxH, blockH: Math.max(boxH, leavesH) };
  });

  const half = Math.ceil(branches.length / 2);
  const sides = [
    { dir: 1, items: branches.slice(0, half) },
    { dir: -1, items: branches.slice(half) },
  ];
  const sideHeight = (items) =>
    items.reduce((n, b) => n + b.blockH, 0) + Math.max(0, items.length - 1) * BLOCK_GAP;

  const height = PAD * 2 + Math.max(root.ry * 2, ...sides.map((s) => sideHeight(s.items)));
  root.cx = CX;
  root.cy = height / 2;

  for (const side of sides) {
    let y = (height - sideHeight(side.items)) / 2;
    for (const b of side.items) {
      b.dir = side.dir;
      const inner = CX + side.dir * (ROOT_RX + BRANCH_GAP);
      b.x = side.dir > 0 ? inner : inner - BRANCH_W;
      b.w = BRANCH_W;
      b.y = y + (b.blockH - b.boxH) / 2;
      b.h = b.boxH;

      const leafX = side.dir > 0 ? b.x + b.w + LEAF_GAP : b.x - LEAF_GAP;
      let ly = y + (b.blockH - b.leaves.reduce((n, l) => n + l.h, 0)) / 2;
      for (const leaf of b.leaves) {
        leaf.x = leafX;
        leaf.y = ly;
        leaf.w = Math.max(...leaf.lines.map((l) => l.length)) * LEAF_CHAR_W;
        ly += leaf.h;
      }
      y += b.blockH + BLOCK_GAP;
    }
  }

  return { root, branches, width: WIDTH, height };
}

/** A soft S-curve between two points, drawn horizontally out and in. */
function connector(rc, x1, y1, x2, y2, options) {
  const mx = (x1 + x2) / 2;
  return rc.path(`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`, options);
}

/**
 * Draw `spec` into `container`. Leaves the container empty when there is nothing to map.
 *
 * @param {object} spec        {title, root, branches: [{label, children: [{label}]}]}
 * @param {Element} container
 */
export function renderMindmap(spec, container) {
  watchTheme(container, () => renderMindmap(spec, container));
  if (!spec?.root || !spec?.branches?.length) return;

  const view = layout(spec);
  const colour = palette();
  const { root } = view;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${view.width} ${view.height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label',
    `Mind map of ${spec.root}: ${view.branches.map((b) => b.label).join(', ')}`);
  container.append(svg);

  const rc = rough.svg(svg);
  const line = { stroke: colour.dim, strokeWidth: 1.3, roughness: 1 };

  // Lines first, so every shape sits on top of the line that reaches it.
  for (const b of view.branches) {
    const inner = b.dir > 0 ? b.x : b.x + b.w;
    const outer = b.dir > 0 ? b.x + b.w : b.x;
    const by = b.y + b.h / 2;

    // Leave the root from the point on its ellipse that faces the branch.
    const angle = Math.atan2(by - root.cy, inner - root.cx);
    const sx = root.cx + root.rx * Math.cos(angle);
    const sy = root.cy + root.ry * Math.sin(angle);
    svg.append(connector(rc, sx, sy, inner, by, {
      ...line, strokeWidth: 1.6, seed: seedOf(`root->${b.label}`),
    }));

    for (const leaf of b.leaves) {
      const underY = leaf.y + leaf.lines.length * LEAF_LINE + 2;
      svg.append(connector(rc, outer, by, leaf.x, underY, { ...line, seed: seedOf(`${b.label}->${leaf.label}`) }));
      svg.append(rc.line(leaf.x, underY, leaf.x + b.dir * leaf.w, underY, {
        ...line, stroke: colour.accent, strokeWidth: 1.1, seed: seedOf(`under:${leaf.label}`),
      }));
    }
  }

  const rootGroup = document.createElementNS(NS, 'g');
  rootGroup.setAttribute('class', 'mm-root');
  svg.append(rootGroup);
  rootGroup.append(rc.ellipse(root.cx, root.cy, root.rx * 2, root.ry * 2, {
    stroke: colour.accent, fill: colour.soft, fillStyle: 'solid',
    strokeWidth: 2, roughness: 1.2, seed: seedOf(`root:${spec.root}`),
  }));
  multiline(rootGroup, root.cx,
    root.cy - ((root.lines.length - 1) * ROOT_LINE) / 2 + 5,
    root.lines, ROOT_LINE, 'mm-root-label', 'middle');

  for (const b of view.branches) {
    const group = document.createElementNS(NS, 'g');
    group.setAttribute('class', 'mm-branch');
    svg.append(group);
    group.append(rc.rectangle(b.x, b.y, b.w, b.h, {
      stroke: colour.accent, fill: colour.soft, fillStyle: 'hachure',
      hachureGap: 5, fillWeight: 1.2, strokeWidth: 1.5, roughness: 1.1,
      seed: seedOf(`branch:${b.label}`),
    }));
    multiline(group, b.x + b.w / 2,
      b.y + b.h / 2 - ((b.lines.length - 1) * BRANCH_LINE) / 2 + 4.5,
      b.lines, BRANCH_LINE, 'mm-branch-label', 'middle');

    for (const leaf of b.leaves) {
      multiline(svg, leaf.x, leaf.y + LEAF_LINE - 3, leaf.lines, LEAF_LINE, 'mm-leaf', b.dir > 0 ? 'start' : 'end');
    }
  }
}
