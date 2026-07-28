#!/usr/bin/env python3
"""Relayed-live-game test, run against a stand-in for Firebase Realtime Database.

The real database is not needed to prove the client protocol is right, so this
serves a small emulator of the parts src/cloud.js uses — PATCH merges, and GET
with `Accept: text/event-stream` answered as the streaming protocol. Two browser
profiles then host and join a room and play through it.

    python3 tools/test-cloud.py [--headed]

The emulator is intentionally strict about the shape of what the client sends: if
src/cloud.js started writing something Firebase would reject, this fails.
"""

from __future__ import annotations

import argparse
import http.server
import json
import pathlib
import queue
import socketserver
import sys
import threading
import time

from playwright.sync_api import expect, sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSWORD = "chargame"

rooms: dict[str, dict] = {}
users: dict[str, dict] = {}
subscribers: dict[str, list[queue.Queue]] = {}
lock = threading.Lock()
writes: list[dict] = []


def walk(root: dict, segments: list[str], create: bool = False):
    """(container, key) for a path, or (None, None) when it is absent."""
    node = root
    for segment in segments[:-1]:
        if segment not in node or not isinstance(node[segment], dict):
            if not create:
                return None, None
            node[segment] = {}
        node = node[segment]
    return node, segments[-1]


def publish(room_code: str, payload: dict, event: str) -> None:
    for subscriber in subscribers.get(room_code, []):
        subscriber.put((event, payload))


def resolve_server_values(value):
    """Firebase replaces {".sv": "timestamp"} server-side; so does this."""
    if isinstance(value, dict):
        if value.get(".sv") == "timestamp":
            return int(time.time() * 1000)
        return {k: resolve_server_values(v) for k, v in value.items()}
    return value


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):  # noqa: D102 - quiet
        pass

    # --- helpers ---

    def _room_code(self) -> str | None:
        if not self.path.startswith("/db/rooms/"):
            return None
        tail = self.path[len("/db/rooms/") :].split("?")[0]
        if not tail.endswith(".json") or "/" in tail[: -len(".json")]:
            return None
        return tail[: -len(".json")]

    def _segments(self) -> list[str] | None:
        """Path segments under /db, e.g. /db/users/sayan/rooms.json -> [...]."""
        if not self.path.startswith("/db/"):
            return None
        tail = self.path[len("/db/") :].split("?")[0]
        if not tail.endswith(".json"):
            return None
        tail = tail[: -len(".json")]
        return [part for part in tail.split("/") if part]

    def _tree(self, segments: list[str]):
        return users if segments and segments[0] == "users" else rooms

    def _relative(self, segments: list[str]) -> list[str]:
        return segments[1:] if segments and segments[0] in ("users", "rooms") else segments

    def _send_json(self, payload, status=200) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # --- routes ---

    def do_GET(self) -> None:  # noqa: N802
        # The app's config file is served with the emulator's address injected,
        # so the checked-in placeholder stays empty.
        if self.path == "/src/cloud-config.js" and not getattr(self, "use_real_database", False):
            body = f"export const DATABASE_URL = 'http://127.0.0.1:{self.server.server_address[1]}/db';\n".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        room_code = self._room_code()
        if room_code is None:
            segments = self._segments()
            if segments is None:
                super().do_GET()
                return
            relative = self._relative(segments)
            with lock:
                if not relative:
                    self._send_json(self._tree(segments) or None)
                    return
                holder, key = walk(self._tree(segments), relative)
                value = holder.get(key) if holder else None
                self._send_json(value if value else None)
            return

        if "text/event-stream" not in (self.headers.get("Accept") or ""):
            with lock:
                self._send_json(rooms.get(room_code))
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        channel: queue.Queue = queue.Queue()
        with lock:
            subscribers.setdefault(room_code, []).append(channel)
            snapshot = rooms.get(room_code)
        # Firebase opens a stream with a `put` carrying everything at that path.
        channel.put(("put", {"path": "/", "data": snapshot}))
        try:
            while True:
                try:
                    event, payload = channel.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": keep-alive\n\n")  # not JSON, must be ignored
                    self.wfile.flush()
                    continue
                self.wfile.write(f"event: {event}\ndata: {json.dumps(payload)}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with lock:
                subscribers.get(room_code, []).remove(channel)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) or b"null"
        return json.loads(raw)

    def do_PUT(self) -> None:  # noqa: N802
        segments = self._segments()
        if segments is None:
            self.send_error(404)
            return
        body = resolve_server_values(self._read_body())
        writes.append({"method": "PUT", "path": "/".join(segments), "body": body})
        relative = self._relative(segments)
        with lock:
            holder, key = walk(self._tree(segments), relative, create=True)
            holder[key] = body
            if segments[0] == "rooms" and len(relative) == 1:
                publish(key, {"path": "/", "data": body}, "put")
        self._send_json(body)

    def do_DELETE(self) -> None:  # noqa: N802
        segments = self._segments()
        if segments is None:
            self.send_error(404)
            return
        writes.append({"method": "DELETE", "path": "/".join(segments)})
        relative = self._relative(segments)
        with lock:
            holder, key = walk(self._tree(segments), relative)
            if holder is not None:
                holder.pop(key, None)
            if segments[0] == "rooms" and len(relative) == 1:
                publish(key, {"path": "/", "data": None}, "put")
        self._send_json(None)

    def do_PATCH(self) -> None:  # noqa: N802
        room_code = self._room_code()
        if room_code is None:
            segments = self._segments()
            if segments is None:
                self.send_error(404)
                return
            body = self._read_body()
            if not isinstance(body, dict):
                self.send_error(400, "PATCH body must be an object")
                return
            writes.append({"method": "PATCH", "path": "/".join(segments), "body": body})
            merged = {k: resolve_server_values(v) for k, v in body.items()}
            relative = self._relative(segments)
            with lock:
                holder, key = walk(self._tree(segments), relative, create=True)
                if not isinstance(holder.get(key), dict):
                    holder[key] = {}
                holder[key].update(merged)
            self._send_json(merged)
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(400, "invalid JSON")
            return
        if not isinstance(body, dict):
            self.send_error(400, "PATCH body must be an object")
            return

        writes.append({"method": "PATCH", "path": f"rooms/{room_code}", "body": body})
        merged = {key: resolve_server_values(value) for key, value in body.items()}
        with lock:
            room = rooms.setdefault(room_code, {})
            room.update(merged)
            publish(room_code, {"path": "/", "data": merged}, "patch")
        self._send_json(merged)


