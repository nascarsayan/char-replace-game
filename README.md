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
6. **Do not know a word?** Pass. A bot plays one for you, using a letter one of
   you still holds — and that letter is struck off **both** racks, which is what
   makes it cost something. You get 5 passes per game.
7. Passing hands a point to your opponent. Go **2 clear passes behind** and you
   lose, however many words are left.
8. You also lose if no word at all is left to you, wildcard included.

Both racks are visible at all times: knowing which letters your opponent has
burned, and whether they still hold their wildcard, is the game.

Every word played shows its meaning, on the board and in the move list — with a
5,454-word Scrabble list, a good half of the game is words you have never met.

Keyboard: `1`–`4` or `←`/`→` pick a slot, a letter key plays it, `Esc` clears.

### Passing

Passing is for not knowing a word, and it costs you the initiative:

- The bot plays a letter **either of you still holds** — never a wildcard, yours or
  anyone's. It takes the first such word in slot-then-letter order, and the choice
  is recorded in the game rather than recomputed, so a share link or a live peer
  replays exactly the word that was played.
- Letting the bot reach into your opponent's rack is what makes a pass possible
  when you have nothing of your own left, which is precisely when you need it.
- The letter is struck off **both** racks, wherever it was still held. If one of you
  had already spent it, it simply stays spent; no wildcard is touched to make room.
- Only the player who passed spends a pass. 5 each.

### Passes decide games

Each pass hands a point to your opponent, and **2 clear passes behind loses**,
however many words are still on the board. Trading passes one for one keeps you
level. The board shows the score as soon as it is not level, and warns when
somebody is one pass from winning.

### Knowing how much room is left

The board says **how many words you can play without your wildcard** — the count,
not the words. At zero it says so instead, and your ★ wildcard is the way on: it
replays one spent letter, and the cards that qualify are the dashed ones.

**Hint** shows an actual playable move and tells you if it would cost your
wildcard. Asking again offers a different one.

## Playing live

Pick **Play live**, then **Host a new game**. You get a six-character room code
and an invite link; send either to your opponent, who joins with it. Moves then
appear on both boards as they are made.

Each browser holds a **fixed side**: the host plays first, the joiner second. The
board says which one you are, marks your rack, and refuses input when it is not
your move.

