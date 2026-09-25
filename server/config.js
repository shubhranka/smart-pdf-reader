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

for (const dir of [PDF_DIR, DATA_DIR]) fs.mkdirSync(dir, { recursive: true });
