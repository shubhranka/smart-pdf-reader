import * as pdfjsLib from '/vendor/pdfjs/build/pdf.mjs';
import { api, fileUrl, getDocument } from './api.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';

// Round stops for the buttons and keyboard. Pinching moves continuously between them.
const ZOOM_STOPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];
const MIN_ZOOM = ZOOM_STOPS[0];
const MAX_ZOOM = ZOOM_STOPS[ZOOM_STOPS.length - 1];
const PINCH_SENSITIVITY = 0.01;
const ZOOM_COMMIT_MS = 180;      // quiet time after a gesture before re-rendering sharply

const RENDER_BUFFER_PX = 1200;   // render this far beyond the viewport
const KEEP_RENDERED = 10;        // pages held in memory before the far ones are released
// A page at 500% on a retina screen would otherwise back a canvas of ~190 MB. These
// two caps trade a little sharpness at extreme zoom for a viewer that stays alive.
const MAX_CANVAS_PIXELS = 16_777_216;      // per page
const RENDER_BUDGET_PIXELS = 67_108_864;   // across every rendered page
const SAVE_DEBOUNCE_MS = 700;
const PROBE_RATIO = 0.35;        // "current page" = the one a third of the way down the viewport

const el = {
  reader: document.getElementById('reader'),
  container: document.getElementById('viewer-container'),
  viewer: document.getElementById('viewer'),
  title: document.getElementById('doc-title'),
  pageInput: document.getElementById('page-input'),
  pageCount: document.getElementById('page-count'),
  prev: document.getElementById('prev-page'),
  next: document.getElementById('next-page'),
  zoomIn: document.getElementById('zoom-in'),
  zoomOut: document.getElementById('zoom-out'),
  zoomLevel: document.getElementById('zoom-level'),
  back: document.getElementById('back-btn'),
  saveBadge: document.getElementById('save-badge'),
  explainBtn: document.getElementById('explain-btn'),
  panel: document.getElementById('panel'),
  panelKind: document.getElementById('panel-kind'),
  panelBody: document.getElementById('panel-body'),
  panelClose: document.getElementById('panel-close'),
  historyBtn: document.getElementById('history-btn'),
  history: document.getElementById('history'),
  historyList: document.getElementById('history-list'),
  historyEmpty: document.getElementById('history-empty'),
  historyClose: document.getElementById('history-close'),
  historyClear: document.getElementById('history-clear'),
};

/** Everything about the document currently open. Reset by `close()`. */
let state = null;
let onExit = () => {};

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/* ------------------------------ page geometry ----------------------------- */

/**
 * Two zooms are in play. `zoom` is what the canvases were actually rendered at;
 * `liveZoom` is what the reader currently sees. While a pinch is in flight they
 * differ, and the gap is taken up by a CSS transform on each page's inner wrapper —
 * scaling pixels we already have is instant, where re-rendering the PDF is not.
 * Once the gesture stops, `commitZoom` re-renders at the new size and the two match.
 */
/**
 * Each page carries its own unscaled size as a CSS variable and derives its box from
 * `--zoom` on the viewer. A pinch frame then costs two property writes instead of two
 * per page, which matters when the document has nine hundred of them.
 */
function sizeSlot(slot) {
  slot.el.style.setProperty('--base-w', slot.baseW);
  slot.el.style.setProperty('--base-h', slot.baseH);
}

function applyZoomVars() {
  el.viewer.style.setProperty('--zoom', state.liveZoom);
  // Each rendered page scales from the zoom it was actually drawn at, which is not
  // always the current one: after a commit, pages already on screen keep showing their
  // older rendering until a sharp one is ready, rather than blanking out.
  for (const slot of state.slots) {
    if (slot.inner) slot.inner.style.setProperty('--zoom-ratio', state.liveZoom / slot.renderedZoom);
  }
}

function sizeAllSlots() {
  for (const slot of state.slots) sizeSlot(slot);
  applyZoomVars();
}

function buildSlots(numPages, baseW, baseH) {
  el.viewer.replaceChildren();
  const slots = [];

  for (let num = 1; num <= numPages; num++) {
    const div = document.createElement('div');
    div.className = 'page placeholder';
    div.dataset.page = String(num);
    el.viewer.append(div);
    // Sized from page 1 up front so the scrollbar is right before anything renders;
    // each page corrects its own dimensions once it actually renders.
    slots.push({
      num, el: div, inner: null, baseW, baseH, renderedZoom: 0,
      rendered: false, rendering: null, text: '', textLayer: null, pixels: 0, lastSeen: 0,
    });
  }
  return slots;
}

