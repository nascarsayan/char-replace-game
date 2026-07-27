import { html, render, useEffect, useState } from '../vendor/preact-standalone.module.js';
import { applyMove, createGame, resign } from './game.js';
import { buildShareUrl, readGameFromLocation, writeGameToLocation } from './link.js';
import * as store from './store.js';
import { Board } from './components/Board.js';
import { Gate } from './components/Gate.js';
import { Lobby } from './components/Lobby.js';
import { SignIn } from './components/SignIn.js';

function App() {
  const [unlocked, setUnlocked] = useState(store.isUnlocked);
  const [me, setMe] = useState(store.getSession);
  const [game, setGame] = useState(store.loadGame);
  const [playing, setPlaying] = useState(false);
  // A game arriving by link: { game } when it decodes, { error } when it does not.
  const [shared, setShared] = useState(readGameFromLocation);

  // Pasting a different link into the same tab changes the fragment without a
  // reload, so the position has to be re-read.
  useEffect(() => {
    function onHashChange() {
      setShared(readGameFromLocation());
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  /** Local games: one write path, so state and localStorage never drift apart. */
  function commit(next) {
    setGame(next);
    store.saveGame(next);
    if (next.outcome) {
      store.recordResult(
        next.players[next.outcome.winner].name,
        next.players[next.outcome.loser].name,
      );
    }
  }

  /**
   * Shared games live in the URL rather than localStorage: the link is the only
   * copy, so a reload keeps the position, and the local player list stays free
   * of names the other side typed.
   */
  function commitShared(next) {
    setShared({ game: next });
    writeGameToLocation(next);
  }

  function startGame(nameA, nameB) {
    commit(createGame(nameA, nameB));
    setPlaying(true);
  }

  function leaveGame() {
    setPlaying(false);
    if (game && game.outcome) {
      store.clearGame();
      setGame(null);
    }
  }

  function leaveSharedGame() {
    // Drop the fragment, or the lobby is immediately replaced by the link again.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setShared(null);
  }

  let screen;
  if (!unlocked) {
    screen = html`<${Gate} onUnlocked=${() => setUnlocked(true)} />`;
  } else if (shared && shared.error) {
    screen = html`<div class="panel">
      <h2>That link did not work</h2>
      <p class="error" role="alert">${shared.error}</p>
      <p>Ask your opponent to send the whole link again — chat apps like to cut them short.</p>
      <button type="button" class="big" onClick=${leaveSharedGame}>Start a game instead</button>
    </div>`;
  } else if (shared && shared.game) {
    // A shared link needs no local account: the names travel with the position.
    screen = html`<${Board}
      game=${shared.game}
      shareUrl=${buildShareUrl(shared.game)}
      onMove=${(pos, letter) => commitShared(applyMove(shared.game, pos, letter))}
      onResign=${(playerIdx) => commitShared(resign(shared.game, playerIdx))}
      onRematch=${() =>
        commitShared(createGame(shared.game.players[0].name, shared.game.players[1].name))}
      onExit=${leaveSharedGame}
    />`;
  } else if (!me) {
    screen = html`<${SignIn} onSignedIn=${setMe} />`;
  } else if (playing && game) {
    screen = html`<${Board}
      game=${game}
      shareUrl=${buildShareUrl(game)}
      onMove=${(pos, letter) => commit(applyMove(game, pos, letter))}
      onResign=${(playerIdx) => commit(resign(game, playerIdx))}
      onRematch=${() => startGame(game.players[0].name, game.players[1].name)}
      onExit=${leaveGame}
    />`;
  } else {
    screen = html`<${Lobby}
      me=${me}
      savedGame=${game && !game.outcome ? game : null}
      onStart=${startGame}
      onResume=${() => setPlaying(true)}
      onDiscard=${() => {
        store.clearGame();
        setGame(null);
      }}
      onSignOut=${() => {
        store.setSession(null);
        setMe(null);
      }}
    />`;
  }

  return html`
    <header class="site-head">
      <h1>Char Replace</h1>
      <p class="tagline">Swap one letter. Make a word. Do not run out of cards.</p>
    </header>
    <main>${screen}</main>
    <footer class="site-foot">
      <small>
        Play side by side, or send the link after each move.
        ${unlocked
          ? html`<button
              type="button"
              class="link"
              onClick=${() => {
                store.lock();
                setMe(null);
                setPlaying(false);
                setUnlocked(false);
              }}
            >
              Lock
            </button>`
          : null}
      </small>
    </footer>
  `;
}

render(html`<${App} />`, document.getElementById('app'));
