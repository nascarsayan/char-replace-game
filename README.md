# Char Replace

A two-player word duel. The board holds a four-letter word; on your turn you
replace exactly one letter to make a different four-letter word. Every letter
you place is a card, and you only get one of each. Run out of legal moves and
you lose.

**Play: https://nascarsayan.github.io/char-replace-game/** — password `chargame`.

Three ways to play: [live](#playing-live) over a direct browser-to-browser
connection, side by side on one device, or [by link](#playing-by-link) if you are
not online at the same time.

## Rules

1. The board starts on a random four-letter word. Players alternate turns.
2. A turn is one substitution: pick a slot, put a different letter in it, and the
   result must be a four-letter dictionary word.
3. No word may appear twice in the same game.
4. The letter you place is spent. You hold 26 letter cards plus 1 wildcard —
   **27 cards** in total.
5. The wildcard lets you replay one letter you have already spent. The result
   still has to be a real word. You get one, ever.
6. The first player with no legal move left loses.

Both racks are visible at all times: knowing which letters your opponent has
burned, and whether they still hold their wildcard, is the game.

Keyboard: `1`–`4` or `←`/`→` pick a slot, a letter key plays it, `Esc` clears.

## Playing live

Pick **Play live**, then **Host a new game**. You get a six-character room code
and an invite link; send either to your opponent, who joins with it. Moves then
appear on both boards as they are made.

The two browsers talk directly over WebRTC. Public WebTorrent trackers are used
only to introduce the peers — no game data passes through them, and there is no
server of ours anywhere in the loop.

Each browser holds a **fixed side**: the host plays first, the joiner second. The
board says which one you are, marks your rack, and refuses input when it is not
your move.

Being honest about the limits: this needs you both online at the same time, and
it leans on free public signalling that is occasionally down or rate-limited.
Very restrictive networks (some corporate NATs) can block the direct connection
outright, because there is no TURN relay to fall back on. When live will not
connect, the link method below always works.

## Playing by link

No connection needed at all — the link *is* the transport, correspondence-chess
style. You do not both need to be online at once.

1. Start a game and take your turn.
2. The board shows **"<opponent> is up — send them this link"**. Copy it and send
   it however you like: chat, email, anything.
3. They open it, play their turn, and get a fresh link to send back.

Whoever opens a link plays the side that is on turn. The joiner needs no account
and no local setup — just the page password. A shared game lives entirely in the
URL, so reloading is safe and it never touches the saved local game.

### What the link contains

Only the two names, the opening word, and the move list at two characters per
move. Spent cards, wildcard usage, whose turn it is, and whether the game is over
are all *re-derived* by replaying those moves through the rules, so there is no
second copy of the state that could drift out of step. A full 46-move game fits
in about 130 characters.

Decoding replays every move through the same `applyMove` the UI uses, so a
truncated or hand-edited link is rejected with a reason rather than loading a
board that could not have arisen from legal play.

That validation stops corruption, not cheating: either player can replay their
own link and move for the other side, and nothing prevents it. Same trust model
as the password — fine among friends, not a tournament server.

## Running it

There is no build step and no npm. Any static file server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` directly off the filesystem will not work — the app uses ES
modules, which browsers only load over http(s).

## How it is put together

| Path | What it is |
| --- | --- |
| `index.html` | The whole page. Loads Pico CSS, our stylesheet, and `src/main.js`. |
| `src/game.js` | All the rules, as pure functions over a JSON-serialisable state. No DOM. |
| `src/words.js` | Generated dictionary: the 5,454 four-letter SOWPODS words. |
| `src/store.js` | localStorage: users, session, saved local game. |
| `src/link.js` | Encodes a game into a shareable URL fragment, and validates one on the way back in. |
| `src/net.js` | Live games: joins a room over WebRTC and validates every position that arrives. |
| `src/seats.js` | The per-seat glyphs that say which side is which. |
| `src/components/` | Preact components, written with `htm` tagged templates (no JSX, no transpiler). |
| `vendor/` | Pinned copies of Pico CSS, preact+htm and Trystero, so the page needs no CDN at runtime. |
| `tools/` | Dictionary generator and the three test suites. |

State lives in one plain object that round-trips through `JSON.stringify`, which
is why an unfinished game survives a reload.

## Accounts, and what the password is not

The `chargame` password is checked in the browser and is sitting right there in
`src/store.js`. It keeps passers-by from wandering into your game; it is not
access control, and the page says so. Players are stored per-browser in
localStorage, anyone can delete any player, and there are no permissions —
deliberately, for a party game.

## Tests

Rules engine and share-link encoding (no dependencies, needs Node 16+):

```sh
node tools/test-game.mjs
node tools/test-link.mjs
```

End-to-end in a real browser — drives the actual UI, fails on any console error,
and writes screenshots to `.local/shots/`. The remote-play checks run two
separate browser profiles, so the joining player really does start with empty
storage and only the link:

```sh
pip install playwright && python -m playwright install firefox
python3 tools/test-ui.py          # add --headed to watch it
```

Live play needs real internet, so it is a separate script. Two browser profiles
host and join a room and trade moves for real:

```sh
python3 tools/test-live.py
```

## Regenerating the dictionary

```sh
python3 tools/build-words.py                    # downloads SOWPODS
python3 tools/build-words.py --source words.txt # or use a local list
```

The word list is filtered to four-letter entries and written out as a JS module.
Mean branching factor is about 13 one-letter neighbours per word, which is what
keeps games going for roughly 40–50 moves.