async function renderPage(slot) {
  if (slot.rendering) return slot.rendering;
  if (slot.rendered && slot.renderedZoom === state.zoom) return undefined;

  slot.rendering = (async () => {
    const renderZoom = state.zoom;
    const page = await state.pdf.getPage(slot.num);
    const viewport = page.getViewport({ scale: renderZoom });

    // A zoom committed while we were awaiting makes this render stale.
    if (!state || state.zoom !== renderZoom) return;

    const canvas = document.createElement('canvas');
    const area = viewport.width * viewport.height;
    // Drop below device pixel ratio only once a page would blow the per-canvas cap.
    const outputScale = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / area));
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const task = page.render({
      canvas,
      viewport,
      transform: [outputScale, 0, 0, outputScale, 0, 0],
    });

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerDiv,
      viewport,
    });

    await Promise.all([task.promise, textLayer.render()]);
    if (!state || state.zoom !== renderZoom) return;

    // Canvas and text layer live together in a wrapper so one transform scales both,
    // keeping selection lined up with the glyphs during a pinch.
    const inner = document.createElement('div');
    inner.className = 'page-inner';
    inner.style.width = canvas.style.width;
    inner.style.height = canvas.style.height;
    inner.append(canvas, textLayerDiv);

    const tag = document.createElement('div');
    tag.className = 'page-number-tag';
    tag.textContent = String(slot.num);

    // The text layer positions itself for the zoom it was built at, so this var
    // tracks the committed zoom, never the live one.
    slot.el.style.setProperty('--scale-factor', renderZoom);
    slot.el.style.setProperty('--total-scale-factor', renderZoom);
    slot.el.classList.remove('placeholder');
    slot.el.replaceChildren(inner, tag);

    slot.inner = inner;
    slot.baseW = viewport.width / renderZoom;
    slot.baseH = viewport.height / renderZoom;
    slot.text = textLayer.textContentItemsStr.join(' ').replace(/\s+/g, ' ').trim();
    slot.textLayer = textLayer;
    slot.pixels = canvas.width * canvas.height;
    slot.rendered = true;
    slot.renderedZoom = renderZoom;
    sizeSlot(slot);
    applyZoomVars();
    drawHighlight(slot); // survives zooming and scrolling away and back
  })().finally(() => { slot.rendering = null; });

  return slot.rendering;
}

function releasePage(slot) {
  if (!slot.rendered) return;
  slot.textLayer?.cancel();
  slot.textLayer = null;
  slot.inner = null;
  slot.renderedZoom = 0;
  slot.pixels = 0;
  slot.rendered = false;
  slot.el.classList.add('placeholder');
  slot.el.replaceChildren();
  // Keep text: it is the context for explanations and costs nothing to hold.
}

function updateVisiblePages() {
  if (!state) return;

  const top = el.container.scrollTop - RENDER_BUFFER_PX;
  const bottom = el.container.scrollTop + el.container.clientHeight + RENDER_BUFFER_PX;
  const now = performance.now();
  const wanted = [];

  for (const slot of state.slots) {
    const slotTop = slot.el.offsetTop;
    const slotBottom = slotTop + slot.el.offsetHeight;
    if (slotBottom >= top && slotTop <= bottom) {
      slot.lastSeen = now;
      wanted.push(slot);
    }
  }

  // Mid-pinch there is no point rendering at a zoom we are about to leave.
  if (state.liveZoom === state.zoom) {
    for (const slot of wanted) renderPage(slot).catch(() => {});
  }

  // Release the pages we drifted furthest from, by count and by memory, so that
  // neither a 900-page PDF nor a handful of pages at 500% can run the tab out of room.
  const onScreen = new Set(wanted);
  const rendered = state.slots.filter((s) => s.rendered).sort((a, b) => a.lastSeen - b.lastSeen);
  let count = rendered.length;
  let pixels = rendered.reduce((total, s) => total + s.pixels, 0);

  for (const slot of rendered) {
    if (count <= KEEP_RENDERED && pixels <= RENDER_BUDGET_PIXELS) break;
    if (onScreen.has(slot)) continue; // never drop what the reader is looking at
    pixels -= slot.pixels;
    count--;
    releasePage(slot);
  }
}