There are two transports, and which one is used depends on whether a database is
configured (see [Setting up live games](#setting-up-live-games)).

**Relayed (recommended).** Moves go through a Firebase Realtime Database. It works
on any network, since nothing has to punch through a NAT, and the room *persists*
— close the tab, come back tomorrow, the game is still there. You do not both
need to be online at the same moment.

**Peer-to-peer (the fallback, used when no database is configured).** The two
browsers talk directly over WebRTC, with public WebTorrent trackers only
introducing the peers. No server is involved and nothing is to set up, but it is
best-effort: you both have to be online at once, the free trackers are sometimes
down, and restrictive networks can block the direct connection outright since
there is no TURN relay. If live will not connect, [link play](#playing-by-link)
always works.

## Setting up live games

Without this, live play falls back to peer-to-peer and link play is unaffected.

1. At [console.firebase.google.com](https://console.firebase.google.com), create a
   project. Analytics can be skipped; no card is needed.
2. **Build → Realtime Database → Create Database**, pick a region, and start in
   **test mode**.
3. Copy the URL from the top of that page — it looks like
   `https://your-project-default-rtdb.firebaseio.com`.
4. Paste it into `DATABASE_URL` in [`src/cloud-config.js`](src/cloud-config.js).

That is the only value needed: the REST API this uses takes no API key while the
rules are open, and no SDK is bundled — writes are `fetch`, updates arrive over
`EventSource`.

Test mode leaves the database world-readable and world-writable, and expires after
30 days. Replace the rules with something that at least confines access to game
rooms and keeps entries small:

```json
{
  "rules": {
    "rooms": {
      "$room": {
        ".read": "$room.length == 6",
        ".write": "$room.length == 6",
        "state": { ".validate": "newData.isString() && newData.val().length < 4096" },
        "host": { ".validate": "newData.isString() && newData.val().length <= 24" },
        "guest": { ".validate": "newData.isString() && newData.val().length <= 24" },
        "updatedAt": { ".validate": "newData.isNumber()" },
        "$other": { ".validate": false }
      }
    },
    "users": {
      ".read": true,
      "$user": {
        ".write": true,
        "name": { ".validate": "newData.isString() && newData.val().length <= 24" },
        "lastSeen": { ".validate": "newData.isNumber()" },
        "rooms": {
          "$room": { ".validate": "$room.length == 6 && newData.isBoolean()" }
        },
        "$other": { ".validate": false }
      }
    }
  }
}
```

Be clear-eyed about what that does and does not buy you: it stops anything being
written outside `/rooms` and `/users`, caps the sizes, and rejects unknown fields —
but rooms are still readable and writable by anyone who knows or guesses a
six-character code, and the player list is readable and editable by anyone at all.
That is obscurity, not authentication. A position pushed into a room is
still replayed through the rules before it is shown, so a tampered one is rejected
rather than trusted, but nothing stops a stranger who guesses your code from
joining. For a word game among friends that is a reasonable trade; if it ever
mattered, the fix is Firebase Auth and per-room ownership rules.

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

### Older links

Links carry a format version, currently 4, and **every** older one is still read.
Each version's skipped turns are replayed with the rules that were in force when
they were recorded:

| Version | Passed turns |
| --- | --- |
| 1 | did not exist yet |
| 2 | the bot ignored rack limits, and a pass could rescue a player with no move |
| 3 | the bot had to use a letter the passer still held |
| 4 | the pass records the letter it used, so nothing is recomputed |
| 5 | the bot may use a letter either player holds, and passes decide games |

Version 4 exists to end that pattern. Recomputing the bot's choice meant that any
change to how it chooses stranded games already in progress — which is exactly
what happened when version 3 landed, and again at version 5. Writing the letter
down costs nothing (an uppercase letter marks a pass, so tokens stay two characters
wide) and makes a recorded game replay the same way for good.

Versions before 5 also predate passes deciding games, so they are replayed without
that rule and meet it once at the end. A game that had already fallen two passes
behind therefore comes back finished, because under today's rules it was.

A version 2 game whose later moves *only* happened because a skip rescued a stuck
player is replayed under that old rule, then handed to the current one, which will
usually declare it finished — because under today's rules it was. Such a game
carries a flag so re-encoding it does not produce a link that no longer replays.
Games that never leaned on the old rule come back indistinguishable from one
played today, unflagged.

`node tools/migrate-rooms.mjs` reports on the live rooms in the database and can
normalise them, though it no longer needs to: a room left alone reads fine and
becomes current the next time someone moves. Note that rewriting a room a player
still has open will break their tab if it is running older code — and their next
move will overwrite the rewrite.

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
| `src/definitions.js` | Lazily fetches the definition file; degrades quietly if it fails. |
| `src/identity.js` | Who is playing and which games they are in — database-backed, or localStorage without one. |
| `src/link.js` | Encodes a game into a shareable URL fragment, and validates one on the way back in. |
| `src/cloud.js` | Relayed live games: Firebase Realtime Database over plain `fetch` + `EventSource`, no SDK. |
| `src/cloud-config.js` | Where the database URL goes. Empty by default. |
| `src/net.js` | Peer-to-peer live games over WebRTC, used when no database is configured. |
| `src/seats.js` | The per-seat glyphs that say which side is which. |
| `src/components/` | Preact components, written with `htm` tagged templates (no JSX, no transpiler). |
| `vendor/` | Pinned copies of Pico CSS, preact+htm and Trystero, so the page needs no CDN at runtime. |
| `assets/definitions.json` | Generated glosses, ~267 KiB, fetched in the background rather than blocking play. |
| `tools/` | The two data generators and the five test suites. |

State lives in one plain object that round-trips through `JSON.stringify`, which
is why an unfinished game survives a reload.

## Players, and what the password is not

The `chargame` password is checked in the browser and is sitting right there in
`src/store.js`. It keeps passers-by from wandering into your game; it is not
access control, and the page says so.

Players are just names, and a name is unique (case-insensitively). With a database
configured they are saved alongside the games, which is what lets you sign in as an
existing name on a device that has never played and pick up a game you left
half-finished — the lobby lists your unfinished games, so you need neither the room
code nor the link. Without a database they fall back to this browser's
localStorage, and cannot follow you anywhere.

There are no per-player passwords: anyone past the page password can sign in as any
name, and anyone can delete any player. That is deliberate for a party game, and
the sign-in screen says so rather than implying otherwise.

Records (W/L) are counted from the games themselves rather than tallied as they
finish, so two devices writing at once cannot double-count.

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

The relayed transport is tested against a stand-in for the database, so it needs
no Firebase project and no internet. The emulator is strict about the shape of
what the client writes, so a change that Firebase would reject fails here:

```sh
python3 tools/test-cloud.py
```

## Regenerating the word data

```sh
python3 tools/build-words.py                    # downloads SOWPODS
python3 tools/build-words.py --source words.txt # or use a local list
```

The word list is filtered to four-letter entries and written out as a JS module.
Mean branching factor is about 13 one-letter neighbours per word, which is what
keeps games going for roughly 40–60 moves.

```sh
python3 tools/build-definitions.py              # downloads both sources (~80 MB)
```

Definitions cover **3,800 of the 5,454 words (70%)**. Where a word is only in the
list as an inflection ("aces"), the gloss comes from its base form and says so.
Anything still unresolved is left out, and the board says the word has no bundled
definition rather than inventing one.

Sources and licences — including the CC BY-SA 4.0 terms that apply to
`assets/definitions.json` — are in [ATTRIBUTION.md](ATTRIBUTION.md).
