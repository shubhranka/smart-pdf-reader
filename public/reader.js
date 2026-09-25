import * as pdfjsLib from '/vendor/pdfjs/build/pdf.mjs';
import { api, fileUrl, getDocument } from './api.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';

// Round stops rather than a fixed step, so 500% is a few clicks away and every
// stop is a number worth landing on.
const ZOOM_STOPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5];
const MIN_ZOOM = ZOOM_STOPS[0];
const MAX_ZOOM = ZOOM_STOPS[ZOOM_STOPS.length - 1];

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
};

/** Everything about the document currently open. Reset by `close()`. */
let state = null;
let onExit = () => {};

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/* ------------------------------ page rendering ---------------------------- */

function buildSlots(numPages, baseViewport) {
  el.viewer.replaceChildren();
  const slots = [];

  for (let num = 1; num <= numPages; num++) {
    const div = document.createElement('div');
    div.className = 'page placeholder';
    div.dataset.page = String(num);
    // Sized from page 1 up front so the scrollbar is right before anything renders;
    // each page corrects its own height once it actually renders.
    div.style.width = `${Math.floor(baseViewport.width)}px`;
    div.style.height = `${Math.floor(baseViewport.height)}px`;
    el.viewer.append(div);
    slots.push({ num, el: div, rendered: false, rendering: null, text: '', textLayer: null, pixels: 0, lastSeen: 0 });
  }
  return slots;
}

async function renderPage(slot) {
  if (slot.rendered || slot.rendering) return slot.rendering;

  slot.rendering = (async () => {
    const page = await state.pdf.getPage(slot.num);
    const viewport = page.getViewport({ scale: state.zoom });

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

    const tag = document.createElement('div');
    tag.className = 'page-number-tag';
    tag.textContent = String(slot.num);

    slot.el.style.width = canvas.style.width;
    slot.el.style.height = canvas.style.height;
    slot.el.style.setProperty('--scale-factor', state.zoom);
    slot.el.style.setProperty('--total-scale-factor', state.zoom);
    slot.el.classList.remove('placeholder');
    slot.el.replaceChildren(canvas, textLayerDiv, tag);

    slot.text = textLayer.textContentItemsStr.join(' ').replace(/\s+/g, ' ').trim();
    slot.textLayer = textLayer;
    slot.pixels = canvas.width * canvas.height;
    slot.rendered = true;
  })().finally(() => { slot.rendering = null; });

  return slot.rendering;
}

function releasePage(slot) {
  if (!slot.rendered) return;
  slot.textLayer?.cancel();
  slot.textLayer = null;
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

  for (const slot of wanted) renderPage(slot).catch(() => {});

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
      flashSaved();
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
  const current = state.zoom;
  const stops = direction > 0 ? ZOOM_STOPS : [...ZOOM_STOPS].reverse();
  // A tolerance keeps a zoom restored from storage from sticking between stops.
  return stops.find((z) => direction > 0 ? z > current + 0.001 : z < current - 0.001) ?? current;
}

function setZoom(zoom) {
  const next = clamp(Number(zoom.toFixed(2)), MIN_ZOOM, MAX_ZOOM);
  if (next === state.zoom) return;

  const anchor = locate();
  // Keep whatever is under the middle of the viewport there afterwards.
  const container = el.container;
  const centreRatio = container.scrollWidth > container.clientWidth
    ? (container.scrollLeft + container.clientWidth / 2) / container.scrollWidth
    : 0.5;

  state.zoom = next;
  el.zoomLevel.textContent = `${Math.round(next * 100)}%`;
  localStorage.setItem('spr:zoom', String(next));
  el.zoomIn.disabled = next >= MAX_ZOOM;
  el.zoomOut.disabled = next <= MIN_ZOOM;

  const base = state.basePage1Viewport;
  for (const slot of state.slots) {
    releasePage(slot);
    slot.el.style.width = `${Math.floor((base.width / base.scale) * next)}px`;
    slot.el.style.height = `${Math.floor((base.height / base.scale) * next)}px`;
  }

  scrollToPage(anchor.page, anchor.offsetPct);
  container.scrollLeft = centreRatio * container.scrollWidth - container.clientWidth / 2;
  updateVisiblePages();
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
  el.panelKind.textContent = kindLabel;
  el.panelBody.innerHTML = html;
  el.panel.hidden = false;
  el.history.hidden = true; // they share the same corner
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
    </div>
    ${inContext}
    ${details ? `<div class="panel-section"><div class="panel-label">Details</div><ul class="detail-list">${details}</ul></div>` : ''}
    ${result.cached ? '<p class="cached-note">From cache — you looked this up before.</p>' : ''}
  `);
}

async function runExplain(selection) {
  hideExplainButton();
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

  for (const entry of state.lookups) {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `<div class="history-term"></div><div class="history-sub">p.${entry.page} · ${entry.kind}</div>`;
    li.querySelector('.history-term').textContent = entry.result?.headline || entry.selection;
    li.addEventListener('click', () => {
      renderResult(entry.result, entry.selection);
      scrollToPage(entry.page, 0, 'smooth');
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
  el.zoomLevel.textContent = `${Math.round(zoom * 100)}%`;
  el.zoomIn.disabled = zoom >= MAX_ZOOM;
  el.zoomOut.disabled = zoom <= MIN_ZOOM;

  const pdf = await pdfjsLib.getDocument({ url: fileUrl(docId) }).promise;
  const firstPage = await pdf.getPage(1);
  const baseViewport = firstPage.getViewport({ scale: zoom });

  state = {
    docId,
    pdf,
    zoom,
    basePage1Viewport: baseViewport,
    slots: buildSlots(pdf.numPages, baseViewport),
    currentPage: 0,
    savedPage: saved.page,
    savedOffset: saved.offset_pct ?? 0,
    saveTimer: null,
    badgeTimer: null,
    pendingSelection: null,
    lookups: [],
  };

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

  el.panelClose.addEventListener('click', () => { el.panel.hidden = true; });
  el.historyClose.addEventListener('click', () => { el.history.hidden = true; });
  el.historyBtn.addEventListener('click', () => {
    el.history.hidden = !el.history.hidden;
    if (!el.history.hidden) { el.panel.hidden = true; loadHistory(); }
  });

  document.addEventListener('keydown', (e) => {
    if (el.reader.hidden) return;
    if (e.key === 'Escape') {
      if (!el.panel.hidden) return void (el.panel.hidden = true);
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
