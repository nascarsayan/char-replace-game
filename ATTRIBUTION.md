# Attribution

The code in this repository is mine. The bundled word data is not, and carries its
own terms.

## `src/words.js` — the playable word list

Derived from the SOWPODS Scrabble word list, filtered to its four-letter entries.
Word lists of this kind are widely redistributed as plain factual data.

Source: <https://github.com/jesstess/Scrabble> (`scrabble/sowpods.txt`)
Regenerate with `python3 tools/build-words.py`.

## `assets/definitions.json` — the definitions shown while playing

Built from two sources, so this file is a derivative of both.

### Wordset — CC BY-SA 4.0

Most modern entries come from Wordset, which is itself built on WordNet 3.0.

- Source: <https://github.com/wordset/wordset-dictionary>
- Licence: [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/)
- © Wordset, Inc.
- Contains material from WordNet 3.0, © 2006 Princeton University.

**This is a share-alike licence.** `assets/definitions.json`, and any further
adaptation of it, is therefore distributed under CC BY-SA 4.0 with the
attribution above. That obligation applies to the definition data only — not to
the code in this repository, which is a separate work that merely displays it.

### Webster's Unabridged Dictionary (1913) — public domain

Fills in the archaic and obscure entries a Scrabble word list is full of, which
Wordset does not cover. The 1913 edition is in the public domain.

- Source: <https://github.com/matthewreagan/WebstersEnglishDictionary>

Regenerate with `python3 tools/build-definitions.py`. Neither source is vendored;
the generator downloads them on demand.

## `vendor/`

Third-party libraries, kept as pinned copies so the page needs no CDN at runtime.
Each remains under its own licence:

| Path | Project | Licence |
| --- | --- | --- |
| `vendor/pico.min.css` | [Pico CSS](https://picocss.com/) 2.0.6 | MIT |
| `vendor/preact-standalone.module.js` | [htm](https://github.com/developit/htm) + [Preact](https://preactjs.com/) | Apache-2.0 (htm), MIT (Preact) |
| `vendor/trystero/` | [Trystero](https://github.com/dmotz/trystero) 0.21.5, torrent strategy | MIT — see `vendor/trystero/LICENSE` |
