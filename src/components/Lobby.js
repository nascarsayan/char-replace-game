import { html, useEffect, useState } from '../../vendor/preact-standalone.module.js';
import * as identity from '../identity.js';
import { addUser, deleteUser, findUser, listUsers, normaliseName } from '../store.js';
import { Rules } from './Rules.js';
import { UserPicker } from './UserPicker.js';

// Built as a string because htm drops the whitespace between adjacent ${}
// expressions, which would run the words together.
function describeSavedGame(game) {
  const plies = game.history.length;
  const progress = plies === 1 ? '1 move in' : `${plies} moves in`;
  return `${game.players[0].name} vs ${game.players[1].name} — on ${game.word.toUpperCase()}, ${progress}.`;
}

/** Opponent selection. Both players share this screen and keyboard — hotseat. */
export function Lobby({
  me,
  savedGame,
  onStart,
  onPlayLive,
  onResumeRoom,
  onResume,
  onDiscard,
  onSignOut,
}) {
  const [users, setUsers] = useState(listUsers);
  const [opponent, setOpponent] = useState('');
  const [error, setError] = useState('');
  // Unfinished relayed games this identity is in, wherever they were started.
  const [rooms, setRooms] = useState(null);

  useEffect(() => {
    if (!identity.identitiesAreShared()) {
      setRooms([]);
      return;
    }
    let live = true;
    identity
      .listResumableGames(me)
      .then((found) => live && setRooms(found))
      .catch(() => live && setRooms([]));
    return () => {
      live = false;
    };
  }, [me]);

  function start(name) {
    const clean = normaliseName(name);
    if (!clean) return setError('Name the opponent first.');
    if (clean.toLowerCase() === me.toLowerCase()) return setError('Pick someone other than you.');
    if (!findUser(clean)) {
      try {
        addUser(clean);
        setUsers(listUsers());
      } catch (err) {
        return setError(err.message);
      }
    }
    onStart(me, findUser(clean).name);
  }

  function remove(userName) {
    deleteUser(userName);
    setUsers(listUsers());
  }

  return html`
    <div class="panel">
      <p class="signed-in">
        <!-- One span: space-between would otherwise set the name adrift from its label. -->
        <span>Playing as <strong>${me}</strong></span>
        <button type="button" class="secondary outline" onClick=${onSignOut}>Switch player</button>
      </p>

      ${identity.identitiesAreShared()
        ? html`<section class="resume" aria-label="Your unfinished games">
            <h3>Pick up where you left off</h3>
            ${rooms === null
              ? html`<p class="muted" aria-live="polite">Looking for your games…</p>`
              : rooms.length === 0
                ? html`<p class="muted">
                    No unfinished games. Start a live one and it will wait for you here, on any
                    device.
                  </p>`
                : html`<ul class="game-list" role="list">
                    ${rooms.map(
                      (room) => html`<li>
                        <button
                          type="button"
                          class="big game-pick"
                          onClick=${() => onResumeRoom(room.code)}
                        >
                          <span class="game-word">${room.word.toUpperCase()}</span>
                          <span class="game-meta"
                            >${`vs ${room.opponent} · ${room.plies} ${
                              room.plies === 1 ? 'move' : 'moves'
                            } · ${room.yourTurn ? 'your turn' : `waiting for ${room.onTurn}`} · room ${room.code}`}</span
                          >
                        </button>
                      </li>`,
                    )}
                  </ul>`}
          </section>`
        : null}

      ${savedGame
        ? html`<div class="resume">
            <h3>Unfinished game on this device</h3>
            <p>${describeSavedGame(savedGame)}</p>
            <button type="button" class="big" onClick=${onResume}>Resume</button>
            <button type="button" class="secondary" onClick=${onDiscard}>Discard</button>
          </div>`
        : null}

      <h2>Play someone else</h2>
      <p>
        A live game connects your two browsers directly, so moves appear as they happen. You both
        need to be online.
      </p>
      <button type="button" class="big" onClick=${onPlayLive}>Play live</button>

      <h2>Or play on this device</h2>
      <p>Take turns on one screen, or send a link after each move.</p>
      <form
        onSubmit=${(e) => {
          e.preventDefault();
          start(opponent);
        }}
      >
        <label>
          Opponent
          <input
            type="text"
            name="opponent"
            maxlength="24"
            autocomplete="off"
            placeholder="new or existing name"
            value=${opponent}
            onInput=${(e) => {
              setOpponent(e.target.value);
              setError('');
            }}
            aria-invalid=${error ? 'true' : undefined}
            aria-describedby="lobby-error"
          />
        </label>
        <p id="lobby-error" class="error" role="alert">${error}</p>
        <button type="submit" class="big">Play</button>
      </form>

      <h3>Or pick a saved player</h3>
      <${UserPicker}
        users=${users}
        pickLabel="Play against"
        onPick=${start}
        onDelete=${remove}
        skipName=${me}
      />

      <${Rules} />
    </div>
  `;
}
