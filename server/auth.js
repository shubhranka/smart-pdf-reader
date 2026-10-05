import crypto from 'node:crypto';
import { env, PORT } from './config.js';
import { sessions } from './db.js';

/**
 * Optional sign-in, for putting the app online. AUTH=google turns it on: Google proves
 * who someone is, and only the addresses in ALLOWED_EMAILS get in. Left off, the
 * default, every route is open, as it always has been on your own machine.
 *
 * This is the standard authorization-code flow with PKCE, written out by hand because
 * it is three requests and a cookie; a library would be more code than it saves.
 */

const MODES = ['off', 'google'];

export const AUTH = env('AUTH', 'off').trim().toLowerCase();
if (!MODES.includes(AUTH)) {
  throw new Error(`Unknown AUTH "${AUTH}". Use one of: ${MODES.join(', ')}.`);
}

const CLIENT_ID = env('GOOGLE_CLIENT_ID').trim();
const CLIENT_SECRET = env('GOOGLE_CLIENT_SECRET').trim();
export const ALLOWED_EMAILS = new Set(
  env('ALLOWED_EMAILS').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
);
// The address people type in, and the one Google sends them back to. It is set rather
// than read off each request, so a forged Host header cannot change where that is.
export const PUBLIC_URL = env('PUBLIC_URL', `http://localhost:${PORT}`).trim().replace(/\/+$/, '');
const REDIRECT_URI = `${PUBLIC_URL}/auth/callback`;

// Overridable so the test suite can answer with a stub instead of Google.
const GOOGLE_AUTH_URL = env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth');
const GOOGLE_TOKEN_URL = env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token');
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

export const isLoopback = (host) =>
  host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');

if (AUTH === 'google') {
  const missing = [
    !CLIENT_ID && 'GOOGLE_CLIENT_ID',
    !CLIENT_SECRET && 'GOOGLE_CLIENT_SECRET',
    !ALLOWED_EMAILS.size && 'ALLOWED_EMAILS',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`AUTH=google needs ${missing.join(', ')} in .env. The README's Sign-in section shows where to get them.`);
  }
  let url;
  try { url = new URL(PUBLIC_URL); } catch {
    throw new Error(`PUBLIC_URL "${PUBLIC_URL}" is not a web address. Use the one people open, like https://reader.example.com.`);
  }
  // Over plain http the session cookie travels in the clear, and Google refuses the
  // redirect anyway, except to this machine.
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    throw new Error(`PUBLIC_URL must start with https:// (plain http only works for localhost), not "${PUBLIC_URL}".`);
  }
}

const SESSION_COOKIE = 'spr_session';
const OAUTH_COOKIE = 'spr_oauth';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_MS = 10 * 60 * 1000;
// Lax, not Strict: Google's redirect back is a cross-site navigation, and a Strict
// cookie would not ride along with it. Lax still keeps it off cross-site POSTs.
const COOKIE = { httpOnly: true, sameSite: 'lax', secure: PUBLIC_URL.startsWith('https:') };

const randomToken = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value, encoding = 'hex') => crypto.createHash('sha256').update(value).digest(encoding);

// Both cookies hold base64url only, so there is nothing to decode.
function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

function currentUser(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const email = sessions.find(sha256(token));
  // Checked on every request, not only at sign-in, so taking an address off the list
  // locks it out as soon as the server restarts rather than when its session runs out.
  return email && ALLOWED_EMAILS.has(email) ? email : null;
}

/**
 * Trades the one-time code for an ID token and returns what it says about the person.
 * The token comes straight from Google over TLS, in answer to our own secret, so its
 * signature need not be checked (OpenID Connect Core 3.1.3.7). Its claims still are.
 */