/** Drop rendered pages outside the render window, keeping what is on screen visible. */
function releaseOffScreen() {
  const top = el.container.scrollTop - RENDER_BUFFER_PX;
  const bottom = el.container.scrollTop + el.container.clientHeight + RENDER_BUFFER_PX;
  for (const slot of state.slots) {
    const slotTop = slot.el.offsetTop;
    if (slotTop + slot.el.offsetHeight < top || slotTop > bottom) releasePage(slot);
  }
}

/* ------------------------------ progress ---------------------------------- */

function locate() {
  const probe = el.container.scrollTop + el.container.clientHeight * PROBE_RATIO;

  // First page whose bottom is past the probe. Picking it this way means the gaps
  // between pages count as the page below, rather than matching nothing.
  for (const slot of state.slots) {
    const top = slot.el.offsetTop;
    const height = slot.el.offsetHeight;
    if (probe < top + height) {
      return { page: slot.num, offsetPct: clamp((probe - top) / height, 0, 1) };
    }
  }
  return { page: state.slots.length, offsetPct: 1 };
}

function scrollToPage(page, offsetPct = 0, behavior = 'auto') {
  const slot = state.slots[clamp(page, 1, state.slots.length) - 1];
  if (!slot) return;
  const target = slot.el.offsetTop + 1 + slot.el.offsetHeight * offsetPct - el.container.clientHeight * PROBE_RATIO;
  el.container.scrollTo({ top: Math.max(0, target), behavior });
}

function flashSaved() {
  el.saveBadge.hidden = false;
  clearTimeout(state.badgeTimer);
  // Restart the CSS animation from the top on every save.
  el.saveBadge.style.animation = 'none';
  void el.saveBadge.offsetWidth;
  el.saveBadge.style.animation = '';
  state.badgeTimer = setTimeout(() => { el.saveBadge.hidden = true; }, 1600);
}

function queueSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(async () => {
    const { page, offsetPct } = locate();
    if (page === state.savedPage && Math.abs(offsetPct - state.savedOffset) < 0.02) return;
    try {
      await api.saveProgress(state.docId, page, offsetPct);
      state.savedPage = page;
      state.savedOffset = offsetPct;
      // flashSaved();
    } catch { /* a failed save just means we try again on the next scroll */ }
  }, SAVE_DEBOUNCE_MS);
}

function syncPageIndicator() {
  const { page } = locate();
  if (page !== state.currentPage) {
    state.currentPage = page;
    if (document.activeElement !== el.pageInput) el.pageInput.value = String(page);
    el.prev.disabled = page <= 1;
    el.next.disabled = page >= state.slots.length;
  }
}

/* --------------------------------- zoom ----------------------------------- */

/** Nearest stop in `direction` (+1 in, -1 out) from the current zoom. */
function nextZoomStop(direction) {
  const current = state.liveZoom;
  const stops = direction > 0 ? ZOOM_STOPS : [...ZOOM_STOPS].reverse();
  // A tolerance keeps a zoom restored from storage from sticking between stops.
  return stops.find((z) => (direction > 0 ? z > current + 0.001 : z < current - 0.001)) ?? current;
}

/**
 * Remember which point of which page sits under a screen position, so the same
 * point can be put back there after the pages change size. Anchoring to a page
 * rather than to raw scroll offsets keeps it exact: the gaps between pages and
 * the viewer's padding do not scale with zoom.
 */
function anchorAt(clientX, clientY) {
  const rect = el.container.getBoundingClientRect();
  const px = clamp(clientX - rect.left, 0, el.container.clientWidth);
  const py = clamp(clientY - rect.top, 0, el.container.clientHeight);
  const docY = el.container.scrollTop + py;
  const docX = el.container.scrollLeft + px;

  let slot = state.slots[0];
  for (const candidate of state.slots) {
    slot = candidate;
    if (docY < candidate.el.offsetTop + candidate.el.offsetHeight) break;
  }

  return {
    slot,
    fracX: (docX - slot.el.offsetLeft) / slot.el.offsetWidth,
    fracY: (docY - slot.el.offsetTop) / slot.el.offsetHeight,
    px, py,
  };
}

