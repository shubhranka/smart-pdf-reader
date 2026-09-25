import { api } from './api.js';

const el = {
  list: document.getElementById('doc-list'),
  empty: document.getElementById('empty-library'),
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  status: document.getElementById('upload-status'),
};

let onOpen = () => {};

const fmtSize = (bytes) => {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

function fmtWhen(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

function progressRing(pct) {
  const r = 9;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * Math.min(Math.max(pct, 0), 1);
  return `<svg class="progress-ring" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="${r}" stroke="var(--border)" stroke-width="2.5" fill="none"/>
      <circle cx="12" cy="12" r="${r}" stroke="var(--accent)" stroke-width="2.5" fill="none"
              stroke-linecap="round" stroke-dasharray="${dash} ${circumference}"
              transform="rotate(-90 12 12)"/>
    </svg>`;
}

function setStatus(message, isError = false) {
  if (!message) {
    el.status.hidden = true;
    return;
  }
  el.status.hidden = false;
  el.status.textContent = message;
  el.status.classList.toggle('error', isError);
}

function render(docs) {
  el.list.replaceChildren();
  el.empty.hidden = docs.length > 0;

  for (const doc of docs) {
    const li = document.createElement('li');
    li.className = 'doc-card';
    li.tabIndex = 0;
    li.dataset.id = doc.id;

    const lastPage = doc.last_page ?? 0;
    const pct = doc.pages > 0 && lastPage ? lastPage / doc.pages : 0;

    const bits = [];
    if (doc.pages > 0) bits.push(`${doc.pages} pages`);
    if (fmtSize(doc.size)) bits.push(fmtSize(doc.size));
    if (doc.lookup_count > 0) bits.push(`${doc.lookup_count} lookup${doc.lookup_count === 1 ? '' : 's'}`);

    const resume = lastPage > 1
      ? `<span class="resume">Resume p.${lastPage}</span><span>·</span>`
      : '';
    const when = doc.last_read_at ? `<span>read ${fmtWhen(doc.last_read_at)}</span>` : '';

    li.innerHTML = `
      <span class="doc-icon">PDF</span>
      <span class="doc-meta">
        <span class="doc-name"></span>
        <span class="doc-sub">${resume}<span>${bits.join(' · ')}</span>${when ? '<span>·</span>' + when : ''}</span>
      </span>
      ${pct > 0 ? progressRing(pct) : ''}
      <button class="delete-btn" title="Remove" aria-label="Remove this document">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/></svg>
      </button>`;

    // textContent, not innerHTML: filenames can contain markup characters.
    li.querySelector('.doc-name').textContent = doc.title || doc.filename;

    li.addEventListener('click', (e) => {
      if (e.target.closest('.delete-btn')) return;
      onOpen(doc.id);
    });
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(doc.id); }
    });

    li.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove "${doc.title || doc.filename}"? Its saved page and lookups go too.`)) return;
      await api.deleteDocument(doc.id);
      refresh();
    });

    el.list.append(li);
  }
}

export async function refresh() {
  try {
    render(await api.listDocuments());
  } catch (err) {
    setStatus(err.message, true);
  }
}

async function handleFiles(files) {
  const pdfs = [...files].filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (!pdfs.length) return setStatus('That was not a PDF.', true);

  for (const file of pdfs) {
    try {
      setStatus(`Uploading ${file.name}…`);
      const doc = await api.uploadDocument(file, (ratio) => {
        setStatus(`Uploading ${file.name} — ${Math.round(ratio * 100)}%`);
      });
      setStatus(doc.alreadyExisted ? `"${doc.title}" was already in your library.` : `Added "${doc.title}".`);
      await refresh();
      if (pdfs.length === 1) onOpen(doc.id);
    } catch (err) {
      setStatus(err.message, true);
      return;
    }
  }
}

export function initLibrary(openHandler) {
  onOpen = openHandler;

  el.fileInput.addEventListener('change', () => {
    handleFiles(el.fileInput.files);
    el.fileInput.value = '';
  });

  // Page-wide drag handling so a near-miss drop still lands.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (document.getElementById('library').hidden) return;
    e.preventDefault();
    if (++dragDepth === 1) el.dropzone.classList.add('dragover');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; el.dropzone.classList.remove('dragover'); }
  });
  window.addEventListener('drop', (e) => {
    if (document.getElementById('library').hidden) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropzone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });

  refresh();
}
