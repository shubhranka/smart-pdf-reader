# Smart PDF Reader

A local PDF reader that remembers where you stopped and explains anything you highlight.

- **Resumes automatically.** Your position is saved as you scroll, per document, and restored when you reopen it.
- **Highlight to understand.** Select a word, a phrase or a whole paragraph and press *What does this mean?* Gemini answers with the general meaning plus what it means *in this document*, using the surrounding page as context.
- **Repeat lookups are free.** Identical selections are cached, so re-highlighting a term costs nothing.
- **Lookup history** per document, so you can revisit terms and jump back to the page they came from.

Everything runs on your machine. PDFs live in `pdfs/`, state in a SQLite file under `data/`.

## Setup

```bash
npm install
cp .env.example .env     # then add your key
npm start                # http://localhost:3210
```

Get a Gemini key at <https://aistudio.google.com/apikey> and put it in `.env`:

```
GEMINI_API_KEY=your-key-here
GEMINI_MODEL=gemini-3.5-flash
PORT=3210
```

Other models worth knowing: `gemini-3.8-flash` is smarter and costs more, `gemini-3.5-flash-lite`
is the cheapest and is fine for plain definitions. The `gemini-2.5-*` line is legacy and closed
to new projects — see [the model list](https://ai.google.dev/gemini-api/docs/models).

The reader works without a key — you just get a clear message instead of an explanation when you highlight something.

## Using it

Drop a PDF onto the library page, or click to choose one. Click a document to open it.

| | |
|---|---|
| Highlight text | Offers an explanation |
| Scroll | Saves your page automatically |
| `←` / `→` buttons, or type a page number | Jump around |
| `Cmd`/`Ctrl` `+` / `-` / `0` | Zoom in, out, back to 100% |
| History button (top right) | Past lookups in this document |
| `Esc` | Close a panel, then leave the document |

Zoom runs from 50% to 500% in round steps (50, 75, 100, 125, 150, 200, 250, 300, 400, 500).
Past about 150% a page grows wider than the window and the view scrolls sideways as well as down;
zooming keeps whatever was in the middle of the screen in the middle.

Re-uploading a PDF you already have reopens it rather than making a duplicate — documents are identified by their content hash.

## How it fits together

```
public/            the browser side, no build step
  app.js             hash routing: library  <->  #/doc/<id>
  library.js         upload, drag-and-drop, document list
  reader.js          PDF.js viewer, scroll tracking, selection, panels
  api.js             fetch wrappers

server/
  index.js           Express routes
  db.js              SQLite schema and queries (node:sqlite, no native build)
  explain.js         Gemini call, prompt construction, response cache
  pdfinfo.js         page count and title, read server-side on upload
  config.js          env and paths

test/e2e.mjs       drives the real UI in Chrome against a stub Gemini
```

Some details worth knowing if you extend it:

- **Pages render lazily.** Only pages near the viewport hold a canvas; the rest are
  placeholders sized from page 1, so a 900-page PDF opens instantly and stays responsive.
  `KEEP_RENDERED` in `reader.js` caps how many stay in memory.
- **"Current page"** is whichever page sits a third of the way down the viewport
  (`PROBE_RATIO`), which matches where your eye actually is better than the top edge does.
- **Position is saved** on a 700 ms debounce, and flushed with `sendBeacon` when you close
  the tab, so the last few seconds of reading are not lost.
- **Explanations are structured**, not free text: `explain.js` asks Gemini for a fixed JSON
  schema (`headline`, `kind`, `meaning`, `inContext`, `details`) through `response_format`,
  so the panel can lay the answer out instead of dumping a paragraph. `thinking_level` is
  `minimal` — a definition does not need deliberation and thinking roughly doubles latency —
  and `store: false` keeps the lookups off Google's servers.
- **The Gemini call uses the [Interactions API](https://ai.google.dev/gemini-api/docs/text-generation)**:
  `POST /v1beta/interactions` with an `Api-Revision` header, a plain-string `input`, and the
  answer read back out of the `steps` array. `outputText()` in `explain.js` takes the trailing
  run of text blocks, the same rule the SDKs' `output_text` follows, so reasoning or tool
  blocks earlier in a response are skipped.
- **Rendering is memory-capped.** A page at 500% on a retina screen would otherwise back a
  ~190 MB canvas. `MAX_CANVAS_PIXELS` caps any single page and `RENDER_BUDGET_PIXELS` caps
  the total across rendered pages, so pages you have scrolled away from are released early
  when zoomed in rather than only when you are ten pages past them.
- **Single words, short phrases and long passages get different prompts.** Words get a
  definition with part of speech and an example; passages get an explanation with the
  jargon unpacked.

## Tests

```bash
npm test
```

Boots the server against a throwaway directory and a stub Gemini, then drives the real UI
in headless Chrome: upload, dedupe, lazy rendering, scroll tracking, save and resume,
highlight-to-explain, history, zoom and page jumps. It never touches your own library and
makes no network calls. Needs Google Chrome (or set `CHROME_PATH`).

## Ideas for next

Highlights that persist on the page, notes attached to a selection, full-text search,
an "explain this whole page" button, and exporting lookups as flashcards.
