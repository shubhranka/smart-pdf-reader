import rough from '/vendor/roughjs/bundled/rough.esm.js';

/**
 * Draws a recap's diagram.
 *
 * The model hands over a small typed graph — nodes and labelled edges — and never
 * coordinates or SVG. Layout is decided here, where the panel's real width is known
 * and where a bad guess cannot produce a broken picture.
 */

const NS = 'http://www.w3.org/2000/svg';

// The drawing is laid out wider than the panel and scaled down to fit, which buys a
// gutter for links that skip a row without squeezing the boxes.
const WIDTH = 400;
const NODE_W = 244;
const NODE_H = 46;
const ROW_GAP = 40;       // vertical room for an edge and its label
const PAD = 10;

/** rough.js bakes literal colours into its paths, so they have to be read each draw. */
function palette() {
  const style = getComputedStyle(document.documentElement);
  const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  return {
    accent: read('--accent', '#b44a1e'),
    soft: read('--accent-soft', '#fbeade'),
    border: read('--border', '#dedcd5'),
    dim: read('--text-dim', '#6b6862'),
  };
}

/** A stable seed per shape, so redrawing does not re-randomise the sketch. */
function seedOf(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % 100000;
}

function text(parent, x, y, value, cls, anchor = 'middle') {
  const el = document.createElementNS(NS, 'text');
  el.setAttribute('x', x);
  el.setAttribute('y', y);
  el.setAttribute('text-anchor', anchor);
  el.setAttribute('class', cls);
  el.textContent = value;
  parent.append(el);
  return el;
}

/**
 * Order the nodes top to bottom by longest path from a root, so a flow reads in its
 * own direction. A graph with a cycle keeps its given order rather than drawing nothing.
 */
export function layout(spec) {
  const nodes = spec.nodes.map((n) => ({ ...n }));
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const incoming = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of spec.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);

  const depth = new Map(nodes.map((n) => [n.id, 0]));
  let queue = nodes.filter((n) => !incoming.get(n.id)).map((n) => n.id);
  if (!queue.length) queue = [nodes[0].id]; // every node has a parent: a cycle

  const seen = new Set(queue);
  for (let guard = 0; queue.length && guard < nodes.length + 1; guard++) {
    const next = [];
    for (const id of queue) {
      for (const e of spec.edges) {
        if (e.from !== id) continue;
        const d = depth.get(id) + 1;
        if (d > (depth.get(e.to) ?? 0)) depth.set(e.to, d);
        if (!seen.has(e.to)) { seen.add(e.to); next.push(e.to); }
      }
    }
    queue = next;
  }

  const order = [...nodes].sort((a, b) =>
    (depth.get(a.id) - depth.get(b.id)) || (index.get(a.id) - index.get(b.id)));

  order.forEach((node, row) => {
    node.w = NODE_W;
    node.h = NODE_H;
    node.x = (WIDTH - NODE_W) / 2;
    node.y = PAD + row * (NODE_H + ROW_GAP);
  });

  const placed = new Map(order.map((n) => [n.id, n]));
  return {
    nodes: order,
    edges: spec.edges.filter((e) => placed.has(e.from) && placed.has(e.to)),
    at: placed,
    width: WIDTH,
    height: PAD * 2 + order.length * NODE_H + (order.length - 1) * ROW_GAP,
  };
}

function arrowHead(parent, x1, y1, x2, y2, colour) {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const L = 8, W = 4;
  const poly = document.createElementNS(NS, 'polygon');
  poly.setAttribute('points', [
    `${x2},${y2}`,
    `${x2 - L * Math.cos(a) + W * Math.sin(a)},${y2 - L * Math.sin(a) - W * Math.cos(a)}`,
    `${x2 - L * Math.cos(a) - W * Math.sin(a)},${y2 - L * Math.sin(a) + W * Math.cos(a)}`,
  ].join(' '));
  poly.setAttribute('fill', colour);
  parent.append(poly);
}

/**
 * Draw `spec` into `container`. Leaves the container empty when the graph is unusable,
 * so a recap without a good diagram simply shows none.
 *
 * @param {object} spec           {kind, caption, nodes, edges}
 * @param {Element} container
 * @param {(page:number)=>void} [onGoToPage]  called when a node with a page is clicked
 * @param {(page:number)=>string} [pageLabel]  how to print a page number (the book's own)
 */
