async function request(url, options = {}) {
  const res = await fetch(url, options);
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.hint = body?.hint || '';
    throw err;
  }
  return body;
}

export const api = {
  health: () => request('/api/health'),

  listDocuments: () => request('/api/documents'),

  uploadDocument(file, onProgress) {
    // XHR rather than fetch: upload progress on large PDFs is worth the extra code.
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('pdf', file);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/documents');
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded / e.total);
      });
      xhr.addEventListener('load', () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch { /* handled below */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body?.error || `Upload failed (${xhr.status})`));
      });
      xhr.addEventListener('error', () => reject(new Error('Upload failed — is the server running?')));
      xhr.send(form);
    });
  },

  deleteDocument: (id) => request(`/api/documents/${id}`, { method: 'DELETE' }),

  getProgress: (id) => request(`/api/documents/${id}/progress`),

  saveProgress: (id, page, offsetPct) =>
    request(`/api/documents/${id}/progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page, offsetPct }),
    }),

  getLookups: (id) => request(`/api/documents/${id}/lookups`),

  findImage: (query) => request(`/api/image?q=${encodeURIComponent(query)}`),

  deleteLookup: (id) => request(`/api/lookups/${id}`, { method: 'DELETE' }),

  clearLookups: (docId) => request(`/api/documents/${docId}/lookups`, { method: 'DELETE' }),

  explain: (payload) =>
    request('/api/explain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
};

export const fileUrl = (id) => `/api/documents/${id}/file`;

export const getDocument = (id) => fetch(`/api/documents/${id}`).then((r) => {
  if (!r.ok) throw new Error(r.status === 404 ? 'That document is no longer in your library.' : 'Could not load document.');
  return r.json();
});
