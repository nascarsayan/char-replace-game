import { html, render, useState } from '../vendor/preact-standalone.module.js';
import { applyMove, createGame, resign } from './game.js';
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

  /** Single write path: state and localStorage never drift apart. */
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

  let screen;
  if (!unlocked) {
    screen = html`<${Gate} onUnlocked=${() => setUnlocked(true)} />`;
  } else if (!me) {
    screen = html`<${SignIn} onSignedIn=${setMe} />`;
  } else if (playing && game) {
    screen = html`<${Board}
      game=${game}
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
        Two players, one screen. Everything is stored in this browser.
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