export function renderDiagram(spec, container, onGoToPage, pageLabel = String) {
  // A previous drawing in this slot has watchers on the theme; drop them first.
  container._diagramCleanup?.();
  container.replaceChildren();
  if (!spec?.nodes?.length || !spec?.edges?.length) return;

  /*
   * rough.js writes the colours it was given into the paths it generates, so a theme
   * change leaves the sketch in the old palette while the labels — plain text, styled
   * by CSS — follow the new one. Redraw instead.
   */
  const redraw = () => { if (container.isConnected) renderDiagram(spec, container, onGoToPage); };
  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  const observer = new MutationObserver(redraw);
  scheme.addEventListener('change', redraw);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  container._diagramCleanup = () => {
    scheme.removeEventListener('change', redraw);
    observer.disconnect();
    container._diagramCleanup = null;
  };

  const view = layout(spec);
  const colour = palette();

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${view.width} ${view.height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', spec.caption
    || `Diagram of ${view.nodes.map((n) => n.label).join(', ')}`);
  container.append(svg);

  const rc = rough.svg(svg);

  // Edges first, so a box always sits on top of the line that reaches it.
  for (const edge of view.edges) {
    const from = view.at.get(edge.from);
    const to = view.at.get(edge.to);
    const downward = to.y > from.y;

    const x1 = from.x + from.w / 2;
    const y1 = downward ? from.y + from.h : from.y;
    const x2 = to.x + to.w / 2;
    const y2 = downward ? to.y : to.y + to.h;

    // A link that skips a row would otherwise run straight through the boxes between,
    // so it bows out to the side instead.
    const skips = Math.abs(to.y - from.y) > NODE_H + ROW_GAP + 1;
    const seed = seedOf(`${edge.from}->${edge.to}`);

    if (skips) {
      // Bow out through the left gutter, so the line does not run through the boxes
      // in between, and sit the label on the apex where there is room for it.
      const side = from.x / 2 + 6;
      const midY = (y1 + y2) / 2;
      svg.append(rc.curve([[x1, y1], [side, midY], [x2, y2]], {
        stroke: colour.dim, strokeWidth: 1.3, roughness: 1, seed,
      }));
      if (edge.label) text(svg, side, midY - 6, edge.label, 'dg-edge');
    } else {
      svg.append(rc.line(x1, y1, x2, y2, {
        stroke: colour.dim, strokeWidth: 1.3, roughness: 1, seed,
      }));
      if (edge.label) text(svg, x1 + 6, (y1 + y2) / 2 + 4, edge.label, 'dg-edge', 'start');
    }
    arrowHead(svg, x1, y1, x2, y2, colour.dim);
  }

  for (const node of view.nodes) {
    const group = document.createElementNS(NS, 'g');
    group.setAttribute('class', node.page ? 'dg-node dg-node-link' : 'dg-node');
    svg.append(group);

    group.append(rc.rectangle(node.x, node.y, node.w, node.h, {
      stroke: colour.accent,
      fill: colour.soft,
      fillStyle: 'solid',
      strokeWidth: 1.5,
      roughness: 1.1,
      seed: seedOf(node.id),
    }));

    const cx = node.x + node.w / 2;
    text(group, cx, node.y + (node.page ? node.h / 2 : node.h / 2 + 5), node.label, 'dg-label');
    if (node.page) text(group, cx, node.y + node.h / 2 + 15, `p. ${pageLabel(node.page)}`, 'dg-page');

    if (node.page && onGoToPage) {
      group.setAttribute('tabindex', '0');
      group.setAttribute('role', 'button');
      group.setAttribute('aria-label', `${node.label} — go to page ${pageLabel(node.page)}`);
      group.addEventListener('click', () => onGoToPage(node.page));
      group.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onGoToPage(node.page); }
      });
    }
  }

  if (spec.caption) {
    const cap = document.createElement('p');
    cap.className = 'dg-caption';
    cap.textContent = spec.caption;
    container.append(cap);
  }
}
