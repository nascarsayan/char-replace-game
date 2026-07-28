#!/usr/bin/env python3
"""End-to-end UI test. Serves the repo and drives it with Playwright/Firefox.

    pip install playwright && python -m playwright install firefox
    python3 tools/test-ui.py [--headed] [--shots DIR]

Fails loudly on any console error or page exception.

Deliberately hermetic: the config file is served empty so identities and games stay
in this browser's localStorage. Otherwise a checkout with a database configured
would have these tests writing players and rooms into the real one.
tools/test-cloud.py covers the database-backed behaviour.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import pathlib
import socketserver
import sys
import threading

from playwright.sync_api import expect, sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PASSWORD = "chargame"


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D102 - quiet
        pass

    def do_GET(self) -> None:  # noqa: N802
        # Keep identities local, whatever the checkout is configured with.
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
    parser.add_argument("--shots", default=str(ROOT / ".local" / "shots"))
    args = parser.parse_args()

    shots = pathlib.Path(args.shots)
    shots.mkdir(parents=True, exist_ok=True)
    base, httpd = serve(ROOT)
    problems: list[str] = []
    checks = 0

    def check(label: str) -> None:
        nonlocal checks
        checks += 1
        print(f"  ok  {label}")

    try:
        with sync_playwright() as p:
            browser = p.firefox.launch(headless=not args.headed)
            page = browser.new_page(viewport={"width": 1280, "height": 1400})
            page.on("console", lambda m: problems.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
            page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))

            # --- gate ---
            page.goto(base)
            expect(page.get_by_role("heading", name="Char Replace")).to_be_visible()
            page.get_by_label("Password").fill("nope")
            page.get_by_role("button", name="Unlock").click()
            expect(page.get_by_role("alert")).to_have_text("Wrong password.")
            check("wrong password is rejected")

            page.get_by_label("Password").fill(PASSWORD)
            page.get_by_role("button", name="Unlock").click()
            expect(page.get_by_role("heading", name="Who are you?")).to_be_visible()
            check("correct password unlocks the sign-in screen")

            # --- sign in ---
            page.get_by_label("New player name").fill("Sayan")
            page.get_by_role("button", name="Create and continue").click()
            expect(page.get_by_text("Playing as")).to_be_visible()
            check("a new player can sign in")

            page.screenshot(path=str(shots / "01-lobby.png"), full_page=True)

            # --- duplicate names are refused ---
            page.get_by_role("button", name="Switch player").click()
            page.get_by_label("New player name").fill("sayan")
            page.get_by_role("button", name="Create and continue").click()
            expect(page.get_by_role("alert")).to_contain_text("already taken")
            check("duplicate player names are refused")
            page.get_by_role("button", name="Continue as Sayan").click()

            # --- start a game ---
            page.get_by_label("Opponent").fill("Riya")
            page.get_by_role("button", name="Play", exact=True).click()
            expect(page.get_by_role("status").first).to_contain_text("Sayan's turn.")
            expect(page.locator("button.tile")).to_have_count(4)
            expect(page.locator("section.rack")).to_have_count(2)
            expect(page.locator("section.rack").first.locator(".card")).to_have_count(26)
            check("a game starts with 4 slots and two 26-letter racks")

            page.screenshot(path=str(shots / "02-board.png"), full_page=True)

            # --- rejection path: pick a letter that makes a non-word ---
            word = page.evaluate("[...document.querySelectorAll('button.tile span')].map(s=>s.textContent).join('')").lower()
            bad = page.evaluate(
                """async (word) => {
                    const { WORD_SET } = await import('./src/words.js');
                    for (const c of 'abcdefghijklmnopqrstuvwxyz') {
                      if (c !== word[0] && !WORD_SET.has(c + word.slice(1))) return c;
                    }
                    return null;
                }""",
                word,
            )
            page.locator("button.tile").first.click()
            page.locator(f'button.card[aria-label^="Play {bad},"]').click()
            expect(page.get_by_role("alert").first).to_contain_text("not in the dictionary")
            expect(page.get_by_role("status").first).to_contain_text("Sayan's turn.")
            check("an invalid word is refused and the turn does not pass")

            # --- a real move, driven by the engine's own legal-move list ---
            move = page.evaluate(
                """async () => {
                    const { legalMoves } = await import('./src/game.js');
                    const game = JSON.parse(localStorage.getItem('crg.game.v1'));
                    return legalMoves(game)[0];
                }"""
            )
            page.locator("button.tile").nth(move["pos"]).click()
            page.locator(f'button.card[aria-label^="Play {move["letter"]},"]').click()
            expect(page.locator("button.tile span").nth(move["pos"])).to_have_text(move["letter"].upper())
            expect(page.get_by_role("status").first).to_contain_text("Riya's turn.")
            check(f"a legal move plays ({word} -> {move['word']}) and passes the turn")

            # The rack you can type on must be first, so it is not below the fold.
            def first_rack_name(pg):
                return pg.evaluate(
                    "document.querySelector('section.rack h3').textContent.replace(/[^A-Za-z ]/g,'').trim()"
                )

            assert first_rack_name(page).startswith("Riya"), (
                f"the on-turn player's rack should lead, got {first_rack_name(page)!r}"
            )
            assert page.locator("section.rack").first.get_attribute("data-on-turn") == "true"
            check("the rack belonging to the player on turn is rendered first")

            # The opening word stays in the history for the whole game.
            seed = page.locator(".seed-word")
            expect(seed).to_contain_text(word.upper())
            expect(seed).to_contain_text("opening word")
            assert page.locator(".move-list li").count() >= 1
            check(f"the opening word ({word.upper()}) stays listed once moves exist")

            # Sayan's rack is now the read-only one; the spent letter must show as spent there.
            spent = page.locator("section.rack", has=page.get_by_role("heading", name="Sayan")).locator(
                f'.card[aria-label="{move["letter"]}, spent, replayable with the wildcard"]'
            )
            expect(spent).to_have_count(1)
            expect(spent).to_have_attribute("data-state", "wildcard-only")
            check("the spent letter card is marked spent on that player's rack")

            # --- keyboard play for Riya ---
            move2 = page.evaluate(
                """async () => {
                    const { legalMoves } = await import('./src/game.js');
                    const game = JSON.parse(localStorage.getItem('crg.game.v1'));
                    return legalMoves(game)[0];
                }"""
            )
            page.locator("body").click(position={"x": 5, "y": 5})
            page.keyboard.press(str(move2["pos"] + 1))
            page.keyboard.press(move2["letter"])
            expect(page.get_by_role("status").first).to_contain_text("Sayan's turn.")
            expect(page.locator("button.tile span").nth(move2["pos"])).to_have_text(move2["letter"].upper())
            check("digit-then-letter keyboard entry plays a move")

            # --- definitions are shown for the word on the board and in the history ---
            page.wait_for_function(
                "async () => (await import('./src/definitions.js')).definitionsReady()"
            )
            board_now = page.evaluate(
                "[...document.querySelectorAll('button.tile span')].map(s=>s.textContent).join('')"
            ).lower()
            expected = page.evaluate(
                "async (w) => (await import('./src/definitions.js')).define(w)", board_now
            )
            definition = page.locator(".definition").inner_text()
            assert board_now.upper() in definition, definition
            if expected:
                assert expected[:40] in definition, (expected, definition)
                check(f"the board shows a definition ({board_now.upper()}: {expected[:44]}…)")
            else:
                assert "no definition bundled" in definition, definition
                check(f"a word with no bundled definition says so ({board_now.upper()})")

            # Every played word with a bundled definition must show it, and one
            # without must not invent anything. Asserting "at least one gloss"
            # would be flaky, since a third of the word list has no definition.
            gloss_report = page.evaluate(
                """async () => {
                    const { define } = await import('./src/definitions.js');
                    return [...document.querySelectorAll('.move-list li')].map((li) => ({
                      word: li.querySelector('strong').textContent.trim(),
                      shown: Boolean(li.querySelector('.move-gloss')),
                      known: Boolean(define(li.querySelector('strong').textContent.trim())),
                    }));
                }"""
            )
            assert gloss_report, "the move list should not be empty here"
            for entry in gloss_report:
                assert entry["shown"] == entry["known"], entry
            known = sum(1 for entry in gloss_report if entry["known"])
            check(
                f"each played word shows its meaning when there is one "
                f"({known} of {len(gloss_report)} in the list)"
            )

            # --- giving up a turn: the bot plays and both racks lose the letter ---
            page.evaluate(
                """async () => {
                    const { createGame } = await import('./src/game.js');
                    localStorage.setItem(
                      'crg.game.v1', JSON.stringify(createGame('Sayan', 'Riya', 'cold')));
                }"""
            )
            page.reload()
            page.get_by_role("button", name="Resume").click()
            expect(page.get_by_role("button", name="Pass (5 left)")).to_be_visible()
            bot = page.evaluate(
                """async () => {
                    const { botMove } = await import('./src/game.js');
                    return botMove(JSON.parse(localStorage.getItem('crg.game.v1')));
                }"""
            )
            page.get_by_role("button", name="Pass (", exact=False).click()
            page.locator(".confirm .danger").click()

            expect(page.locator("button.tile span").nth(bot["pos"])).to_have_text(
                bot["letter"].upper()
            )
            expect(page.get_by_role("status").first).to_contain_text("Riya's turn.")
            for name in ("Sayan", "Riya"):
                rack = page.locator("section.rack", has=page.get_by_role("heading", name=name))
                # The on-turn rack labels its cards "Play b, …", the idle one "b, …".
                card = rack.locator(f'.card[aria-label*="{bot["letter"]}, spent"]').first
                assert card.count() == 1, f"{name} should have lost the letter the bot used"
                assert card.get_attribute("data-state") != "ready", (
                    f"{name}'s card for '{bot['letter']}' still looks unspent"
                )
                expect(rack.locator(".rack-count")).to_contain_text("26 of 27")
            check(f"giving up plays {bot['word'].upper()} and costs both players '{bot['letter'].upper()}'")

            spent_before = page.evaluate(
                """async () => {
                    const g = JSON.parse(localStorage.getItem('crg.game.v1'));
                    return g.players.map((p) => ({ spent: p.spent, wild: p.wildcardsUsed }));
                }"""
            )
            assert all(p["wild"] == 0 for p in spent_before), (
                f"a skip must not spend anybody's wildcard: {spent_before}"
            )
            check("the bot's move spends no wildcard on either side")

            expect(page.get_by_role("button", name="Pass (5 left)")).to_be_visible()
            expect(page.locator(".move-list li").first).to_contain_text("Sayan skipped")
            expect(page.locator(".move-list li").first).to_contain_text("both racks lose")
            check("only the player who gave up spends a skip, and the history records it")

            # --- cornered: only the wildcard can move, and a skip cannot substitute ---
            page.evaluate(
                """async () => {
                    const { createGame } = await import('./src/game.js');
                    const g = createGame('Sayan', 'Riya', 'cold');
                    g.players[0].spent = 'abcdefghijklmnopqrstuvwxyz'.split('');
                    localStorage.setItem('crg.game.v1', JSON.stringify(g));
                }"""
            )
            page.reload()
            page.get_by_role("button", name="Resume").click()
            expect(page.get_by_role("alert").first).to_contain_text("only your ★ wildcard can move")
            check("a wildcard-only position is announced on the board")

            # A cornered player can still pass: the bot is allowed to use a letter
            # the opponent holds, which is the whole point of that rule.
            pass_button = page.get_by_role("button", name="Pass (5 left)")
            expect(pass_button).to_be_enabled()
            check("a cornered player can still pass, using the opponent's letter")

            page.get_by_role("button", name="Hint", exact=True).click()
            answer = page.locator(".hint-answer")
            expect(answer).to_contain_text("Try slot")
            expect(answer).to_contain_text("costs your ★ wildcard")
            first_hint = answer.inner_text()
            page.get_by_role("button", name="Another hint").click()
            assert answer.inner_text() != first_hint, "asking again should offer a different move"
            check("the hint button suggests a playable move and warns it costs the wildcard")

            # --- a hint in an ordinary position prefers a plain letter ---
            page.evaluate(
                """async () => {
                    const { createGame } = await import('./src/game.js');
                    localStorage.setItem(
                      'crg.game.v1', JSON.stringify(createGame('Sayan', 'Riya', 'cold')));
                }"""
            )
            page.reload()
            page.get_by_role("button", name="Resume").click()
            page.get_by_role("button", name="Hint", exact=True).click()
            expect(page.locator(".hint-answer")).not_to_contain_text("wildcard")
            suggested = page.evaluate(
                """async () => {
                    const { hint } = await import('./src/game.js');
                    return hint(JSON.parse(localStorage.getItem('crg.game.v1')));
                }"""
            )
            page.locator("button.tile").nth(suggested["pos"]).click()
            page.locator(f'button.card[aria-label^="Play {suggested["letter"]},"]').click()
            expect(page.locator("button.tile span").nth(suggested["pos"])).to_have_text(
                suggested["letter"].upper()
            )
            check("a suggested move is actually playable, and costs no wildcard")

            # --- the count of wildcard-free moves is shown, and is right ---
            page.evaluate(
                """async () => {
                    const { createGame } = await import('./src/game.js');
                    localStorage.setItem(
                      'crg.game.v1', JSON.stringify(createGame('Sayan', 'Riya', 'cold')));
                }"""
            )
            page.reload()
            page.get_by_role("button", name="Resume").click()
            expected_count = page.evaluate(
                """async () => {
                    const { normalMoves } = await import('./src/game.js');
                    return normalMoves(JSON.parse(localStorage.getItem('crg.game.v1'))).length;
                }"""
            )
            shown = page.locator(".room-left").inner_text()
            assert str(expected_count) in shown, (expected_count, shown)
            assert "without your" in shown, shown
            check(f"the board says how many words need no wildcard ({expected_count})")

            # In a cornered position it must say there are none, not "0 words".
            page.evaluate(
                """async () => {
                    const { createGame } = await import('./src/game.js');
                    const g = createGame('Sayan', 'Riya', 'cold');
                    g.players[0].spent = 'abcdefghijklmnopqrstuvwxyz'.split('');
                    localStorage.setItem('crg.game.v1', JSON.stringify(g));
                }"""
            )
            page.reload()
            page.get_by_role("button", name="Resume").click()
            # The banner covers it, so the count line stands down rather than
            # saying the same thing twice.
            expect(page.locator(".room-left")).to_have_count(0)
            expect(page.get_by_role("alert").first).to_contain_text("only your ★ wildcard can move")
            page.get_by_role("button", name="Hint", exact=True).click()
            page.screenshot(path=str(shots / "12-cornered.png"), full_page=True)
            check("a cornered board says it once, not twice")

            # --- passing scores, and two clear passes wins ---
            page.evaluate(
                """async () => {
                    const { createGame } = await import('./src/game.js');
                    localStorage.setItem(
                      'crg.game.v1', JSON.stringify(createGame('Sayan', 'Riya', 'cold')));
                }"""
            )
            page.reload()
            page.get_by_role("button", name="Resume").click()

            def take_pass(pg):
                pg.get_by_role("button", name="Pass (", exact=False).click()
                pg.locator(".confirm .danger").click()

            take_pass(page)  # Sayan passes: Riya leads 1-0
            expect(page.locator(".pass-warning")).to_contain_text("one pass from winning")
            expect(page.locator(".rack", has_text="Sayan").first).to_contain_text("passed 1 time")
            check("a pass is scored against the passer, and the lead is called out")

            # Riya plays on, then Sayan passes again and is two clear passes behind.
            move = page.evaluate(
                """async () => {
                    const { normalMoves } = await import('./src/game.js');
                    return normalMoves(JSON.parse(localStorage.getItem('crg.game.v1')))[0];
                }"""
            )
            page.locator("button.tile").nth(move["pos"]).click()
            page.locator(f'button.card[aria-label^="Play {move["letter"]},"]').click()
            take_pass(page)

            expect(page.locator(".outcome h2")).to_contain_text("Riya wins")
            expect(page.locator(".outcome")).to_contain_text("fell 2 passes behind")
            state_now = page.evaluate("JSON.parse(localStorage.getItem('crg.game.v1'))")
            assert state_now["outcome"]["reason"] == "passes", state_now["outcome"]
            assert [p["skipsUsed"] for p in state_now["players"]] == [2, 0]
            check("falling two clear passes behind ends the game, and says why")
            page.screenshot(path=str(shots / "17-pass-loss.png"), full_page=True)

            # --- skips run out ---
            page.evaluate(
                """async () => {
                    const { createGame, SKIPS_PER_PLAYER } = await import('./src/game.js');
                    const g = createGame('Sayan', 'Riya', 'cold');
                    g.players[0].skipsUsed = SKIPS_PER_PLAYER;
                    localStorage.setItem('crg.game.v1', JSON.stringify(g));
                }"""
            )
            page.reload()
            page.get_by_role("button", name="Resume").click()
            no_skips = page.get_by_role("button", name="No passes left")
            expect(no_skips).to_be_visible()
            expect(no_skips).to_be_disabled()
            check("a player with no skips left cannot give up a turn")

            # --- wildcard: seed a state where the player on turn must replay a spent letter ---
            page.evaluate(
                """async () => {
                    const { createGame } = await import('./src/game.js');
                    const g = createGame('Sayan', 'Riya', 'cold');
                    g.players[0].spent = ['b'];
                    localStorage.setItem('crg.game.v1', JSON.stringify(g));
                }"""
            )
            page.reload()
            page.get_by_role("button", name="Resume").click()
            expect(page.locator(".wildcard-state").first).to_have_text("★ Wildcard available")
            page.locator("button.tile").first.click()
            page.locator('button.card[aria-label^="Play b,"]').click()
            expect(page.get_by_role("alert").first).to_contain_text("costs your wildcard")
            check("replaying a spent letter asks before spending the wildcard")

            page.screenshot(path=str(shots / "03-wildcard-prompt.png"), full_page=True)

            page.get_by_role("button", name="Cancel").click()
            expect(page.locator(".confirm-wildcard")).to_have_count(0)
            expect(page.locator("button.tile span").first).to_have_text("C")
            check("cancelling the wildcard leaves the board untouched")

            page.locator("button.tile").first.click()
            page.locator('button.card[aria-label^="Play b,"]').click()
            page.get_by_role("button", name="Spend wildcard on B").click()
            expect(page.locator("button.tile span").first).to_have_text("B")
            expect(page.get_by_role("status").first).to_contain_text("Riya's turn.")
            sayan_rack = page.locator("section.rack", has=page.get_by_role("heading", name="Sayan"))
            expect(sayan_rack.locator(".wildcard-state")).to_have_text("☆ Wildcard used")
            expect(sayan_rack.locator(".rack-count")).to_contain_text("25 of 27")
            check("spending the wildcard replays the letter and drops the count to 25 of 27")

            # --- play a whole game out to a result, only ever through the UI ---
            def state():
                return page.evaluate("JSON.parse(localStorage.getItem('crg.game.v1'))")

            plies = 0
            for _ in range(400):
                if page.locator(".outcome").count():
                    break
                move = page.evaluate(
                    """async () => {
                        const { legalMoves } = await import('./src/game.js');
                        const game = JSON.parse(localStorage.getItem('crg.game.v1'));
                        const moves = legalMoves(game);
                        return moves.length ? moves[0] : null;
                    }"""
                )
                assert move is not None, (
                    "an unfinished game must offer a move: running out is the loss"
                )
                before = len(state()["history"])
                page.locator("button.tile").nth(move["pos"]).click()
                page.locator(f'button.card[aria-label^="Play {move["letter"]},"]').click()
                # A spent letter opens the wildcard prompt instead of moving.
                if page.locator(".confirm-wildcard").count():
                    page.get_by_role(
                        "button", name=f"Spend wildcard on {move['letter'].upper()}"
                    ).click()
                after = len(state()["history"])
                assert after == before + 1, f"UI did not advance the game at ply {plies}"
                plies += 1
            expect(page.locator(".outcome")).to_have_count(1)
            expect(page.locator(".outcome h2")).to_contain_text("wins")
            final = state()
            assert final["outcome"]["reason"] == "stuck", final["outcome"]
            check(f"a game played to exhaustion over {plies} plies shows a winner")

            page.screenshot(path=str(shots / "04-result.png"), full_page=True)

            # --- the result is recorded against both players ---
            page.get_by_role("button", name="Back to lobby").click()
            expect(page.get_by_text("Playing as")).to_be_visible()
            expect(page.locator(".user-meta").first).to_contain_text("W /")
            check("returning to the lobby shows updated win/loss records")

            # --- deleting a user is two-step and clears their game ---
            page.get_by_role("button", name="Remove Riya").click()
            page.get_by_role("button", name="Delete").click()
            expect(page.get_by_role("button", name="Play against Riya")).to_have_count(0)
            check("a stale player can be deleted")

            # --- mobile viewport still shows every control ---
            page.set_viewport_size({"width": 390, "height": 844})
            page.get_by_label("Opponent").fill("Mo")
            page.get_by_role("button", name="Play", exact=True).click()
            expect(page.locator("button.tile")).to_have_count(4)
            box = page.locator("button.card").first.bounding_box()
            assert box and box["height"] >= 40, f"cards too small on mobile: {box}"
            check(f"mobile layout keeps cards tappable ({box['width']:.0f}x{box['height']:.0f}px)")
            page.screenshot(path=str(shots / "05-mobile.png"), full_page=True)

            # --- lock returns to the gate ---
            page.set_viewport_size({"width": 1280, "height": 1400})
            page.get_by_role("button", name="Lock").click()
            expect(page.get_by_role("heading", name="Enter the password")).to_be_visible()
            check("Lock returns to the password gate")

            # ================================================================
            # Remote play: two independent browser profiles passing one link.
            # Separate contexts means separate localStorage, so the second
            # player genuinely has no local copy of the game.
            # ================================================================
            ctx_a = browser.new_context(viewport={"width": 1280, "height": 1400})
            ctx_b = browser.new_context(viewport={"width": 1280, "height": 1400})
            for ctx in (ctx_a, ctx_b):
                ctx.on("weberror", lambda e: problems.append(f"weberror: {e.error}"))
            alice, bob = ctx_a.new_page(), ctx_b.new_page()
            for pg in (alice, bob):
                pg.on(
                    "console",
                    lambda m: problems.append(f"console.{m.type}: {m.text}")
                    if m.type == "error"
                    else None,
                )
                pg.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))

            def unlock(pg, url=base):
                pg.goto(url)
                if pg.get_by_label("Password").count():
                    pg.get_by_label("Password").fill(PASSWORD)
                    pg.get_by_role("button", name="Unlock").click()

            def engine_move(pg):
                return pg.evaluate(
                    """async () => {
                        const { legalMoves } = await import('./src/game.js');
                        const { readGameFromLocation } = await import('./src/link.js');
                        const shared = readGameFromLocation();
                        const game = shared ? shared.game
                                            : JSON.parse(localStorage.getItem('crg.game.v1'));
                        return legalMoves(game)[0];
                    }"""
                )

            def play(pg, move):
                pg.locator("button.tile").nth(move["pos"]).click()
                pg.locator(f'button.card[aria-label^="Play {move["letter"]},"]').click()
                if pg.locator(".confirm-wildcard").count():
                    pg.get_by_role(
                        "button", name=f"Spend wildcard on {move['letter'].upper()}"
                    ).click()

            # Alice starts a game locally and takes the first turn.
            unlock(alice)
            alice.get_by_label("New player name").fill("Alice")
            alice.get_by_role("button", name="Create and continue").click()
            alice.get_by_label("Opponent").fill("Bob")
            alice.get_by_role("button", name="Play", exact=True).click()
            # Seed a rich opening word: a random one can dead-end within a couple
            # of moves, which would make these checks flaky for no good reason.
            alice.evaluate(
                """async () => {
                    const { createGame } = await import('./src/game.js');
                    localStorage.setItem(
                      'crg.game.v1', JSON.stringify(createGame('Alice', 'Bob', 'cold')));
                }"""
            )
            alice.reload()
            alice.get_by_role("button", name="Resume").click()
            expect(alice.get_by_role("status").first).to_contain_text("Alice's turn.")
            play(alice, engine_move(alice))
            expect(alice.get_by_role("status").first).to_contain_text("Bob's turn.")

            expect(alice.locator(".share h3")).to_contain_text("Bob is up")
            invite = alice.locator("#share-url").input_value()
            assert invite.startswith(base) and "#g=" in invite, invite
            word_after_alice = alice.evaluate(
                "[...document.querySelectorAll('button.tile span')].map(s=>s.textContent).join('')"
            )
            check(f"after moving, the board offers a link for the opponent ({len(invite)} chars)")
            alice.screenshot(path=str(shots / "06-share-link.png"), full_page=True)

            # Bob opens the link in a profile that has never seen this game.
            unlock(bob, invite)
            assert bob.evaluate("localStorage.getItem('crg.game.v1')") is None, (
                "the shared game must not be written into the joiner's local storage"
            )
            expect(bob.locator("button.tile")).to_have_count(4)
            assert (
                bob.evaluate(
                    "[...document.querySelectorAll('button.tile span')].map(s=>s.textContent).join('')"
                )
                == word_after_alice
            )
            expect(bob.get_by_role("status").first).to_contain_text("Your turn.")
            expect(bob.locator(".identity")).to_contain_text("You are Bob")
            expect(bob.locator('.rack[data-you="true"] h3')).to_contain_text("Bob")
            check("opening the link joins the game at the same position, with no local account")
            check("the joiner is told which side they are playing")

            # Both sides must agree on the spent cards, which travel only implicitly.
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
                          wildcard: rack.querySelector('.wildcard-state').textContent.trim(),
                        };
                    }""",
                    name,
                )

            for name in ("Alice", "Bob"):
                assert rack_state(alice, name) == rack_state(bob, name), (
                    f"{name}'s rack differs between the two players"
                )
            check("both players see identical racks, spent cards and wildcard state")

            # Bob replies, and hands a fresh link back to Alice.
            play(bob, engine_move(bob))
            expect(bob.get_by_role("status").first).to_contain_text("Waiting for Alice")
            assert bob.locator("button.tile[disabled]").count() == 4, (
                "after moving, a link player must not be able to play the other side"
            )
            reply = bob.locator("#share-url").input_value()
            assert reply != invite, "the link must change after a move"
            assert bob.evaluate("location.hash").startswith("#g="), "the address bar must track the position"
            check("the reply produces a new link and updates the address bar")

            # A reload of Bob's tab keeps the position: the URL is the only copy.
            bob.reload()
            expect(bob.locator("button.tile")).to_have_count(4)
            # A reload re-reads the fragment, so the reloader now holds Alice's seat.
            expect(bob.get_by_role("status").first).to_contain_text("Your turn.")
            expect(bob.locator(".identity")).to_contain_text("You are Alice")
            check("reloading a shared game keeps the position")

            # Alice opens the reply and sees Bob's move in the history.
            unlock(alice, reply)
            expect(alice.get_by_role("status").first).to_contain_text("Your turn.")
            expect(alice.locator(".identity")).to_contain_text("You are Alice")
            expect(alice.locator(".move-list li")).to_have_count(2)
            expect(alice.locator(".move-list li").first).to_contain_text("Bob")
            check("the opponent's move arrives in the history when the link is opened")

            # A link mangled in transit is refused with a reason, not half-loaded.
            unlock(bob, invite[: len(invite) - 6])
            expect(bob.get_by_role("heading", name="That link did not work")).to_be_visible()
            expect(bob.get_by_role("alert")).not_to_be_empty()
            expect(bob.locator("button.tile")).to_have_count(0)
            check("a truncated link shows a reason instead of a broken board")
            bob.screenshot(path=str(shots / "07-bad-link.png"), full_page=True)

            bob.get_by_role("button", name="Start a game instead").click()
            expect(bob.get_by_role("heading", name="Who are you?")).to_be_visible()
            assert bob.evaluate("location.hash") == "", "leaving must clear the fragment"
            check("leaving a bad link clears the fragment and returns to sign-in")

            ctx_a.close()
            ctx_b.close()
            browser.close()
    finally:
        httpd.shutdown()

    if problems:
        print("\nBrowser reported problems:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        return 1

    print(f"\n{checks} UI checks passed, no console errors. Screenshots in {shots}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