function restoreAnchor(anchor) {
  const { slot, fracX, fracY, px, py } = anchor;
  el.container.scrollTop = Math.max(0, slot.el.offsetTop + slot.el.offsetHeight * fracY - py);
  el.container.scrollLeft = Math.max(0, slot.el.offsetLeft + slot.el.offsetWidth * fracX - px);
}

function centreAnchor() {
  const rect = el.container.getBoundingClientRect();
  return anchorAt(rect.left + el.container.clientWidth / 2, rect.top + el.container.clientHeight * PROBE_RATIO);
}

function updateZoomControls() {
  el.zoomLevel.textContent = `${Math.round(state.liveZoom * 100)}%`;
  el.zoomIn.disabled = state.liveZoom >= MAX_ZOOM - 0.001;
  el.zoomOut.disabled = state.liveZoom <= MIN_ZOOM + 0.001;
}

/** Resize on screen straight away; the sharp re-render follows once the gesture stops. */
function previewZoom(next, anchor) {
  const target = clamp(Number(next.toFixed(3)), MIN_ZOOM, MAX_ZOOM);
  if (target === state.liveZoom) return;

  state.liveZoom = target;
  applyZoomVars();
  restoreAnchor(anchor);
  updateZoomControls();

  // Storage and the sharp re-render both wait for the gesture to settle.
  clearTimeout(state.zoomCommitTimer);
  state.zoomCommitTimer = setTimeout(commitZoom, ZOOM_COMMIT_MS);
}

/** Re-render every page at the zoom now showing, so scaled-up pixels turn sharp again. */
function commitZoom() {
  if (!state || state.liveZoom === state.zoom) return;

  const anchor = centreAnchor();
  state.zoom = state.liveZoom;
  localStorage.setItem('spr:zoom', String(state.zoom));
  // Pages off screen are dropped now; the ones in view are replaced as their sharper
  // renders land, so nothing flashes blank mid-zoom.
  releaseOffScreen();
  sizeAllSlots();
  restoreAnchor(anchor);
  updateVisiblePages();
  syncPageIndicator();
}

/** Jump straight to a zoom level — the buttons, the keyboard and the ladder. */
function setZoom(next, anchor = centreAnchor()) {
  const target = clamp(Number(next.toFixed(3)), MIN_ZOOM, MAX_ZOOM);
  if (target === state.liveZoom) return;

  clearTimeout(state.zoomCommitTimer);
  state.liveZoom = target;
  updateZoomControls();
  localStorage.setItem('spr:zoom', String(target));

  state.zoom = target;
  releaseOffScreen();
  sizeAllSlots();
  restoreAnchor(anchor);
  updateVisiblePages();
  syncPageIndicator();
}

/* ------------------------------- highlight -------------------------------- */

/**
 * Locate a phrase inside a rendered text layer and hand back a Range over it.
 *
 * PDF text layers split a line into many spans and break words across them, so the
 * phrase is matched against the layer's whole text rather than any single span. Two
 * passes: first with runs of whitespace flattened to one space, then with whitespace
 * dropped altogether — which catches the case where a line break sits mid-word and
 * one side of the comparison has a space the other does not.
 */
function findPhrase(root, phrase) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let spaced = '', tight = '';
  const spacedMap = [], tightMap = [];
  let atSpace = true;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const value = node.nodeValue ?? '';
    for (let i = 0; i < value.length; i++) {
      const ch = value[i];
      if (/\s/.test(ch)) {
        if (!atSpace) { spaced += ' '; spacedMap.push({ node, offset: i }); atSpace = true; }
      } else {
        const lower = ch.toLowerCase();
        spaced += lower; spacedMap.push({ node, offset: i });
        tight += lower; tightMap.push({ node, offset: i });
        atSpace = false;
      }
    }
  }

  const attempts = [
    [spaced, spacedMap, phrase.trim().replace(/\s+/g, ' ').toLowerCase()],
    [tight, tightMap, phrase.replace(/\s+/g, '').toLowerCase()],
  ];

  for (const [haystack, map, needle] of attempts) {
    if (!needle) continue;
    const at = haystack.indexOf(needle);
    if (at === -1) continue;

    const first = map[at];
    const last = map[at + needle.length - 1];
    if (!first || !last) continue;

    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    return range;
  }
  return null;
}

