import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

const db = new DatabaseSync(path.join(DATA_DIR, 'reader.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS documents (
    id         TEXT PRIMARY KEY,
    filename   TEXT NOT NULL,
    title      TEXT NOT NULL,
    pages      INTEGER NOT NULL DEFAULT 0,
    size       INTEGER NOT NULL DEFAULT 0,
    added_at   TEXT NOT NULL
  );

  -- One row per document: where the reader left off.
  CREATE TABLE IF NOT EXISTS progress (
    doc_id     TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    page       INTEGER NOT NULL DEFAULT 1,
    offset_pct REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lookups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id     TEXT REFERENCES documents(id) ON DELETE CASCADE,
    page       INTEGER NOT NULL,
    selection  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    result     TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS lookups_doc_idx ON lookups(doc_id, id DESC);

  -- Same phrase asked twice costs one API call, not two.
  CREATE TABLE IF NOT EXISTS explain_cache (
    key        TEXT PRIMARY KEY,
    result     TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Picture lookups are cached separately from explanations, so a source being
  -- briefly unreachable is not baked into the explanation for good.
  CREATE TABLE IF NOT EXISTS image_cache (
    query      TEXT PRIMARY KEY,
    result     TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Page text pulled out server-side. The browser only holds text for pages it has
  -- actually rendered, so a recap of pages you scrolled past cannot be assembled
  -- there. A document id is a content hash, so this text can never go stale.
  CREATE TABLE IF NOT EXISTS page_text (
    doc_id TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page   INTEGER NOT NULL,
    text   TEXT    NOT NULL,
    chars  INTEGER NOT NULL,
    PRIMARY KEY (doc_id, page)
  ) WITHOUT ROWID;

  -- Notes on one stretch of a document. Chunk boundaries are packed from page 1 of
  -- the document rather than from wherever a recap starts, so reading further reuses
  -- every earlier chunk instead of re-paying for it.
  CREATE TABLE IF NOT EXISTS recap_chunk_cache (
    key        TEXT PRIMARY KEY,
    doc_id     TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    from_page  INTEGER NOT NULL,
    to_page    INTEGER NOT NULL,
    summary    TEXT    NOT NULL,
    created_at TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS recap_chunk_doc_idx ON recap_chunk_cache(doc_id);

  -- "Catch me up" summaries, kept so an old one can be reopened without paying again.
  CREATE TABLE IF NOT EXISTS recaps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id      TEXT    NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    from_page   INTEGER NOT NULL,
    to_page     INTEGER NOT NULL,
    cut_text    TEXT    NOT NULL DEFAULT '',
    cut_hash    TEXT    NOT NULL DEFAULT '',
    cut_applied INTEGER NOT NULL DEFAULT 0,
    result      TEXT    NOT NULL,
    chunks      INTEGER NOT NULL DEFAULT 1,
    chars       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL
  );
  -- The same range asked for twice updates one row instead of filling the drawer.
  CREATE UNIQUE INDEX IF NOT EXISTS recaps_range_idx
    ON recaps(doc_id, from_page, to_page, cut_hash);
  CREATE INDEX IF NOT EXISTS recaps_doc_idx ON recaps(doc_id, id DESC);
`);

const now = () => new Date().toISOString();

export const documents = {
  insert({ id, filename, title, pages, size }) {
    db.prepare(
      `INSERT INTO documents (id, filename, title, pages, size, added_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, pages = excluded.pages`
    ).run(id, filename, title, pages, size, now());
    return this.get(id);
  },

  get(id) {
    return db.prepare('SELECT * FROM documents WHERE id = ?').get(id) ?? null;
  },

  // Library view: newest activity first, so what you were reading is on top.
  list() {
    return db.prepare(`
      SELECT d.*, p.page AS last_page, p.offset_pct, p.updated_at AS last_read_at,
             (SELECT COUNT(*) FROM lookups l WHERE l.doc_id = d.id) AS lookup_count
      FROM documents d
      LEFT JOIN progress p ON p.doc_id = d.id
      ORDER BY COALESCE(p.updated_at, d.added_at) DESC
    `).all();
  },

  remove(id) {
    db.prepare('DELETE FROM lookups WHERE doc_id = ?').run(id);
    db.prepare('DELETE FROM progress WHERE doc_id = ?').run(id);
    db.prepare('DELETE FROM recaps WHERE doc_id = ?').run(id);
    db.prepare('DELETE FROM recap_chunk_cache WHERE doc_id = ?').run(id);
    db.prepare('DELETE FROM page_text WHERE doc_id = ?').run(id);
    db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  },
};

export const progress = {
  get(docId) {
    return db.prepare('SELECT page, offset_pct, updated_at FROM progress WHERE doc_id = ?').get(docId) ?? null;
  },

  save(docId, page, offsetPct) {
    db.prepare(
      `INSERT INTO progress (doc_id, page, offset_pct, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET
         page = excluded.page, offset_pct = excluded.offset_pct, updated_at = excluded.updated_at`
    ).run(docId, page, offsetPct, now());
    return this.get(docId);
  },
};

export const lookups = {
  insert({ docId, page, selection, kind, result }) {
    db.prepare(
      `INSERT INTO lookups (doc_id, page, selection, kind, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(docId, page, selection, kind, JSON.stringify(result), now());
  },

  listByDoc(docId, limit = 100) {
    return db.prepare(
      'SELECT id, page, selection, kind, result, created_at FROM lookups WHERE doc_id = ? ORDER BY id DESC LIMIT ?'
    ).all(docId, limit).map((r) => ({ ...r, result: JSON.parse(r.result) }));
  },

  // Guards against the same term filling the list twice, and lets a deleted
  // lookup come back if you highlight it again.
  exists(docId, page, selection) {
    return Boolean(db.prepare(
      'SELECT 1 FROM lookups WHERE doc_id = ? AND page = ? AND selection = ? LIMIT 1'
    ).get(docId, page, selection));
  },

  remove(id) {
    const { changes } = db.prepare('DELETE FROM lookups WHERE id = ?').run(id);
    return changes > 0;
  },

  removeAllForDoc(docId) {
    return db.prepare('DELETE FROM lookups WHERE doc_id = ?').run(docId).changes;
  },
};

export const pageText = {
  getRange(docId, from, to) {
    return db.prepare(
      'SELECT page, text, chars FROM page_text WHERE doc_id = ? AND page BETWEEN ? AND ? ORDER BY page'
    ).all(docId, from, to);
  },

  /** Which pages of this range still need extracting. */
  missing(docId, from, to) {
    const have = new Set(db.prepare(
      'SELECT page FROM page_text WHERE doc_id = ? AND page BETWEEN ? AND ?'
    ).all(docId, from, to).map((r) => r.page));

    const gaps = [];
    for (let p = from; p <= to; p++) if (!have.has(p)) gaps.push(p);
    return gaps;
  },

  // node:sqlite has no transaction() helper, so the batch is wrapped by hand —
  // extracting fifty pages should cost one fsync, not fifty.
  putMany(docId, rows) {
    const stmt = db.prepare(
      `INSERT INTO page_text (doc_id, page, text, chars) VALUES (?, ?, ?, ?)
       ON CONFLICT(doc_id, page) DO UPDATE SET text = excluded.text, chars = excluded.chars`
    );
    db.exec('BEGIN');
    try {
      for (const { page, text } of rows) stmt.run(docId, page, text, text.length);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
};

export const recapChunks = {
  get(key) {
    const row = db.prepare('SELECT summary FROM recap_chunk_cache WHERE key = ?').get(key);
    return row ? JSON.parse(row.summary) : null;
  },

  set(key, { docId, fromPage, toPage, summary }) {
    db.prepare(
      `INSERT INTO recap_chunk_cache (key, doc_id, from_page, to_page, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET summary = excluded.summary`
    ).run(key, docId, fromPage, toPage, JSON.stringify(summary), now());
  },
};

export const recaps = {
  /** Asking for the same range again replaces that row rather than adding one. */
  upsert({ docId, fromPage, toPage, cutText, cutHash, cutApplied, chars, chunks, result }) {
    db.prepare(
      `INSERT INTO recaps (doc_id, from_page, to_page, cut_text, cut_hash, cut_applied,
                           result, chunks, chars, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_id, from_page, to_page, cut_hash) DO UPDATE SET
         cut_text = excluded.cut_text, cut_applied = excluded.cut_applied,
         result = excluded.result, chunks = excluded.chunks, chars = excluded.chars,
         created_at = excluded.created_at`
    ).run(docId, fromPage, toPage, cutText, cutHash, cutApplied ? 1 : 0,
          JSON.stringify(result), chunks, chars, now());
    return this.find(docId, fromPage, toPage, cutHash);
  },

  find(docId, fromPage, toPage, cutHash) {
    const row = db.prepare(
      'SELECT * FROM recaps WHERE doc_id = ? AND from_page = ? AND to_page = ? AND cut_hash = ?'
    ).get(docId, fromPage, toPage, cutHash);
    return row ? { ...row, result: JSON.parse(row.result) } : null;
  },

  listByDoc(docId, limit = 50) {
    return db.prepare(
      'SELECT * FROM recaps WHERE doc_id = ? ORDER BY id DESC LIMIT ?'
    ).all(docId, limit).map((r) => ({ ...r, result: JSON.parse(r.result) }));
  },

  remove(id) {
    const { changes } = db.prepare('DELETE FROM recaps WHERE id = ?').run(id);
    return changes > 0;
  },

  removeAllForDoc(docId) {
    return db.prepare('DELETE FROM recaps WHERE doc_id = ?').run(docId).changes;
  },
};

export const cache = {
  get(key) {
    const row = db.prepare('SELECT result FROM explain_cache WHERE key = ?').get(key);
    return row ? JSON.parse(row.result) : null;
  },

  set(key, result) {
    db.prepare(
      `INSERT INTO explain_cache (key, result, created_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET result = excluded.result`
    ).run(key, JSON.stringify(result), now());
  },
};

export const imageCache = {
  /** undefined = never looked up; null = looked up and nothing suitable was found. */
  get(query) {
    const row = db.prepare('SELECT result FROM image_cache WHERE query = ?').get(query);
    return row ? JSON.parse(row.result) : undefined;
  },

  set(query, result) {
    db.prepare(
      `INSERT INTO image_cache (query, result, created_at) VALUES (?, ?, ?)
       ON CONFLICT(query) DO UPDATE SET result = excluded.result`
    ).run(query, JSON.stringify(result ?? null), now());
  },
};

export default db;
