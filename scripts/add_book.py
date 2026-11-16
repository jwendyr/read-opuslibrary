#!/usr/bin/env python3
"""Register a readalong-book-publisher project into the read.opuslibrary.com multi-book portal."""

import argparse
import json
import shutil
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description="Add/update a book in read-opuslibrary portal")
    ap.add_argument("--portal-dir", default="/Users/jwendyr/Desktop/Workspace/read-opuslibrary")
    ap.add_argument("--book-dir", required=True, help="Source book project directory")
    ap.add_argument("--slug", required=True, help="URL slug (e.g. pride-and-prejudice-2026)")
    ap.add_argument("--title", required=True)
    ap.add_argument("--author", required=True)
    ap.add_argument("--subtitle", default="2026 Modern All-Ages Edition")
    ap.add_argument("--epub-url", default="#")
    ap.add_argument("--repo-url", default="#")
    args = ap.parse_args()

    portal = Path(args.portal_dir).resolve()
    book = Path(args.book_dir).resolve()
    dest = portal / "docs" / "books" / args.slug
    (dest / "audio").mkdir(parents=True, exist_ok=True)

    shutil.copy2(book / "docs" / "data" / "book.json", dest / "book.json")
    if (book / "images" / "cover.jpg").exists():
        shutil.copy2(book / "images" / "cover.jpg", dest / "cover.jpg")
    for m4a in (book / "docs" / "audio").glob("*.m4a"):
        shutil.copy2(m4a, dest / "audio" / m4a.name)
    if (book / "docs" / "images").exists():
        (dest / "images").mkdir(exist_ok=True)
        for img in (book / "docs" / "images").glob("ch*.*"):
            shutil.copy2(img, dest / "images" / img.name)

    bdata = json.loads((dest / "book.json").read_text(encoding="utf-8"))
    word_count = sum(len(c.get("words", [])) for c in bdata.get("chapters", []))

    cat_path = portal / "docs" / "catalog.json"
    cat = json.loads(cat_path.read_text(encoding="utf-8"))
    entry = {
        "slug": args.slug,
        "title": args.title,
        "subtitle": args.subtitle,
        "author": args.author,
        "chapters": len(bdata.get("chapters", [])),
        "words": word_count,
        "features": ["Multi-Voice Cast", "Word-by-Word Sync"],
        "cover": f"books/{args.slug}/cover.jpg",
        "epubUrl": args.epub_url,
        "repoUrl": args.repo_url,
    }
    cat["books"] = [b for b in cat["books"] if b["slug"] != args.slug]
    cat["books"].insert(0, entry)
    cat_path.write_text(json.dumps(cat, indent=2), encoding="utf-8")
    print(f"Registered {args.slug} ({entry['chapters']} chapters, {word_count:,} words) into {portal}")


if __name__ == "__main__":
    main()