function clearHighlightMarks() {
  for (const mark of el.viewer.querySelectorAll('.lookup-highlight')) mark.remove();
}

function clearHighlight() {
  if (state) state.highlight = null;
  clearHighlightMarks();
}

/**
 * Paint the highlight over a rendered page. The marks live inside `.page-inner` in its
 * own coordinate space, so the zoom transform scales them along with the text.
 */
function drawHighlight(slot) {
  if (!state?.highlight || state.highlight.page !== slot.num || !slot.inner) return false;

  for (const mark of slot.inner.querySelectorAll('.lookup-highlight')) mark.remove();

  const textLayer = slot.inner.querySelector('.textLayer');
  const range = textLayer && findPhrase(textLayer, state.highlight.text);
  if (!range) return false;

  const innerRect = slot.inner.getBoundingClientRect();
  // The wrapper may be mid-zoom, so undo its scale to get back to its own coordinates.
  const scale = innerRect.width / slot.inner.offsetWidth || 1;
  const marks = document.createDocumentFragment();
  let drew = false;

  for (const rect of range.getClientRects()) {
    if (rect.width < 0.5 || rect.height < 0.5) continue;
    const mark = document.createElement('div');
    mark.className = 'lookup-highlight';
    mark.style.left = `${(rect.left - innerRect.left) / scale}px`;
    mark.style.top = `${(rect.top - innerRect.top) / scale}px`;
    mark.style.width = `${rect.width / scale}px`;
    mark.style.height = `${rect.height / scale}px`;
    marks.append(mark);
    drew = true;
  }

  slot.inner.append(marks);
  return drew;
}

/** Put the highlighted phrase a little above centre, rather than the top of its page. */
function scrollToHighlight(slot, behavior = 'smooth') {
  const mark = slot.inner?.querySelector('.lookup-highlight');
  if (!mark) return false;

  const rect = mark.getBoundingClientRect();
  const view = el.container.getBoundingClientRect();
  const top = el.container.scrollTop + (rect.top - view.top) - el.container.clientHeight * 0.38;
  const left = el.container.scrollWidth > el.container.clientWidth
    ? el.container.scrollLeft + (rect.left - view.left) - el.container.clientWidth / 2 + rect.width / 2
    : el.container.scrollLeft;

  el.container.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior });
  return true;
}

/** Open a past lookup: show its explanation, then go to the words themselves. */
async function revealLookup(entry) {
  renderResult(entry.result, entry.selection);

  const slot = state.slots[entry.page - 1];
  if (!slot) return;

  state.highlight = { page: entry.page, text: entry.selection };
  clearHighlightMarks();

  // Render the target page where it sits, without moving the view first: jumping there
  // and then gliding the rest of the way reads as a teleport, not a scroll. Rendering
  // in place means the phrase can be measured before a single smooth scroll to it.
  await renderPage(slot).catch(() => {});
  if (!state || state.highlight?.text !== entry.selection) return; // superseded

  if (drawHighlight(slot)) scrollToHighlight(slot, 'smooth');
  else scrollToPage(entry.page, 0, 'smooth'); // phrase not found — the page is still useful
}

/* ------------------------------- selection -------------------------------- */

function readSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const text = sel.toString().trim();
  if (text.length < 2) return null;

  const range = sel.getRangeAt(0);
  const pageEl = (range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer
    : range.startContainer.parentElement)?.closest('.page');
  if (!pageEl || !el.container.contains(pageEl)) return null;

  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;

  return { text, page: Number(pageEl.dataset.page), rect };
}

function showExplainButton(sel) {
  const btn = el.explainBtn;
  const bounds = el.container.getBoundingClientRect();

  // A selection scrolled out of view gets no button — it would float over unrelated text.
  if (sel.rect.bottom < bounds.top || sel.rect.top > bounds.bottom) return hideExplainButton();

  btn.hidden = false;
  const { width, height } = btn.getBoundingClientRect();
  const gap = 8;
  const left = sel.rect.left + sel.rect.width / 2 - width / 2;
  let top = sel.rect.top - height - gap;

  // Flip below the selection when it would otherwise sit under the toolbar.
  if (top < bounds.top + gap) top = sel.rect.bottom + gap;

  btn.style.left = `${clamp(left, 8, window.innerWidth - width - 8)}px`;
  btn.style.top = `${clamp(top, bounds.top + gap, window.innerHeight - height - 8)}px`;
}

