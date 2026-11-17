# Opus Library (`read.opuslibrary.com`)

Multi-book Read-Aloud platform built on **Cloudflare Pages**, **Pages Functions**, **D1**, and **R2**, serving synchronized theatrical audio books, Apple Books Fixed-Layout EPUB3 downloads, and open reading-app feeds (OPDS 1.2 Atom, OPDS 2.0 JSON, W3C Web Publication Manifest, OpenSearch, OpenAPI, and `llms.txt`).

- **Live Portal**: https://read.opuslibrary.com
- **Developer & AI Agent Hub**: https://read.opuslibrary.com/developers.html
- **AI Discovery (`llms.txt`)**: https://read.opuslibrary.com/llms.txt
- **OpenAPI Spec**: https://read.opuslibrary.com/openapi.json
- **OPDS 1.2 / 2.0**: https://read.opuslibrary.com/opds.xml · https://read.opuslibrary.com/opds.json

## Repository Layout

- `docs/` — Static frontend & static discovery assets (`index.html`, `reader.html`, `create.html`, `developers.html`, `llms.txt`, `openapi.json`, `opensearch.xml`, `opds.xml`, `opds.json`)
- `functions/` — Cloudflare Pages Functions (`api/[[path]].js`, `opds.xml.js`, `opds.json.js`, `_middleware.js`)
- `schema.sql` — Cloudflare D1 schema (`books`, `chapters`, `render_jobs`, `users`, `sessions`)
- `wrangler.toml` — Cloudflare Pages / D1 / R2 configuration
- `scripts/add_book.py` — Register a local `readalong-book-publisher` project into the portal
- `scripts/render_worker.py` — Background worker that polls D1 `render_jobs`, synthesizes multi-voice audio + FX, builds Fixed-Layout EPUB3, and uploads assets to R2
- `scripts/pipeline/` — Self-contained copy of the `readalong-book-publisher` Python pipeline scripts (`audio_fx.py`, `build_readalong_epub.py`, `build_web_reader.py`, `clean_illustrations.py`, `generate_cast_script.py`, `synthesize_multivoice.py`)

## Building & Publishing Books

### 1. Book Pipeline (`scripts/pipeline/`)
Inside any book project directory (with `BOOK.md` or `chapters/ch*.md`):

```bash
python3 scripts/pipeline/generate_cast_script.py
python3 scripts/pipeline/audio_fx.py                # optional procedural ambiance & SFX
python3 scripts/pipeline/synthesize_multivoice.py
python3 scripts/pipeline/clean_illustrations.py     # optional transparent PNG cleanup
python3 scripts/pipeline/build_readalong_epub.py
epubcheck dist/<book-slug>-word-by-word.epub
python3 scripts/pipeline/build_web_reader.py
```

The standalone Antigravity skill repository is also maintained at https://github.com/jwendyr/readalong-book-publisher.

### 2. Register a Book into `read-opuslibrary`

```bash
python3 scripts/add_book.py \
  --book-dir /Volumes/App/Workspace/<book-dir> \
  --slug <url-slug> \
  --title "<Book Title>" \
  --author "<Author>"
```

### 3. Run the Background Render Worker

```bash
python3 scripts/render_worker.py --base-url https://read.opuslibrary.com --secret "$RENDER_WORKER_SECRET"
```

(`render_worker.py` automatically uses `~/.gemini/config/skills/readalong-book-publisher/scripts` if present, and falls back to `scripts/pipeline/`.)

## Deployment

Pushing to `main` triggers **Cloudflare Pages** automatic deployment for `read.opuslibrary.com`.