async function exchangeCode(code, verifier) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.id_token !== 'string') {
    throw new Error(body.error_description || body.error || `token endpoint answered ${res.status}`);
  }

  const claims = JSON.parse(Buffer.from(body.id_token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  if (!GOOGLE_ISSUERS.has(claims.iss) || claims.aud !== CLIENT_ID || !(claims.exp * 1000 > Date.now())) {
    throw new Error('the ID token was not issued to this app, or has expired');
  }
  return claims;
}

/* ------------------------------ sign-in page ------------------------------ */

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23b44a1e'/%3E%3Cpath d='M9 8h11l4 4v12H9z' fill='none' stroke='%23fff' stroke-width='2' stroke-linejoin='round'/%3E%3Cpath d='M12 16h8M12 20h5' stroke='%23fff' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E";

function signInPage({ error = '', notice = '' } = {}) {
  const message = error
    ? `<p class="signin-msg error" role="alert">${escapeHtml(error)}</p>`
    : notice ? `<p class="signin-msg">${escapeHtml(notice)}</p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Smart PDF Reader</title>
<link rel="icon" href="${ICON}">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main class="signin">
  <h1>Smart PDF Reader</h1>
  <p class="subtitle">Sign in to open your library.</p>
  ${message}
  <a class="signin-btn" href="/auth/google">Sign in with Google</a>
</main>
</body>
</html>`;
}

/* --------------------------------- routes --------------------------------- */

/**
 * Mounts the sign-in routes and, after them, the gate every other route sits behind.
 * Call it before any other route. With AUTH=off it does nothing at all.
 */
export function useAuth(app) {
  if (AUTH === 'off') return;

  app.get('/auth/login', (req, res) => {
    if (currentUser(req)) return res.redirect(303, '/');
    res.type('html').send(signInPage({ notice: 'out' in req.query ? 'You’re signed out.' : '' }));
  });

  app.get('/auth/google', (_req, res) => {
    // state ties Google's answer to this browser; the PKCE verifier ties the code to
    // this request, so a code lifted from the redirect is useless anywhere else.
    const state = randomToken(16);
    const verifier = randomToken(32);
    res.cookie(OAUTH_COOKIE, `${state}.${verifier}`, { ...COOKIE, path: '/auth', maxAge: OAUTH_MS });

    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email',
      state,
      code_challenge: sha256(verifier, 'base64url'),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    res.redirect(303, url.href);
  });

  app.get('/auth/callback', async (req, res) => {
    const [state, verifier] = readCookie(req, OAUTH_COOKIE).split('.');
    res.clearCookie(OAUTH_COOKIE, { ...COOKIE, path: '/auth' });
    const refuse = (status, error) => res.status(status).type('html').send(signInPage({ error }));

    if (req.query.error) return refuse(400, 'Sign-in was cancelled.');
    if (!state || !verifier || req.query.state !== state || typeof req.query.code !== 'string') {
      return refuse(400, 'That sign-in took too long, or was started in another tab. Try again.');
    }

    let claims;
    try {
      claims = await exchangeCode(req.query.code, verifier);
    } catch (err) {
      console.error(`Sign-in failed: ${err.message}`);
      return refuse(502, 'Google didn’t confirm the sign-in. Try again.');
    }

    const email = String(claims.email ?? '').toLowerCase();
    if (claims.email_verified !== true) {
      return refuse(403, `Google hasn’t verified ${email || 'that address'}, so it can’t be used to sign in.`);
    }
    if (!ALLOWED_EMAILS.has(email)) {
      return refuse(403, `${email} isn’t on the list for this reader. Use another Google account, or ask whoever runs it to add this one.`);
    }

    const token = randomToken(32);
    sessions.removeExpired();
    sessions.create(sha256(token), email, new Date(Date.now() + SESSION_MS).toISOString());
    res.cookie(SESSION_COOKIE, token, { ...COOKIE, path: '/', maxAge: SESSION_MS });
    res.redirect(303, '/');
  });

  app.post('/auth/logout', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) sessions.remove(sha256(token));
    res.clearCookie(SESSION_COOKIE, { ...COOKIE, path: '/' });
    res.redirect(303, '/auth/login?out');
  });

  // Everything else, PDFs and API included, needs someone signed in and still on the
  // list. The stylesheet is let through so the sign-in page looks like the app.
  app.use((req, res, next) => {
    req.user = currentUser(req);
    if (req.user || req.path === '/styles.css') return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Sign in to continue.' });
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(303, '/auth/login');
    res.status(401).json({ error: 'Sign in to continue.' });
  });
}

/** One line for the startup banner, with a warning when the app is reachable and open. */
export function authBanner(host) {
  if (AUTH === 'google') {
    const n = ALLOWED_EMAILS.size;
    return `  Sign-in: Google, ${n} allowed address${n === 1 ? '' : 'es'}`;
  }
  return isLoopback(host)
    ? '  Sign-in: off (only this machine can connect)'
    : `  Sign-in: off, and HOST=${host} lets other machines connect. Anyone who reaches it can use it.`;
}
