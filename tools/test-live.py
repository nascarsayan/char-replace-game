#!/usr/bin/env python3
"""Peer-to-peer (WebRTC) two-player test. Kept separate from tools/test-ui.py
because it needs real internet: peers find each other through public WebTorrent
trackers.

    python3 tools/test-live.py [--headed] [--timeout 90]

Two independent browser contexts host and join a room, then trade moves.

This is the *fallback* transport, used when no database is configured. The config
file is served empty here so the fallback is what gets exercised even on a
checkout that has a database set up — otherwise this would silently test the
relay instead. tools/test-cloud.py covers that path.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import pathlib
import socketserver
import sys
import threading
import time

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import expect, sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSWORD = "chargame"


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D102 - quiet
        pass

    def do_GET(self) -> None:  # noqa: N802
        # Force the peer-to-peer path regardless of local configuration.
        if self.path == "/src/cloud-config.js":
            body = b"export const DATABASE_URL = '';\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def serve(directory: pathlib.Path) -> tuple[str, socketserver.TCPServer]:
    handler = functools.partial(Handler, directory=str(directory))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{httpd.server_address[1]}/", httpd


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument("--timeout", type=int, default=90, help="seconds to wait for a peer")
    parser.add_argument("--shots", default=str(ROOT / ".local" / "shots"))
    args = parser.parse_args()

    shots = pathlib.Path(args.shots)
    shots.mkdir(parents=True, exist_ok=True)
    base, httpd = serve(ROOT)
    problems: list[str] = []
    tracker_noise: list[str] = []
    checks = 0

    # Trystero deliberately announces to several trackers at once for redundancy,
    # so one being down is normal and says nothing about this code. Only that
    # specific failure is tolerated; every other console error still fails.
    def record(message: str) -> None:
        if 'establish a connection to the server at wss://tracker' in message:
            tracker_noise.append(message)
        else:
            problems.append(message)

    def check(label: str) -> None:
        nonlocal checks
        checks += 1
        print(f"  ok  {label}")

    def sign_in(pg, name: str) -> None:
        pg.goto(base)
        pg.get_by_label("Password").fill(PASSWORD)
        pg.get_by_role("button", name="Unlock").click()
        pg.get_by_label("New player name").fill(name)
        pg.get_by_role("button", name="Create and continue").click()

    def board_word(pg) -> str:
        return pg.evaluate(
            "[...document.querySelectorAll('button.tile span')].map(s=>s.textContent).join('')"
        ).lower()

    # A live game keeps its state in the component, deliberately: it is in neither
    # localStorage nor the URL. So a move is worked out from what is actually
    # rendered, which doubles as a check that the DOM reflects the real position.
    # Used words are read from the move list and the opening word rather than
    # tracked here: a relayed game gains words from the other device and from the
    # bot, so any list kept on this side drifts and starts proposing replays.
    def pick_move(pg):
        """A legal move for the player on turn, from what the board actually shows."""
        view = pg.evaluate(LEGAL_MOVE_JS)
        used, word = set(view["used"]), view["word"]
        spent, wildcard_left = set(view["spent"]), view["wildcardLeft"]
        for pos in range(4):
            for letter in "abcdefghijklmnopqrstuvwxyz":
                if letter == word[pos]:
                    continue
                candidate = word[:pos] + letter + word[pos + 1 :]
                if candidate in used or not pg.evaluate(
                    "async (w) => (await import('./src/words.js')).WORD_SET.has(w)", candidate
                ):
                    continue
                if letter in spent and not wildcard_left:
                    continue
                return {
                    "pos": pos,
                    "letter": letter,
                    "word": candidate,
                    "needsWildcard": letter in spent,
                }
        return None

    LEGAL_MOVE_JS = """() => {
        const used = new Set(
          [...document.querySelectorAll('.move-list li strong'), document.querySelector('.seed-word strong')]
            .filter(Boolean)
            .map((el) => el.textContent.trim().toLowerCase()),
        );
        const word = [...document.querySelectorAll('button.tile span')]
          .map((s) => s.textContent).join('').toLowerCase();
        used.add(word);
        const mine = document.querySelector('.rack[data-you="true"]');
        const spent = new Set([...mine.querySelectorAll('.card')]
          .filter((c) => c.dataset.state !== 'ready')
          .map((c) => c.textContent.trim().toLowerCase()));
        const wildcardLeft = mine.querySelector('.wildcard-state').textContent.includes('\u2605');
        return { used: [...used], word, spent: [...spent], wildcardLeft };
    }"""



    def play(pg, move):
        pg.locator("button.tile").nth(move["pos"]).click()
        pg.locator(f'button.card[aria-label^="Play {move["letter"]},"]').click()
        if move["needsWildcard"]:
            pg.get_by_role(
                "button", name=f"Spend wildcard on {move['letter'].upper()}"
            ).click()

    try:
        with sync_playwright() as p:
            browser = p.firefox.launch(headless=not args.headed)
            ctx_host = browser.new_context(viewport={"width": 1280, "height": 1400})
            ctx_guest = browser.new_context(viewport={"width": 1280, "height": 1400})
            host, guest = ctx_host.new_page(), ctx_guest.new_page()
            for pg in (host, guest):
                pg.on(
                    "console",
                    lambda m: record(f"console.{m.type}: {m.text}") if m.type == "error" else None,
                )
                pg.on("pageerror", lambda e: record(f"pageerror: {e}"))

            # --- host opens a room ---
            sign_in(host, "Alice")
            host.get_by_role("button", name="Play live").click()
            expect(host.get_by_text("travel directly between your two browsers")).to_be_visible()
            check("the peer-to-peer fallback is the transport under test")
            host.get_by_role("button", name="Host a new game").click()
            expect(host.get_by_role("heading", name="Waiting for your opponent")).to_be_visible()
            room_code = host.locator(".room-code").inner_text().strip()
            invite = host.locator("#invite-url").input_value()
            assert len(room_code) == 6 and f"#r={room_code}" in invite, (room_code, invite)
            check(f"hosting produces a 6-character room code ({room_code}) and invite link")
            host.screenshot(path=str(shots / "08-waiting-room.png"), full_page=True)

            # --- guest joins by code, in a profile that shares nothing with the host ---
            sign_in(guest, "Bob")
            guest.get_by_role("button", name="Play live").click()
            guest.get_by_label("Room code").fill(room_code)
            guest.get_by_role("button", name="Join as Bob").click()

            print(f"  ..  waiting up to {args.timeout}s for the peers to find each other")
            started = time.time()
            try:
                expect(host.locator("button.tile")).to_have_count(
                    4, timeout=args.timeout * 1000
                )
                expect(guest.locator("button.tile")).to_have_count(
                    4, timeout=args.timeout * 1000
                )
            except PWTimeout:
                print(
                    "\nFAILED: the peers never connected. Public WebTorrent trackers are\n"
                    "best-effort — this can be the network rather than the code.",
                    file=sys.stderr,
                )
                host.screenshot(path=str(shots / "live-fail-host.png"), full_page=True)
                guest.screenshot(path=str(shots / "live-fail-guest.png"), full_page=True)
                return 1
            check(f"host and guest connected peer-to-peer in {time.time() - started:.1f}s")

            # --- the host learns the guest's real name over the wire ---
            expect(host.locator(".rack", has_text="Bob")).to_have_count(1)
            check("the guest's name reaches the host")

            # --- fixed seats, clearly shown, and only one side can move ---
            expect(host.locator(".identity")).to_contain_text("You are Alice")
            expect(guest.locator(".identity")).to_contain_text("You are Bob")
            expect(host.locator('.rack[data-you="true"] h3')).to_contain_text("Alice")
            expect(guest.locator('.rack[data-you="true"] h3')).to_contain_text("Bob")
            assert host.locator('.rack[data-seat="0"]').count() == 1
            assert guest.locator('.rack[data-seat="0"]').count() == 1
            check("each browser shows which side it is playing, by name and by seat")

            expect(host.get_by_role("status").first).to_contain_text("Your turn.")
            expect(guest.get_by_role("status").first).to_contain_text("Waiting for Alice")
            assert guest.locator("button.tile[disabled]").count() == 4, (
                "the player not on turn must not be able to move"
            )
            assert host.locator("button.tile[disabled]").count() == 0
            check("only the player on turn can act; the other board is locked")
            guest.screenshot(path=str(shots / "09-live-waiting.png"), full_page=True)

            # --- a move made on one browser appears on the other ---
            word_before = board_word(host)
            move = pick_move(host)
            if move is None:
                print(
                    f"\nSKIPPED: the random opening word {word_before.upper()} has no "
                    "continuation for this seat; rerun.",
                    file=sys.stderr,
                )
                return 1
            play(host, move)
            expect(guest.get_by_role("status").first).to_contain_text("Your turn.", timeout=30000)
            word_after = board_word(guest)
            assert word_after == move["word"], (word_after, move)
            assert board_word(host) == word_after
            check(f"the host's move ({word_before} -> {word_after}) arrives on the guest instantly")
            host.screenshot(path=str(shots / "10-live-board.png"), full_page=True)

            # --- spent cards agree on both sides, having never been transmitted ---
            def rack_state(pg, name):
                return pg.evaluate(
                    """(name) => {
                        const rack = [...document.querySelectorAll('section.rack')]
                          .find(r => r.querySelector('h3').textContent.includes(name));
                        return {
                          count: rack.querySelector('.rack-count').textContent.trim(),
                          spent: [...rack.querySelectorAll('.card')]
                            .filter(c => c.dataset.state !== 'ready')
                            .map(c => c.textContent.trim()),
                        };
                    }""",
                    name,
                )

            for name in ("Alice", "Bob"):
                assert rack_state(host, name) == rack_state(guest, name), name
            assert rack_state(host, "Alice")["count"].startswith("26"), rack_state(host, "Alice")
            check("both sides derive the same spent cards from the moves alone")

            # --- and back the other way ---
            reply = pick_move(guest)
            assert reply is not None, f"guest has no reply from {board_word(guest)}"
            play(guest, reply)
            expect(host.get_by_role("status").first).to_contain_text("Your turn.", timeout=30000)
            assert board_word(host) == reply["word"], (board_word(host), reply)
            expect(host.locator(".move-list li")).to_have_count(2)
            expect(guest.locator(".move-list li")).to_have_count(2)
            check("the guest's reply arrives on the host, and both histories match")

            # --- dropping out is noticed and locks the board ---
            guest.close()
            expect(host.locator(".net-status")).to_contain_text("dropped out", timeout=60000)
            assert host.locator("button.tile[disabled]").count() == 4, (
                "with no peer connected the board must not accept moves"
            )
            check("when the opponent disconnects, the host is told and the board locks")

            ctx_host.close()
            ctx_guest.close()
            browser.close()
    finally:
        httpd.shutdown()

    if tracker_noise:
        unreachable = sorted({
            message.split('wss://')[1].split('/')[0] for message in tracker_noise
        })
        print(f"\n  ..  {', '.join(unreachable)} unreachable — tolerated, the "
              f"others carried the signalling")

    if problems:
        print("\nBrowser reported problems:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1

    print(f"\n{checks} live checks passed, no unexpected console errors. Screenshots in {shots}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
