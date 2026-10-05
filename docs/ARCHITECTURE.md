# How Smart PDF Reader works

Notes for anyone extending the app. For setup and everyday use, see the [README](../README.md).

## Layout

```
public/            the browser side, no build step
  app.js             hash routing: library  <->  #/doc/<id>
  library.js         upload, drag-and-drop, document list
  reader.js          PDF.js viewer, scroll tracking, selection, panels
  diagram.js         lays out and sketches a recap's diagram with rough.js; shared sketch helpers
  mindmap.js         lays out and sketches a passage's mind map with rough.js
  tracker.js         the reading tracker: word geometry, springs, pacing, read-aloud loop
  speech-text.js     what a voice should say for a page: sentences, headings, skipped marks
  narrator.js        the voices: Kokoro via /api/speech, or the browser's speechSynthesis
  ink.js             pen, highlighter, eraser and scratch pad: layers, pointer input, undo, saving
  ink-format.js      what a stroke is and the rules it must meet; shared with the server
  api.js             fetch wrappers

server/
  index.js           Express routes
  config.js          env and paths; env() is how provider modules read their settings
  db.js              SQLite schema and queries (node:sqlite, no native build)
  errors.js          ExplainError, turned into { error, hint } by the route handler
  llm/
    index.js         picks the provider; callModel(), requireKey(), MODEL
    shared.js        deadlines, error mapping, JSON parsing, strict-schema rewriting
    providers/
      gemini.js      Gemini on the Interactions API: wire format, errors, thinking level
      mistral.js     Mistral on chat completions
      groq.js        Groq on chat completions, strict schemas and reasoning effort
      openrouter.js  OpenRouter on chat completions, strict schemas, private routing
      nvidia.js      NVIDIA NIM, hosted or self-hosted; falls back to guided_json
  features/
    explain.js       lookup prompt, schema and response cache
    recap.js         recap prompts, one call vs map-reduce, chunk cache
    mindmap.js       mind map prompt, schema, tree clean-up and cache
    images.js        picture search and the image proxy's host list
    speech.js        read-aloud: lazy Kokoro model, one-at-a-time queue, test stub
    ink.js           checks a page of strokes against public/ink-format.js before it is stored
  pdf/
    pagetext.js      server-side page text, cached per page, and the line cut
    pdfinfo.js       page count and title, read server-side on upload

test/e2e.mjs       drives the real UI in Chrome against a stub Gemini
```

## Details worth knowing

- **Reading aloud runs Kokoro in the server process, and it sends no word timings.**
  `kokoro-js` is imported lazily on the first `/api/speech/load`, so a reader who never presses
  the speaker pays nothing, and the model (~90 MB) is kept in `models/`, apart from `data/`.
  Generation runs one job at a time, since ONNX already uses every core, and a job whose
  request was aborted is skipped. The pill still follows each word: `narrator.js` scans the
  clip for where speech starts and stops and for its silent gaps, splits the sentence at its
  commas into clauses matched to the longest gaps, and spreads each clause's words over its
  stretch of sound by letter count. The clip's own lead-in and tail are trimmed so the pause
  between chunks is chosen, not accidental. Chunks come from `speech-text.js` — a sentence,
  or a heading on its own (spotted by a change of type size or a big step down, and given a
  full stop so it is said like one), crossing page turns — and three are fetched ahead,
  because generation is about 0.45× real time and a long sentence after a short heading would
  otherwise leave a gap. `TTS_ENGINE=stub` answers with a tone shaped like speech, which is
  what the test suite uses.

- **Ink lives in page units, so zoom never touches it.** A stroke is stored in the page's own
  size at 100%, and each rendered page carries one SVG whose viewBox is that size, stretched
  over the page box. The box already follows the live zoom, so ink keeps up with a pinch for
  free and stays sharp at 500%. The layer is a sibling of `.page-inner`, not inside it, and
  `ink.js` keeps it across re-renders. The pointer is captured by the `.page` itself, so
  re-appending the layer mid-stroke does not drop the stroke. The scratch pad is page 0 of the same table: a
  sheet 600 units wide whose viewBox grows as the notes do. Pen strokes are filled
  [perfect-freehand](https://github.com/steveruizok/perfect-freehand) outlines with
  **`simulatePressure: false`**. Its default replaces real pen pressure with a guess from
  speed. The other settings are tldraw's for a real-pressure pen (0.62 for thinning,
  streamline and smoothing, and its pressure easing). Those smooth out a tablet sensor's
  wobble. Because the smoothing depends on how far apart the samples are, **pen strokes
  keep every sample**. A thinned copy would be drawn a little differently from the line
  that was drawn, and visibly shift on pen-up. For the same reason, the pieces of a line in
  progress are slices of one smoothing pass over the whole line, not separately smoothed
  stretches. Highlighters, a plain centreline, are thinned with Ramer–Douglas–Peucker.
  Points are added back along long gaps before drawing (`densify`). With only two points,
  perfect-freehand draws a straight run at full width whatever its pressure. Pressure is kept from a `pen`, and from
  a `mouse` whose pressure really varies, because some tablet drivers report themselves as a mouse.
  A stroke in progress is redrawn **inside each pointer event**, not in a
  `requestAnimationFrame`. Deferring it looks tidier but costs a whole frame: Chrome's
  `InputLatency::MouseMove` went from 6.8 ms to 23.7 ms, and tldraw measures 6.8 ms. A test
  guards this. Redrawing per event is affordable because the line is drawn in pieces of 32
  samples and finished pieces are left alone, about 0.2 ms however long the line gets. Its tip runs out to the browser's
  `getPredictedEvents()`, which hides a frame or so more. On pen-up the pieces give way to
  one path.
  On dark pages, `ink.js` works out the colours through the same matrix as the canvas's
  `invert(0.9) hue-rotate(180deg)`, rather than filtering the layer. A filter on a page-sized
  layer would be redone on every frame of a stroke.
