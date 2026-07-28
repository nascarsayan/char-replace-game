import { html, render, useEffect, useState } from '../vendor/preact-standalone.module.js';
import { applyMove, applySkip, createGame, resign } from './game.js';
import { buildShareUrl, readGameFromLocation, writeGameToLocation } from './link.js';
import { cloudConfigured } from './cloud.js';
import { createRoomCode, isRoomCode, normaliseRoomCode } from './net.js';
import * as store from './store.js';
import { Board } from './components/Board.js';
import { Gate } from './components/Gate.js';
import { CloudGame } from './components/CloudGame.js';
import { LiveGame } from './components/LiveGame.js';
import { LiveLobby } from './components/LiveLobby.js';
import { Lobby } from './components/Lobby.js';
import { SignIn } from './components/SignIn.js';

/** A live invite is `#r=CODE`; a shared position is `#g=…`. */
function readRoomFromLocation() {
  const match = /(?:^|[#&])r=([A-Za-z0-9]+)/.exec(window.location.hash || '');
  if (!match) return null;
  const code = normaliseRoomCode(match[1]);
  return isRoomCode(code) ? code : null;
}

function App() {
  const [unlocked, setUnlocked] = useState(store.isUnlocked);
  const [me, setMe] = useState(store.getSession);
  const [game, setGame] = useState(store.loadGame);
  const [playing, setPlaying] = useState(false);
  // A game arriving by link: { game } when it decodes, { error } when it does not.
  const [shared, setShared] = useState(readGameFromLocation);
  // Which side you play in a link game: the side on turn when you opened it.
  // Fixed for the session, so after you move it correctly reads as the
  // opponent's turn instead of inviting you to play for them.
  const [sharedSeat, setSharedSeat] = useState(() => {
    const initial = readGameFromLocation();
    return initial && initial.game ? initial.game.turn : null;
  });
  // A live game: { role, roomCode }. `invited` is a code from the address bar.
  const [live, setLive] = useState(null);
  const [browsingLive, setBrowsingLive] = useState(false);
  const [invited, setInvited] = useState(readRoomFromLocation);

  // Pasting a different link into the same tab changes the fragment without a
  // reload, so the position has to be re-read.
  useEffect(() => {
    function onHashChange() {
      const next = readGameFromLocation();
      setShared(next);
      setSharedSeat(next && next.game ? next.game.turn : null);
      setInvited(readRoomFromLocation());
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

  function clearFragment() {
    // Drop the fragment, or the lobby is immediately replaced by the link again.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function leaveSharedGame() {
    clearFragment();
    setShared(null);
  }

  function leaveLiveGame() {
    clearFragment();
    setLive(null);
    setInvited(null);
    setBrowsingLive(false);
  }

  function hostLiveGame() {
    const roomCode = createRoomCode();
    window.history.replaceState(null, '', `#r=${roomCode}`);
    setBrowsingLive(false);
    setLive({ role: 'host', roomCode });
  }

  /** Picks up a game this identity is already part of; the seat comes from it. */
  function resumeLiveGame(roomCode) {
    window.history.replaceState(null, '', `#r=${roomCode}`);
    setBrowsingLive(false);
    setInvited(null);
    setLive({ role: 'resume', roomCode });
  }

  function joinLiveGame(roomCode) {
    window.history.replaceState(null, '', `#r=${roomCode}`);
    setBrowsingLive(false);
    setInvited(null);
    setLive({ role: 'guest', roomCode });
  }

  let screen;
  if (!unlocked) {
    screen = html`<${Gate} onUnlocked=${() => setUnlocked(true)} />`;
  } else if (live) {
    // A relayed room is reliable and persists, so it is preferred whenever a
    // database is configured; otherwise fall back to peer-to-peer.
    const Live = cloudConfigured() ? CloudGame : LiveGame;
    // Keyed on the room so switching rooms tears the old connection down.
    screen = html`<${Live}
      key=${`${live.role}:${live.roomCode}`}
      role=${live.role}
      roomCode=${live.roomCode}
      me=${me || 'Guest'}
      onExit=${leaveLiveGame}
    />`;
  } else if (invited && me) {
    // Arrived on an invite link and already have a name: join straight away.
    screen = html`<div class="panel">
      <h2>${`Join live game ${invited}?`}</h2>
      <p>${`You will play as ${me}.`}</p>
      <button type="button" class="big" onClick=${() => joinLiveGame(invited)}>Join</button>
      <button type="button" class="secondary outline" onClick=${leaveLiveGame}>Back</button>
    </div>`;
  } else if (browsingLive && me) {
    screen = html`<${LiveLobby}
      me=${me}
      onHost=${hostLiveGame}
      onJoin=${joinLiveGame}
      onCancel=${() => setBrowsingLive(false)}
    />`;
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
      youAre=${sharedSeat}
      locked=${sharedSeat !== null && shared.game.turn !== sharedSeat}
      onMove=${(pos, letter) => commitShared(applyMove(shared.game, pos, letter))}
      onSkip=${() => commitShared(applySkip(shared.game))}
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
      onSkip=${() => commit(applySkip(game))}
      onResign=${(playerIdx) => commit(resign(game, playerIdx))}
      onRematch=${() => startGame(game.players[0].name, game.players[1].name)}
      onExit=${leaveGame}
    />`;
  } else {
    screen = html`<${Lobby}
      me=${me}
      savedGame=${game && !game.outcome ? game : null}
      onStart=${startGame}
      onPlayLive=${() => setBrowsingLive(true)}
      onResumeRoom=${(roomCode) => resumeLiveGame(roomCode)}
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
        Play live, side by side, or by sending a link after each move.
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
