#!/usr/bin/env python3
"""Regenerate src/words.js from the SOWPODS word list.

The game ships its dictionary as a JS module so the page has no runtime network
dependency. Run this only when the dictionary needs refreshing:

    python3 tools/build-words.py

Pass --source <path> to build from a local copy instead of downloading.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
import urllib.request

SOURCE_URL = "https://raw.githubusercontent.com/jesstess/Scrabble/master/scrabble/sowpods.txt"
WORD_LEN = 4
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "words.js"

HEADER = """\
// Auto-generated from the SOWPODS Scrabble word list (public domain word set).
// Source: {url}
// Filtered to the {count} four-letter entries. Do not edit by hand; see tools/build-words.py.
export const WORDS = Object.freeze('{body}'.split(','));
export const WORD_SET = new Set(WORDS);
export const isWord = (w) => WORD_SET.has(w.toLowerCase());
"""


def load(source: str | None) -> str:
    if source:
        return pathlib.Path(source).read_text(encoding="utf-8")
    with urllib.request.urlopen(SOURCE_URL, timeout=60) as response:
        return response.read().decode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", help="local word list instead of downloading")
    args = parser.parse_args()

    pattern = re.compile(f"^[a-z]{{{WORD_LEN}}}$")
    words = sorted({w for w in (t.strip().lower() for t in load(args.source).split()) if pattern.match(w)})
    if len(words) < 1000:
        print(f"refusing to write: only {len(words)} words parsed", file=sys.stderr)
        return 1

    OUT.write_text(HEADER.format(url=SOURCE_URL, count=len(words), body=",".join(words)), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} with {len(words)} words")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
