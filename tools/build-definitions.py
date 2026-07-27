#!/usr/bin/env python3
"""Build assets/definitions.json — a short gloss for each four-letter game word.

Two sources, in order of preference:

1. Wordset (https://github.com/wordset/wordset-dictionary), CC-BY-SA 4.0, built
   on WordNet 3.0. Short, modern, one clause per sense — ideal here.
2. Webster's Unabridged 1913 (public domain). Covers the archaic and obscure
   entries a Scrabble word list is full of, which Wordset does not have. Its
   entries are long and citation-heavy, so they are cut down to one gloss.

Words that appear only as an inflection ("aces", "acted") fall back to their base
form and say so. Anything still unresolved is left out, and the UI reports the
word as having no bundled definition rather than inventing one.

    python3 tools/build-definitions.py --wordset .local/wordset --webster .local/webster.json

With no arguments both sources are downloaded. See ATTRIBUTION.md for the licence
terms that apply to the generated file.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import urllib.request

WEBSTER_URL = (
    'https://raw.githubusercontent.com/matthewreagan/WebstersEnglishDictionary'
    '/master/dictionary_compact.json'
)
WORDSET_URL = (
    'https://raw.githubusercontent.com/wordset/wordset-dictionary/master/data/{letter}.json'
)
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'definitions.json'
MAX_LEN = 150
MIN_USEFUL = 25

CITATION = re.compile(r'\s*(?:[A-Z][a-z]*\.\s*){1,3}$')
BRACKETED = re.compile(r'\[[^\]]*\]')
QUOTED = re.compile(r'"[^"]*"')
SENSE_BREAK = re.compile(r'\s\(?[2-9]\)?\.\s')
LEADING_SENSE = re.compile(r'^\s*\(?1\)?\.\s*')
# "P. p. of Rive." and friends are grammar notes, not definitions.
LEADING_FORM_NOTE = re.compile(r'^\s*(?:[a-z]\.\s*){1,3}of\s+\w+\.\s*', re.I)
CROSS_REF = re.compile(r'^\s*(?:See|Same as|Alt\. of)\s+([A-Za-z][A-Za-z\'-]*)', re.I)
WHITESPACE = re.compile(r'\s+')
SPEECH_SHORT = {
    'noun': 'n.',
    'verb': 'v.',
    'adjective': 'adj.',
    'adverb': 'adv.',
    'pronoun': 'pron.',
    'preposition': 'prep.',
    'conjunction': 'conj.',
    'interjection': 'interj.',
}


def shorten(text: str) -> str:
    """Trim to a readable length, preferring a clause boundary."""
    if len(text) <= MAX_LEN:
        return text.rstrip(' ,;:')
    cut = text[:MAX_LEN]
    for sep in ('; ', ', ', ' '):
        if sep in cut:
            cut = cut.rsplit(sep, 1)[0]
            break
    return cut.rstrip(' ,;:') + '…'


def sentences(text: str) -> list[str]:
    return [part.strip() for part in re.split(r'(?<=\.)\s+', text) if part.strip()]


def webster_gloss(raw: str) -> str:
    """Reduce one Webster entry to a single short gloss."""
    # Senses are often separate paragraphs (a noun sense, then a verb sense).
    for paragraph in [p for p in re.split(r'\n+', raw) if p.strip()]:
        text = LEADING_SENSE.sub('', paragraph)
        text = LEADING_FORM_NOTE.sub('', text)
        text = SENSE_BREAK.split(text)[0]
        text = QUOTED.sub('', text)
        text = BRACKETED.sub('', text)
        text = WHITESPACE.sub(' ', text).strip()

        # Keep whole sentences until there is something substantial, which drops
        # the illustrative quotations Webster appends.
        kept: list[str] = []
        for sentence in sentences(text):
            kept.append(sentence)
            if len(' '.join(kept)) >= MIN_USEFUL:
                break
        if kept:
            text = ' '.join(kept)

        # Only strip a trailing citation when something substantial survives, or
        # "See Gnar. Chaucer." collapses to a useless "See".
        stripped = CITATION.sub('', text).strip()
        if len(stripped) >= MIN_USEFUL:
            text = stripped
        text = text.strip()
        if text:
            return shorten(text)
    return ''


def wordset_gloss(entry: dict) -> str:
    for meaning in entry.get('meanings') or []:
        definition = (meaning.get('def') or '').strip()
        if not definition:
            continue
        part = SPEECH_SHORT.get(meaning.get('speech_part', ''), '')
        text = f'{part} {definition}' if part else definition
        return shorten(WHITESPACE.sub(' ', text).strip())
    return ''


def load_webster(path: str | None) -> dict[str, str]:
    if path:
        raw = pathlib.Path(path).read_text(encoding='utf-8')
    else:
        with urllib.request.urlopen(WEBSTER_URL, timeout=300) as response:
            raw = response.read().decode('utf-8')
    return {k.lower(): v for k, v in json.loads(raw).items() if isinstance(v, str)}


def load_wordset(directory: str | None) -> dict[str, dict]:
    merged: dict[str, dict] = {}
    for letter in 'abcdefghijklmnopqrstuvwxyz':
        if directory:
            path = pathlib.Path(directory) / f'{letter}.json'
            if not path.exists():
                continue
            raw = path.read_text(encoding='utf-8')
        else:
            with urllib.request.urlopen(WORDSET_URL.format(letter=letter), timeout=300) as response:
                raw = response.read().decode('utf-8')
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        for key, value in data.items():
            if isinstance(value, dict):
                merged[key.lower()] = value
    return merged


def base_forms(word: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    if word.endswith('s') and not word.endswith('ss'):
        out.append((word[:-1], 'Plural or third-person of'))
        if word.endswith('es'):
            out.append((word[:-2], 'Plural or third-person of'))
    if word.endswith('ed'):
        out += [(word[:-2], 'Past tense of'), (word[:-1], 'Past tense of')]
    if word.endswith('ing'):
        out.append((word[:-3], 'Present participle of'))
    if word.endswith('er'):
        out.append((word[:-2], 'Comparative or agent form of'))
    if word.endswith('ly'):
        out.append((word[:-2], 'Adverb form of'))
    if word.endswith('y'):
        out.append((word[:-1], 'Adjective form of'))
    return [(base, label) for base, label in out if len(base) >= 2]


def game_words() -> list[str]:
    text = (ROOT / 'src' / 'words.js').read_text(encoding='utf-8')
    match = re.search(r"Object\.freeze\('([^']+)'\.split", text)
    if not match:
        raise SystemExit('could not read the word list out of src/words.js')
    return match.group(1).split(',')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--webster', help='local Webster JSON')
    parser.add_argument('--wordset', help='local directory of wordset a.json … z.json')
    args = parser.parse_args()

    wordset = load_wordset(args.wordset)
    webster = load_webster(args.webster)
    words = game_words()

    def lookup(word: str, depth: int = 0) -> tuple[str, str]:
        """(gloss, source) for a word, preferring the concise modern source."""
        if word in wordset:
            gloss = wordset_gloss(wordset[word])
            if gloss:
                return gloss, 'wordset'
        raw = webster.get(word)
        if raw:
            gloss = webster_gloss(raw)
            ref = CROSS_REF.match(gloss)
            if ref and depth < 1:
                target = ref.group(1).lower()
                if target != word:
                    via, _ = lookup(target, depth + 1)
                    if via:
                        return f'Same as {target.upper()}: {via[:1].lower() + via[1:]}', 'webster'
            if gloss:
                return gloss, 'webster'
        return '', ''

    # An unresolved cross-reference ("See 3d Trone") teaches nobody anything, so
    # it is dropped in favour of admitting the word has no definition.
    def usable(gloss: str) -> bool:
        if len(gloss) < 15:
            return False
        head = re.match(r'^(?:See|Same as|Alt\. of)\b', gloss)
        return not head or ':' in gloss

    definitions: dict[str, str] = {}
    counts = {'wordset': 0, 'webster': 0, 'inflected': 0}

    for word in words:
        gloss, source = lookup(word)
        if gloss and not usable(gloss):
            gloss = ''
        if gloss:
            definitions[word] = gloss
            counts[source] += 1
            continue
        for base, label in base_forms(word):
            via, _ = lookup(base)
            if via and usable(via):
                definitions[word] = f'{label} {base.upper()}: {via[:1].lower() + via[1:]}'
                counts['inflected'] += 1
                break

    if len(definitions) < len(words) // 2:
        print(
            f'refusing to write: only {len(definitions)} of {len(words)} resolved',
            file=sys.stderr,
        )
        return 1

    OUT.write_text(json.dumps(definitions, ensure_ascii=False, sort_keys=True), encoding='utf-8')
    covered = len(definitions)
    print(
        f'wrote {OUT.relative_to(ROOT)}: {covered}/{len(words)} words '
        f'({100 * covered / len(words):.1f}%)'
    )
    print(
        f'  wordset {counts["wordset"]}, webster {counts["webster"]}, '
        f'via a base form {counts["inflected"]}'
    )
    print(f'  file size: {OUT.stat().st_size / 1024:.0f} KiB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