- **A page of ink is saved whole, one request at a time.** Every change marks its page dirty.
  Half a second later the page's full list is PUT, on a promise chain owned by the
  long-lived `createInk` factory. So the request that lands last carries the newest version,
  and an undo can never be overtaken by the stroke it undid. Opening a book waits for that
  chain to drain before it reads, so a book closed and reopened at once never loads stale
  ink. Nothing can be drawn until the load succeeds; otherwise a failed read followed by a
  save would wipe the stored copy. A tab going away (`visibilitychange` to hidden, `pagehide`)
  sends pending pages with `keepalive`. The browser lets all such requests carry only about
  64 KB between them, `sendBeacon` included, so progress goes first, then the smallest pages
  fit into what is left. `beforeunload` warns only while ink is unsaved. The validation rules sit
  in `public/ink-format.js`, which has no DOM and no imports, so the server and the tests load
  the very same file. Ink routes get their own 8 MB body parser ahead of the global 1 MB one.
  The error handler passes the body parser's 4xx refusals through, rather than turning them
  into 500s that would look worth retrying.

- **Page text is extracted on the server, not taken from the browser.** The viewer only
  captures text for pages it has actually drawn, so everything you scrolled past — and any
  page you reached by typing its number — has none. `pagetext.js` pulls the text with the same
  pdf.js build `pdfinfo.js` uses and caches it per page in `page_text`; a document id is a
  content hash, so that text can never go stale. Two details earn their keep: pdf.js emits
  explicit space items between words, so the pieces are joined with **no separator** (the
  browser's `join(' ')` puts spaces inside words), and words broken across a line end are
  rejoined — the hyphen there is usually **U+2010, not ASCII `-`**, which a naive `/-$/`
  misses entirely. Running heads are dropped by counting repeated first and last lines.
- **A recap is one call when it can be.** Under `RECAP_BUDGET_CHARS` (~26 pages) the whole
  range goes to the model at once. Above it the range is summarised in chunks and the notes
  combined — not because the window is too small, a flash model would swallow a whole book,
  but because a single call over a hundred pages goes shallow and front-loaded, and because
  chunks can be reused. `RECAP_MAX_PAGES` is what bounds the cost: at roughly twenty pages a
  chunk, the 300-page maximum is about fifteen calls.
- **Chunk boundaries come from the document, not the request.** Chunks are packed from page 1
  at a fixed size every time, so reading further reuses the notes already paid for instead of
  re-cutting the same pages under different boundaries. On a real book, recaps to page 100,
  200 and 300 all start `1-32, 33-49, 50-70, 71-89` — extending one re-pays for the single
  partial chunk it ended in the middle of. Sizing chunks from the *range* instead would look
  tidier and would quietly destroy this, which is why the size is a constant. The cache key
  includes a hash of the chunk's own text, so tuning the extraction rules invalidates it
  automatically, and a recap cut mid-page keys correctly with no special case.
- **The recap's diagram is a typed graph, never SVG from the model.** Asking a model for
  coordinates is how model-drawn diagrams fail, so it returns nodes and labelled edges and
  nothing else; `recap.js` drops edges that name a node that does not exist, and
  `public/diagram.js` decides the layout, where the panel's real width is known. rough.js
  writes its colours into the paths it generates, so the sketch is **redrawn on a theme
  change** — otherwise it keeps the old palette while the labels, which are plain text styled
  by CSS, follow the new one. The **mind map works the same way**: the model returns a tree of
  labels (topic, branches, leaves), `features/mindmap.js` drops empty and repeated labels, and
  `public/mindmap.js` places the branches either side of the topic and sizes each row from its
  wrapped labels. Both drawings share `watchTheme()` from `diagram.js` for the redraw.
- **A lookup and a recap want different amounts of thinking.** A definition is recall, so it
  asks for `minimal`. A recap is selection and ordering across tens of thousands of words, so
  it asks for `low` — and chunk notes go back to `minimal`, because that cost is multiplied by
  every chunk. Models differ on which levels they accept; `llm/providers/gemini.js` reads the allowed values
  out of a rejection and remembers them, per level asked for.

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
  answer read back out of the `steps` array. `outputText()` in `llm/providers/gemini.js` takes the trailing
  run of text blocks, the same rule the SDKs' `output_text` follows, so reasoning or tool
  blocks earlier in a response are skipped.
- **Each provider speaks its own dialect, in its own file.** Mistral gets a system and a
  user message at `POST {base}/chat/completions`, with the JSON Schema under
  `response_format.json_schema`, and answers in `choices[0].message.content`. Groq is called like Mistral, but its
  strict mode demands every field be required. So `strictSchema()` in `shared.js` marks
  optional fields as required-but-nullable, and `dropNulls()` removes them from the answer. It also maps
  `thinking_level` onto Groq's `reasoning_effort`, and adds 2,048 tokens to the output
  budget because reasoning counts against it. Mistral drops `thinking_level`: for more or less deliberation, choose a reasoning or
  non-reasoning model. The model name is part of every cache key, so switching
  provider never serves you another model's cached answer.
  OpenRouter is called the same way, and also tells its router to use only upstream
  providers that honour `response_format` (`require_parameters`) and that do not keep
  prompts (`data_collection: 'deny'`).
  NVIDIA NIM models disagree on the details, so `nvidia.js` corrects itself like
  `gemini.js` does: if the server refuses `response_format` it retries with NIM's
  `nvext.guided_json`, and if it refuses `reasoning_effort` it drops it, remembering
  either for later calls. Its instructions go in the user turn, since NIM model
  references say roles must alternate user/assistant.
  Adding another provider is one file in `llm/providers/` plus one line in `llm/index.js`.
- **Pinch-zoom previews, then sharpens.** Re-rendering the PDF on every frame of a pinch
  would be unusable, so a gesture only resizes each page box and scales the pixels already
  drawn with a CSS transform — canvas and text layer share one wrapper, which keeps
  selection lined up with the glyphs mid-gesture. 180 ms after the gesture stops, the pages
  re-render at the new size. Pages already on screen keep their old rendering until the
  sharp one is ready, so nothing flashes blank. Page boxes derive their size from a single
  `--zoom` variable on the viewer, so a pinch frame costs a couple of style writes rather
  than two per page — which matters at nine hundred pages.
- **Finding a phrase again** is done by matching against the text layer's whole text, not
  span by span: PDF text layers break words across spans mid-word, so `findPhrase` in
  `reader.js` tries the phrase with whitespace collapsed, then with it removed entirely.
  The highlight is drawn as boxes inside `.page-inner`, under the text layer so the words
  stay selectable, and in the wrapper's own coordinates so the zoom transform scales it.
- **Pictures are opt-in per lookup.** Gemini returns an `imageQuery` only when a picture
  would tell you something the words do not, and the app tries Wikipedia, then a Wikipedia
  search, then Wikimedia Commons and Openverse together. A result is only used if the whole
  phrase appears in its title — without that, keyword search answers "write-ahead log" with
  a photo of a dragonfly and "B-tree" with a fractal tree. An irrelevant picture is worse
  than none here, so no picture is a perfectly good answer.
- **Images are proxied, not hotlinked**, through `/api/image/file`, which accepts only the
  handful of hosts our own sources return. That keeps the browser from telling a third
  party what you are reading, and stops the endpoint being used to fetch anything else.
  They are fetched after the explanation is already on screen, so a slow encyclopaedia
  never delays the meaning.
- **`thinking_level` corrects itself.** Models disagree about which levels they accept —
  `gemini-3.8-flash` rejects `minimal`. When the API refuses one it names the ones it takes,
  so `llm/providers/gemini.js` retries with the cheapest allowed and remembers it, rather than making you
  edit a config file. Override with `GEMINI_THINKING_LEVEL` if you want a specific level.
- **Rendering is memory-capped.** A page at 500% on a retina screen would otherwise back a
  ~190 MB canvas. `MAX_CANVAS_PIXELS` caps any single page and `RENDER_BUDGET_PIXELS` caps
  the total across rendered pages, so pages you have scrolled away from are released early
  when zoomed in rather than only when you are ten pages past them.
- **Single words, short phrases and long passages get different prompts.** Words get a
  definition with part of speech and an example; passages get an explanation with the
  jargon unpacked.