function hideExplainButton() {
  el.explainBtn.hidden = true;
  state && (state.pendingSelection = null);
}

/* -------------------------------- panel ----------------------------------- */

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function openPanel(kindLabel, html) {
  if (state) state.panelToken = (state.panelToken ?? 0) + 1;
  el.panelKind.textContent = kindLabel;
  el.panelBody.innerHTML = html;
  el.panel.hidden = false;
  el.history.hidden = true; // they share the same corner
}

/**
 * Ask for a picture after the explanation is already on screen, and slot it in if one
 * turns up. Nothing is reserved for it up front, so a lookup with no image looks no
 * different from one that never asked.
 */
async function loadMeaningImage(result, token) {
  if (!result.imageQuery) return;

  let found;
  try {
    ({ image: found } = await api.findImage(result.imageQuery));
  } catch {
    return; // no picture is a fine outcome
  }
  // The reader may have moved on to another lookup while we were asking.
  if (!found || token !== state?.panelToken) return;

  const slot = el.panelBody.querySelector('.meaning-image-slot');
  if (!slot) return;

  // Deliberately not lazy: this image is loaded while detached, and a lazy one never
  // enters a viewport to trigger loading, so it would sit there forever.
  const img = new Image();
  img.alt = found.title || result.imageQuery;
  img.className = 'meaning-image';
  // Only show it once it has actually decoded, so a broken link leaves no gap behind.
  img.addEventListener('load', () => {
    const figure = document.createElement('figure');
    figure.className = 'meaning-figure';
    figure.append(img);

    const caption = document.createElement('figcaption');
    const credit = [found.credit, found.source].filter(Boolean).join(' · ');
    if (found.sourceUrl) {
      const link = document.createElement('a');
      link.href = found.sourceUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = credit;
      caption.append(link);
    } else {
      caption.textContent = credit;
    }
    figure.append(caption);
    slot.replaceChildren(figure);
  });
  img.addEventListener('error', () => slot.replaceChildren());
  img.src = found.url;
}

function renderResult(result, selectionText) {
  const details = (result.details ?? [])
    .filter((d) => d?.label && d?.value)
    .map((d) => `<li><span class="detail-label">${escapeHtml(d.label)}</span><span>${escapeHtml(d.value)}</span></li>`)
    .join('');

  const inContext = result.inContext
    ? `<div class="panel-section">
         <div class="panel-label">In this document</div>
         <p>${escapeHtml(result.inContext)}</p>
       </div>`
    : '';

  openPanel(result.kind || 'result', `
    <h3 class="panel-headline">${escapeHtml(result.headline || selectionText)}</h3>
    <p class="panel-selection">“${escapeHtml(selectionText)}”</p>
    <div class="panel-section">
      <div class="panel-label">Meaning</div>
      <p>${escapeHtml(result.meaning || '')}</p>
      <div class="meaning-image-slot"></div>
    </div>
    ${inContext}
    ${details ? `<div class="panel-section"><div class="panel-label">Details</div><ul class="detail-list">${details}</ul></div>` : ''}
    ${result.cached ? '<p class="cached-note">From cache — you looked this up before.</p>' : ''}
  `);

  loadMeaningImage(result, state?.panelToken);
}

async function runExplain(selection) {
  hideExplainButton();
  clearHighlight();
  openPanel('looking up', `<div class="panel-loading">Working out what “${escapeHtml(
    selection.text.length > 40 ? `${selection.text.slice(0, 40)}…` : selection.text
  )}” means…</div>`);

  const slot = state.slots[selection.page - 1];
  try {
    const result = await api.explain({
      docId: state.docId,
      page: selection.page,
      selection: selection.text,
      context: slot?.text ?? '',
    });
    renderResult(result, selection.text);
    loadHistory();
  } catch (err) {
    openPanel('error', `<div class="panel-error">${escapeHtml(err.message)}
      ${err.hint ? `<span class="hint">${escapeHtml(err.hint)}</span>` : ''}</div>`);
  }
}

