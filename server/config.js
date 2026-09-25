import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Node loads .env natively; do it before anything reads process.env.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export const PORT = Number(process.env.PORT) || 3000;
// Overridable so the test suite runs against a throwaway directory.
export const PDF_DIR = process.env.PDF_DIR || path.join(ROOT, 'pdfs');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
// Overridable so tests can point at a stub instead of the real API.
export const GEMINI_API_BASE = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';
// Pins the request/response shape of the Interactions API. Google's own examples send it.
export const GEMINI_API_REVISION = process.env.GEMINI_API_REVISION || '2026-05-20';
// Models differ on which levels they accept, so this is both configurable and, on
// rejection, corrected from what the API says it allows.
export const GEMINI_THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'low';

// Recap sizing. Not context limits — a flash model would swallow a whole book in one
// call. They are quality and cost limits: past roughly 25 pages a single summary goes
// shallow and front-loaded, and re-running one re-pays for everything. Overridable so
// the test suite can force either path on a small fixture.
export const RECAP_BUDGET_CHARS = Number(process.env.RECAP_BUDGET_CHARS) || 60_000;
export const RECAP_CHUNK_CHARS = Number(process.env.RECAP_CHUNK_CHARS) || 48_000;
// What actually bounds a recap's cost is RECAP_MAX_PAGES: at ~20 pages a chunk, 300
// pages is about 15 calls. This is the guard for a document whose pages are far denser
// than that, not the main dial.
export const RECAP_MAX_CHUNKS = Number(process.env.RECAP_MAX_CHUNKS) || 24;
export const RECAP_MAX_PAGES = Number(process.env.RECAP_MAX_PAGES) || 300;
export const RECAP_CONCURRENCY = Number(process.env.RECAP_CONCURRENCY) || 3;

// Wikimedia asks that clients identify themselves; set a contact address here if you
// start making heavy use of it. https://foundation.wikimedia.org/wiki/Policy:User-Agent_policy
export const IMAGE_USER_AGENT = process.env.IMAGE_USER_AGENT
  || 'SmartPdfReader/0.1 (personal local PDF reader; https://github.com/topics/pdf-reader)';

// Overridable so the test suite can answer with a stub instead of the live encyclopaedias.
export const WIKIPEDIA_API_BASE = process.env.WIKIPEDIA_API_BASE || 'https://en.wikipedia.org';
export const COMMONS_API_BASE = process.env.COMMONS_API_BASE || 'https://commons.wikimedia.org';
export const OPENVERSE_API_BASE = process.env.OPENVERSE_API_BASE || 'https://api.openverse.org';
export const EXTRA_IMAGE_HOSTS = (process.env.EXTRA_IMAGE_HOSTS || '')
  .split(',').map((h) => h.trim()).filter(Boolean);

for (const dir of [PDF_DIR, DATA_DIR]) fs.mkdirSync(dir, { recursive: true });
