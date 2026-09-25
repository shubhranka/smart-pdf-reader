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

export default db;