/* -------------------------------- history --------------------------------- */

async function loadHistory() {
  if (!state) return;
  try {
    state.lookups = await api.getLookups(state.docId);
  } catch {
    state.lookups = [];
  }
  renderHistory();
}

function renderHistory() {
  el.historyList.replaceChildren();
  el.historyEmpty.hidden = state.lookups.length > 0;
  el.historyClear.hidden = state.lookups.length === 0;

  for (const entry of state.lookups) {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <span class="history-text">
        <span class="history-term"></span>
        <span class="history-sub">p.${entry.page} · ${entry.kind}</span>
      </span>
      <button class="delete-btn" title="Delete this lookup" aria-label="Delete this lookup">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/></svg>
      </button>`;
    li.querySelector('.history-term').textContent = entry.result?.headline || entry.selection;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.delete-btn')) return;
      revealLookup(entry);
    });

    li.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      // Drop it from the list first; the request is a formality the reader need not wait on.
      state.lookups = state.lookups.filter((l) => l.id !== entry.id);
      renderHistory();
      try {
        await api.deleteLookup(entry.id);
      } catch {
        loadHistory(); // put it back if the server disagreed
      }
    });

    el.historyList.append(li);
  }
}

/* ------------------------------ open / close ------------------------------ */

/** Persist the position even while the page is unloading, where fetch is unreliable. */
function flushProgress(docId, page, offsetPct) {
  const body = new Blob([JSON.stringify({ page, offsetPct })], { type: 'application/json' });
  const sent = navigator.sendBeacon?.(`/api/documents/${docId}/progress-beacon`, body);
  if (!sent) api.saveProgress(docId, page, offsetPct).catch(() => {});
}

export async function openDocument(docId) {
  close();

  const doc = await getDocument(docId);
  const saved = doc.progress ?? { page: 1, offset_pct: 0 };

  el.title.textContent = doc.title || doc.filename;
  el.reader.hidden = false;
  document.getElementById('library').hidden = true;
  document.title = `${doc.title || doc.filename} — Smart PDF Reader`;

  const zoom = clamp(Number(localStorage.getItem('spr:zoom')) || 1, MIN_ZOOM, MAX_ZOOM);

  const pdf = await pdfjsLib.getDocument({ url: fileUrl(docId) }).promise;
  const firstPage = await pdf.getPage(1);
  const unscaled = firstPage.getViewport({ scale: 1 });

  state = {
    docId,
    pdf,
    zoom,
    liveZoom: zoom,
    zoomCommitTimer: null,
    slots: buildSlots(pdf.numPages, unscaled.width, unscaled.height),
    currentPage: 0,
    savedPage: saved.page,
    savedOffset: saved.offset_pct ?? 0,
    saveTimer: null,
    badgeTimer: null,
    pendingSelection: null,
    panelToken: 0,
    highlight: null,
    lookups: [],
  };

  sizeAllSlots();
  updateZoomControls();
  el.pageCount.textContent = String(pdf.numPages);
  el.pageInput.max = String(pdf.numPages);

  // Restore the reading position before the first paint the user sees.
  scrollToPage(saved.page, saved.offset_pct ?? 0);
  updateVisiblePages();
  syncPageIndicator();
  loadHistory();
}

export function close() {
  if (state) {
    clearTimeout(state.saveTimer);
    clearTimeout(state.badgeTimer);
    clearTimeout(state.zoomCommitTimer);
    // Flush the position instead of losing the last few seconds of reading.
    const { page, offsetPct } = locate();
    flushProgress(state.docId, page, offsetPct);
    state.pdf.destroy?.();
    state = null;
  }
  el.viewer.replaceChildren();
  el.reader.hidden = true;
  el.panel.hidden = true;
  el.history.hidden = true;
  hideExplainButton();
  document.title = 'Smart PDF Reader';
}

/* --------------------------------- wiring --------------------------------- */

export function initReader(exitHandler) {
  onExit = exitHandler;

  let ticking = false;
  el.container.addEventListener('scroll', () => {
    hideExplainButton();
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      if (!state) return;
      updateVisiblePages();
      syncPageIndicator();
      queueSave();
    });
  }, { passive: true });

  el.back.addEventListener('click', () => onExit());

  el.prev.addEventListener('click', () => state && scrollToPage(locate().page - 1, 0, 'smooth'));
  el.next.addEventListener('click', () => state && scrollToPage(locate().page + 1, 0, 'smooth'));

  const jump = () => {
    if (!state) return;
    const page = clamp(Number.parseInt(el.pageInput.value, 10) || 1, 1, state.slots.length);
    el.pageInput.value = String(page);
    scrollToPage(page, 0, 'smooth');
  };
  el.pageInput.addEventListener('change', jump);
  el.pageInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { jump(); el.pageInput.blur(); } });

  el.zoomIn.addEventListener('click', () => state && setZoom(nextZoomStop(1)));
  el.zoomOut.addEventListener('click', () => state && setZoom(nextZoomStop(-1)));

  /* --- trackpad pinch and ctrl/cmd + wheel zoom the document, not the browser.
         Bound to the whole reader so a pinch over the toolbar or a panel still
         zooms the PDF rather than the browser window. --- */
  el.reader.addEventListener('wheel', (e) => {
    // macOS reports a trackpad pinch as a wheel event with ctrlKey set.
    if (!state || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    hideExplainButton();
    const anchor = anchorAt(e.clientX, e.clientY);
    previewZoom(state.liveZoom * Math.exp(-e.deltaY * PINCH_SENSITIVITY), anchor);
  }, { passive: false });

  // Safari sends its own gesture events instead of ctrl+wheel.
  let gestureStartZoom = 1;
  let gestureAnchor = null;
  el.reader.addEventListener('gesturestart', (e) => {
    if (!state) return;
    e.preventDefault();
    gestureStartZoom = state.liveZoom;
    gestureAnchor = anchorAt(e.clientX, e.clientY);
    hideExplainButton();
  });
  el.reader.addEventListener('gesturechange', (e) => {
    if (!state || !gestureAnchor) return;
    e.preventDefault();
    previewZoom(gestureStartZoom * e.scale, gestureAnchor);
  });
  el.reader.addEventListener('gestureend', (e) => {
    if (!state) return;
    e.preventDefault();
    gestureAnchor = null;
  });

  // Selection: capture it on mouseup, before clicking the button can clear it.
  el.container.addEventListener('mouseup', () => {
    if (!state) return;
    setTimeout(() => {
      const sel = readSelection();
      if (!sel) return hideExplainButton();
      state.pendingSelection = sel;
      showExplainButton(sel);
    }, 0);
  });

  el.container.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.explain-btn')) hideExplainButton();
  });

  // The button must not steal the selection before we read it.
  el.explainBtn.addEventListener('mousedown', (e) => e.preventDefault());
  el.explainBtn.addEventListener('click', () => {
    if (state?.pendingSelection) runExplain(state.pendingSelection);
  });

  el.panelClose.addEventListener('click', () => {
    el.panel.hidden = true;
    clearHighlight();
  });
  el.historyClose.addEventListener('click', () => { el.history.hidden = true; });
  el.historyClear.addEventListener('click', async () => {
    if (!state?.lookups.length) return;
    const count = state.lookups.length;
    if (!confirm(`Delete all ${count} lookup${count === 1 ? '' : 's'} in this document?`)) return;
    state.lookups = [];
    renderHistory();
    try {
      await api.clearLookups(state.docId);
    } catch {
      loadHistory();
    }
  });
  el.historyBtn.addEventListener('click', () => {
    el.history.hidden = !el.history.hidden;
    if (!el.history.hidden) { el.panel.hidden = true; loadHistory(); }
  });

  document.addEventListener('keydown', (e) => {
    if (el.reader.hidden) return;
    if (e.key === 'Escape') {
      if (!el.panel.hidden) { el.panel.hidden = true; clearHighlight(); return; }
      if (!el.history.hidden) return void (el.history.hidden = true);
      onExit();
    }
    if (e.target === el.pageInput) return;
    if ((e.key === '=' || e.key === '+') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setZoom(nextZoomStop(1)); }
    if (e.key === '-' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setZoom(nextZoomStop(-1)); }
    if (e.key === '0' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setZoom(1); }
  });

  // Last chance to persist the page when the tab goes away.
  window.addEventListener('pagehide', () => {
    if (!state) return;
    const { page, offsetPct } = locate();
    flushProgress(state.docId, page, offsetPct);
  });
}
