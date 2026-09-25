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
