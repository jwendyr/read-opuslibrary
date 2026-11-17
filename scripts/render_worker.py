#!/usr/bin/env python3
"""Background Render Worker for Opus Library (polls Cloudflare D1 render_jobs,
synthesizes multi-voice audio + FX, builds Apple Books EPUB3, and uploads to Cloudflare R2)."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

SKILL_SCRIPTS = Path.home() / ".gemini/config/skills/readalong-book-publisher/scripts"


def api_req(base_url: str, secret: str, method: str, path: str, body=None, raw_bytes=None, content_type="application/json"):
    data = raw_bytes if raw_bytes is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
    headers = {"Authorization": f"Bearer {secret}", "User-Agent": "OpusRenderWorker/1.0"}
    if data is not None:
        headers["Content-Type"] = content_type
    req = urllib.request.Request(base_url.rstrip("/") + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def process_job(base_url: str, secret: str, job: dict):
    slug = job["slug"]
    book_json = job["bookJson"]
    print(f"Processing render job {job['jobId']} for {slug}...")

    with tempfile.TemporaryDirectory() as tmp:
        proj = Path(tmp) / slug
        (proj / "chapters").mkdir(parents=True)
        (proj / "studio").mkdir(parents=True)
        (proj / "images").mkdir(parents=True)

        # Write chapters/*.md and studio/cast_script.json
        cast_chapters = []
        for idx, ch in enumerate(book_json.get("chapters", []), 1):
            ch_title = ch.get("title", f"Chapter {idx}")
            segs = ch.get("segments", [])
            md_lines = [f"# {ch_title}", ""] + [s["text"] for s in segs[1:]]
            (proj / "chapters" / f"ch{idx:02d}.md").write_text("\n\n".join(md_lines), encoding="utf-8")
            cast_chapters.append({"chapter": f"ch{idx:02d}", "title": ch_title, "segments": segs})

        (proj / "studio" / "cast_script.json").write_text(
            json.dumps({"title": job["title"], "chapters": cast_chapters}), encoding="utf-8"
        )

        # Generate free ambiance/SFX, synthesize multi-voice, build web reader & EPUB3
        subprocess.run([sys.executable, str(SKILL_SCRIPTS / "audio_fx.py"), "--out-dir", str(proj / "assets" / "audio_fx")], check=True)
        subprocess.run(["uv", "run", "--with", "edge-tts", "python3", str(SKILL_SCRIPTS / "synthesize_multivoice.py"), "--project-dir", str(proj)], check=True)
        subprocess.run([sys.executable, str(SKILL_SCRIPTS / "build_web_reader.py"), "--project-dir", str(proj), "--title", job["title"]], check=True)

        epub_out = proj / "dist" / f"{slug}.epub"
        subprocess.run([
            sys.executable, str(SKILL_SCRIPTS / "build_readalong_epub.py"),
            "--project-dir", str(proj), "--title", job["title"], "--author", job["author"], "--out", str(epub_out)
        ], check=True)

        # Upload audio tracks & EPUB to Cloudflare R2
        updated_book = json.loads((proj / "docs" / "data" / "book.json").read_text(encoding="utf-8"))
        for idx, ch in enumerate(updated_book["chapters"], 1):
            m4a_bytes = (proj / "docs" / "audio" / f"ch{idx:02d}.m4a").read_bytes()
            up = api_req(base_url, secret, "POST", f"/api/worker/upload?key=audio/{slug}/ch{idx:02d}.m4a", raw_bytes=m4a_bytes, content_type="audio/mp4")
            ch["audio"] = up["url"]

        epub_up = api_req(base_url, secret, "POST", f"/api/worker/upload?key=epubs/{slug}.epub", raw_bytes=epub_out.read_bytes(), content_type="application/epub+zip")
        api_req(base_url, secret, "POST", "/api/worker/complete", body={
            "jobId": job["jobId"],
            "bookId": job["bookId"],
            "status": "done",
            "epubUrl": epub_up["url"],
            "bookJson": updated_book,
        })
        print(f"Completed {slug} -> {epub_up['url']}")


def main():
    ap = argparse.ArgumentParser(description="Opus Library D1 -> R2 Render Worker")
    ap.add_argument("--base-url", default="https://read.opuslibrary.com")
    ap.add_argument("--secret", default=os.environ.get("WORKER_SECRET", ""))
    ap.add_argument("--once", action="store_true", help="Process at most one job and exit")
    args = ap.parse_args()
    if not args.secret:
        raise SystemExit("Set --secret or WORKER_SECRET env var")

    while True:
        res = api_req(args.base_url, args.secret, "GET", "/api/worker/next")
        if res.get("job"):
            process_job(args.base_url, args.secret, res["job"])
            if args.once:
                break
        else:
            if args.once:
                print("No queued render jobs.")
                break
            time.sleep(5)


if __name__ == "__main__":
    main()