def real_database_url() -> str:
    import re

    config = (ROOT / "src" / "cloud-config.js").read_text(encoding="utf-8")
    match = re.search(r"DATABASE_URL\s*=\s*'([^']+)'", config)
    return match.group(1).rstrip("/") if match and match.group(1) else ""


def read_real_room(room_code: str) -> dict:
    import urllib.request

    url = f"{real_database_url()}/rooms/{room_code}.json"
    with urllib.request.urlopen(url, timeout=20) as response:
        return json.loads(response.read() or b"null") or {}


def cleanup_real_room(room_code: str) -> None:
    """Removes the room this test created, so the real database is left tidy."""
    import re
    import urllib.request

    config = (ROOT / "src" / "cloud-config.js").read_text(encoding="utf-8")
    match = re.search(r"DATABASE_URL\s*=\s*'([^']+)'", config)
    if not match or not match.group(1):
        return
    url = f"{match.group(1).rstrip('/')}/rooms/{room_code}.json"
    request = urllib.request.Request(url, method="DELETE")
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            print(f"  ..  removed room {room_code} from the real database (HTTP {response.status})")
    except Exception as err:  # noqa: BLE001 - tidy-up is best-effort
        print(f"  ..  could not remove room {room_code}: {err}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--real",
        action="store_true",
        help="use the database configured in src/cloud-config.js instead of the emulator",
    )
    parser.add_argument("--shots", default=str(ROOT / ".local" / "shots"))
    args = parser.parse_args()

    shots = pathlib.Path(args.shots)
    shots.mkdir(parents=True, exist_ok=True)

    Handler.use_real_database = args.real
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}/"

    problems: list[str] = []
    checks = 0

    def check(label: str) -> None:
        nonlocal checks
        checks += 1
        print(f"  ok  {label}")

    def watch(pg) -> None:
        pg.on(
            "console",
            lambda m: problems.append(f"console.{m.type}: {m.text}") if m.type == "error" else None,
        )
        pg.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))

    def sign_in(pg, name: str, url: str = base) -> None:
        """Signs in, reusing the identity if it already exists.

        With shared identities a name can only be created once, so a second
        device has to continue as it rather than make it again.
        """
        pg.goto(url)
        if pg.get_by_label("Password").count():
            pg.get_by_label("Password").fill(PASSWORD)
            pg.get_by_role("button", name="Unlock").click()
        if not pg.get_by_label("New player name").count():
            return
        # The saved-player list arrives from the database, so wait for it before
        # deciding whether this name has to be created.
        loading = pg.get_by_text("Loading players…")
        if loading.count():
            loading.wait_for(state="detached", timeout=20000)
        existing = pg.get_by_role("button", name=f"Continue as {name}")
        if existing.count():
            existing.click()
            return
        pg.get_by_label("New player name").fill(name)
        pg.get_by_role("button", name="Create and continue").click()

    def board_word(pg) -> str:
        return pg.evaluate(
            "[...document.querySelectorAll('button.tile span')].map(s=>s.textContent).join('')"
        ).lower()

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

    def play(pg) -> str:
        move = pick_move(pg)
        assert move is not None, f"no legal move from {board_word(pg)}"
        pg.locator("button.tile").nth(move["pos"]).click()
        pg.locator(f'button.card[aria-label^="Play {move["letter"]},"]').click()
        if move["needsWildcard"]:
            pg.get_by_role("button", name=f"Spend wildcard on {move['letter'].upper()}").click()
        return move["word"]

    try:
        with sync_playwright() as p:
            browser = p.firefox.launch(headless=not args.headed)
            ctx_host = browser.new_context(viewport={"width": 1280, "height": 1500})
            ctx_guest = browser.new_context(viewport={"width": 1280, "height": 1500})
            host, guest = ctx_host.new_page(), ctx_guest.new_page()
            watch(host)
            watch(guest)

            # --- the configured transport is the relay, not peer-to-peer ---
            sign_in(host, "Alice")
            host.get_by_role("button", name="Play live").click()
            expect(host.get_by_text("relayed through a database")).to_be_visible()
            check("with a database configured, the lobby offers the relayed transport")

            host.get_by_role("button", name="Host a new game").click()
            expect(host.get_by_role("heading", name="Waiting for your opponent")).to_be_visible()
            room_code = host.locator(".room-code").inner_text().strip()
            assert len(room_code) == 6, room_code
            # Read the room back from wherever the writes actually landed. The
            # host publishes asynchronously, so this polls rather than assuming
            # the write has already gone out.
            def stored_room() -> dict:
                if args.real:
                    assert real_database_url(), "src/cloud-config.js has no DATABASE_URL"
                    return read_real_room(room_code)
                with lock:
                    return dict(rooms.get(room_code, {}))

            deadline = time.time() + 20
            stored: dict = {}
            while time.time() < deadline:
                stored = stored_room()
                if "state" in stored and "host" in stored:
                    break
                time.sleep(0.5)
            assert "state" in stored, f"the host should have seeded the room: {stored}"
            assert stored.get("host") == "Alice", stored
            check(f"hosting writes the opening position to room {room_code}")

            # --- the guest joins and is handed the position ---
            sign_in(guest, "Bob")
            guest.get_by_role("button", name="Play live").click()
            guest.get_by_label("Room code").fill(room_code)
            guest.get_by_role("button", name="Join as Bob").click()

            expect(guest.locator("button.tile")).to_have_count(4, timeout=20000)
            expect(host.locator("button.tile")).to_have_count(4, timeout=20000)
            assert board_word(host) == board_word(guest)
            check("the guest receives the position over the stream")

            expect(host.locator(".rack", has_text="Bob")).to_have_count(1, timeout=20000)
            expect(host.locator(".identity")).to_contain_text("You are Alice")
            expect(guest.locator(".identity")).to_contain_text("You are Bob")
            check("the guest's name reaches the host, and each side knows its seat")

            expect(host.get_by_role("status").first).to_contain_text("Your turn.")
            expect(guest.get_by_role("status").first).to_contain_text("Waiting for Alice")
            assert guest.locator("button.tile[disabled]").count() == 4
            check("only the player on turn can act")

            # --- moves relay in both directions ---
            opening = board_word(host)
            latest = play(host)
            expect(guest.get_by_role("status").first).to_contain_text("Your turn.", timeout=20000)
            assert board_word(guest) == latest, (board_word(guest), latest)
            check(f"the host's move ({opening} -> {latest}) reaches the guest")

            latest = play(guest)
            expect(host.get_by_role("status").first).to_contain_text("Your turn.", timeout=20000)
            assert board_word(host) == latest
            expect(host.locator(".move-list li")).to_have_count(2)
            check("the guest's reply reaches the host, and both histories match")

            # --- a skip relays too, with the bot's word derived on both sides ---
            host.get_by_role("button", name="Give up turn").click()
            host.locator(".confirm .danger").click()
            expect(guest.get_by_role("status").first).to_contain_text("Your turn.", timeout=20000)
            assert board_word(host) == board_word(guest)
            expect(guest.locator(".move-list li").first).to_contain_text("Alice skipped")
            for pg in (host, guest):
                counts = pg.evaluate(
                    "[...document.querySelectorAll('.rack-count')].map(e => e.textContent.trim())"
                )
                assert all("25 of 27" in c or "26 of 27" in c for c in counts), counts
            check("a skip relays, and both sides derive the same bot word")
            host.screenshot(path=str(shots / "11-cloud-board.png"), full_page=True)

            # --- the room persists: closing the tab loses nothing ---
            word_before = board_word(guest)
            history_before = guest.locator(".move-list li").count()
            guest.close()
            ctx_guest.close()
            ctx_rejoin = browser.new_context(viewport={"width": 1280, "height": 1500})
            rejoin = ctx_rejoin.new_page()
            watch(rejoin)
            sign_in(rejoin, "Bob", f"{base}#r={room_code}")
            rejoin.get_by_role("button", name="Join").click()
            expect(rejoin.locator("button.tile")).to_have_count(4, timeout=20000)
            assert board_word(rejoin) == word_before, (board_word(rejoin), word_before)
            expect(rejoin.locator(".move-list li")).to_have_count(history_before)
            check("a player who closes the tab can rejoin and find the game intact")

            # ================================================================
            # A completely fresh device: no localStorage, no link, no room code.
            # Signing in as an existing name must find the game and resume it.
            # ================================================================
            ctx_fresh = browser.new_context(viewport={"width": 1280, "height": 1500})
            fresh = ctx_fresh.new_page()
            watch(fresh)
            fresh.goto(base)
            fresh.get_by_label("Password").fill(PASSWORD)
            fresh.get_by_role("button", name="Unlock").click()

            assert fresh.evaluate("localStorage.length") == 1, (
                "only the unlock flag should be stored on a device that has never played"
            )
            loading = fresh.get_by_text("Loading players…")
            if loading.count():
                loading.wait_for(state="detached", timeout=20000)
            expect(fresh.get_by_role("button", name="Continue as Alice")).to_be_visible()
            expect(fresh.get_by_role("button", name="Continue as Bob")).to_be_visible()
            check("a device that has never played still sees the saved players")

            # A name that exists cannot be created again.
            fresh.get_by_label("New player name").fill("alice")
            fresh.get_by_role("button", name="Create and continue").click()
            expect(fresh.get_by_role("alert").first).to_contain_text("already taken")
            check("player names are unique, case-insensitively")

            fresh.get_by_role("button", name="Continue as Alice").click()
            expect(fresh.get_by_text("Playing as")).to_be_visible()

            resume = fresh.locator(".game-list button.game-pick")
            expect(resume).to_have_count(1, timeout=20000)
            expect(resume.first).to_contain_text(room_code)
            expect(resume.first).to_contain_text("vs Bob")
            check("the lobby lists the unfinished game, found by identity alone")
            fresh.screenshot(path=str(shots / "15-resume-list.png"), full_page=True)

            resume.first.click()
            expect(fresh.locator("button.tile")).to_have_count(4, timeout=30000)
            assert board_word(fresh) == board_word(host), (board_word(fresh), board_word(host))
            expect(fresh.locator(".move-list li")).to_have_count(3)
            check("resuming from a fresh device lands on the right position")

            # The seat has to come from the identity, not from the fact that this
            # browser arrived by joining: Alice must not land in Bob's chair.
            expect(fresh.locator(".identity")).to_contain_text("You are Alice")
            expect(fresh.locator('.rack[data-you="true"] h3')).to_contain_text("Alice")
            expect(fresh.get_by_role("status").first).to_contain_text("Waiting for Bob")
            assert fresh.locator("button.tile[disabled]").count() == 4, (
                "it is Bob's turn, so the resumed board must be locked"
            )
            check("the resumed seat follows the identity, not the route in")

            # Bob, on the other device, plays: the resumed device must see it.
            expect(rejoin.get_by_role("status").first).to_contain_text("Your turn.", timeout=20000)
            latest = play(rejoin)
            expect(fresh.get_by_role("status").first).to_contain_text("Your turn.", timeout=20000)
            assert board_word(fresh) == latest, (board_word(fresh), latest)
            check("a move from the other device reaches the resumed one")

            # And the resumed device can really move, not just watch.
            latest = play(fresh)
            expect(rejoin.get_by_role("status").first).to_contain_text("Your turn.", timeout=20000)
            assert board_word(rejoin) == latest
            check("the resumed device holds a real seat and can move")

            # --- deleting an identity removes it everywhere ---
            fresh.get_by_role("button", name="Leave").click()
            fresh.get_by_role("button", name="Switch player").click()
            loading = fresh.get_by_text("Loading players…")
            if loading.count():
                loading.wait_for(state="detached", timeout=20000)
            fresh.get_by_role("button", name="Remove Bob").click()
            fresh.get_by_role("button", name="Delete").click()
            expect(fresh.get_by_role("button", name="Continue as Bob")).to_have_count(0)
            with lock:
                assert "bob" not in users, f"Bob should be gone from the database: {list(users)}"
            check("deleting a player removes the shared identity, not just a local copy")

            ctx_fresh.close()

            # --- every write is shaped the way the database expects ---
            if args.real:
                print("  ..  ran against the real database; write-shape check skipped")
                check("relayed play works end to end against the real database")
                ctx_host.close()
                ctx_rejoin.close()
                browser.close()
                cleanup_real_room(room_code)
                if problems:
                    print("\nBrowser reported problems:", file=sys.stderr)
                    for problem in problems:
                        print(f"  {problem}", file=sys.stderr)
                    return 1
                print(f"\n{checks} relayed-game checks passed against the real database.")
                return 0
            assert writes, "no writes were recorded"
            room_keys = {"state", "updatedAt", "host", "guest"}
            user_keys = {"name", "lastSeen", "rooms"}
            for write in writes:
                path, body = write.get("path"), write.get("body")
                if body is None:
                    continue
                top = path.split("/")[0] if path else "rooms"
                if top == "users":
                    assert set(body) <= user_keys | {c for c in body if len(c) == 6}, (
                        f"unexpected user keys: {set(body)}"
                    )
                else:
                    assert set(body) <= room_keys, f"unexpected room keys: {set(body) - room_keys}"
                    if "state" in body:
                        assert isinstance(body["state"], str) and body["state"], body
                if "updatedAt" in body:
                    assert body["updatedAt"] == {".sv": "timestamp"}, body
            check(f"all {len(writes)} writes stay within the expected schema")

            ctx_host.close()
            ctx_rejoin.close()
            browser.close()
    finally:
        httpd.shutdown()

    if problems:
        print("\nBrowser reported problems:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1

    print(f"\n{checks} relayed-game checks passed, no console errors. Screenshots in {shots}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
