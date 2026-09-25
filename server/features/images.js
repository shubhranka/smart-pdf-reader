import { imageCache } from '../db.js';
import { IMAGE_USER_AGENT, WIKIPEDIA_API_BASE, COMMONS_API_BASE, OPENVERSE_API_BASE, EXTRA_IMAGE_HOSTS } from '../config.js';

const TIMEOUT_MS = 4500;

// The proxy serves images only from these hosts, so a bad `imageQuery` can never turn
// into a request to an arbitrary address.
export const ALLOWED_IMAGE_HOSTS = new Set([
  'thumb.wikimedia.org',
  'upload.wikimedia.org',
  'api.openverse.org',
  ...EXTRA_IMAGE_HOSTS,
]);

class SourceError extends Error {}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': IMAGE_USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // A 429 means "ask later", not "there is no picture" — the difference decides
  // whether the empty result is worth remembering.
  if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
  return res.json();
}

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const servable = (url) => Boolean(url) && ALLOWED_IMAGE_HOSTS.has(hostOf(url));
const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Does this result actually depict the thing asked about? Keyword search will happily
 * answer "write-ahead log" with a photograph of a dragonfly, and "B-tree" with a picture
 * of a fractal tree. Requiring the whole phrase in the title throws both out; an
 * unrelated picture is worse than none in a book you are trying to understand.
 */
function looksRelevant(query, title) {
  const needle = normalize(query);
  return needle.length > 0 && normalize(title).includes(needle);
}

/* ------------------------------- sources ---------------------------------- */

async function wikipediaSummary(title) {
  const data = await getJson(`${WIKIPEDIA_API_BASE}/api/rest_v1/page/summary/${encodeURIComponent(title)}`);
  const url = data?.thumbnail?.source;
  if (!servable(url)) return null;

  return {
    url,
    width: data.thumbnail.width ?? null,
    height: data.thumbnail.height ?? null,
    title: data.title || title,
    source: 'Wikipedia',
    sourceUrl: data.content_urls?.desktop?.page ?? null,
    credit: null,
  };
}

/** Exact titles miss a lot: "LSM tree" is filed as "Log-structured merge-tree". */
async function wikipediaSearch(query) {
  const data = await getJson(
    `${WIKIPEDIA_API_BASE}/w/api.php?action=query&format=json&list=search&srlimit=1&srsearch=${encodeURIComponent(query)}`
  );
  const hit = data?.query?.search?.[0]?.title;
  return hit ? wikipediaSummary(hit) : null;
}

/** Commons holds diagrams that no article happens to use. */
async function commonsSearch(query) {
  const data = await getJson(
    `${COMMONS_API_BASE}/w/api.php?action=query&format=json&generator=search`
    + '&gsrnamespace=6&gsrlimit=5&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=640'
    + `&gsrsearch=${encodeURIComponent(query)}`
  );

  for (const page of Object.values(data?.query?.pages ?? {})) {
    const info = page?.imageinfo?.[0];
    // Commons files include PDFs, audio and video; only pictures are useful here.
    if (!info?.mime?.startsWith('image/')) continue;

    const url = info.thumburl || info.url;
    const name = String(page.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '');
    if (!servable(url) || !looksRelevant(query, name)) continue;

    return {
      url,
      width: info.thumbwidth ?? null,
      height: info.thumbheight ?? null,
      title: name,
      source: 'Wikimedia Commons',
      sourceUrl: info.descriptionurl ?? null,
      credit: info.extmetadata?.Artist?.value?.replace(/<[^>]*>/g, '').trim() || null,
    };
  }
  return null;
}

/** Openly licensed photographs, for concrete things Wikipedia has no diagram of. */
async function openverse(query) {
  const data = await getJson(`${OPENVERSE_API_BASE}/v1/images/?page_size=5&q=${encodeURIComponent(query)}`);

  for (const item of data?.results ?? []) {
    if (!servable(item.thumbnail) || !looksRelevant(query, item.title)) continue;
    return {
      url: item.thumbnail,
      width: null,
      height: null,
      title: item.title || query,
      source: 'Openverse',
      sourceUrl: item.foreign_landing_url ?? null,
      credit: [item.creator, item.license?.toUpperCase()].filter(Boolean).join(' · ') || null,
    };
  }
  return null;
}

/** Wikipedia first, then the broader searches together so a miss is not four waits. */
const STAGES = [[wikipediaSummary], [wikipediaSearch], [commonsSearch, openverse]];

/**
 * First usable picture for `query`, or null when no source has a relevant one — which is
 * the common case for abstract terms, and the right answer for them.
 */
export async function findImage(query) {
  const term = String(query ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (term.length < 2) return null;

  const cached = imageCache.get(term);
  if (cached !== undefined) return cached;

  let failures = 0;
  let attempted = 0;

  for (const stage of STAGES) {
    // Start the stage's sources together, but read them in order so that, on a tie,
    // Commons beats Openverse.
    const running = stage.map((source) => {
      attempted++;
      return source(term).catch((err) => { if (err instanceof SourceError) failures++; return null; });
    });

    for (const attempt of running) {
      const found = await attempt;
      if (!found) continue;
      imageCache.set(term, found);
      return found;
    }
  }

  // Remember "nothing suitable" only when the sources actually answered. Caching a
  // rate-limited silence would hide the picture for good.
  if (failures < attempted) imageCache.set(term, null);
  return null;
}
