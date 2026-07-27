#!/usr/bin/env python3
"""End-to-end UI test. Serves the repo and drives it with Playwright/Firefox.

    pip install playwright && python -m playwright install firefox
    python3 tools/test-ui.py [--headed] [--shots DIR]

Fails loudly on any console error or page exception.
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


def serve(directory: pathlib.Path) -> tuple[str, socketserver.TCPServer]:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    handler.log_message = lambda *a, **k: None  # type: ignore[method-assign]
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
            expect(page.get_by_role("status")).to_contain_text("Sayan's turn.")
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
            expect(page.get_by_role("status")).to_contain_text("Sayan's turn.")
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
            expect(page.get_by_role("status")).to_contain_text("Riya's turn.")
            check(f"a legal move plays ({word} -> {move['word']}) and passes the turn")

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
            expect(page.get_by_role("status")).to_contain_text("Sayan's turn.")
            expect(page.locator("button.tile span").nth(move2["pos"])).to_have_text(move2["letter"].upper())
            check("digit-then-letter keyboard entry plays a move")

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
            expect(page.get_by_role("status")).to_contain_text("Riya's turn.")
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
                assert move is not None, "engine says no moves but the UI shows no result"
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
