import { html, useEffect, useRef, useState } from '../../vendor/preact-standalone.module.js';
import { applyMove, applySkip, createGame, resign } from '../game.js';
import { connect } from '../net.js';
import { Board } from './Board.js';
import { WaitingRoom } from './LiveLobby.js';

// Seats are fixed by role, so both browsers agree without negotiating: whoever
// opened the room plays first, whoever joined plays second.
const HOST_SEAT = 0;
const GUEST_SEAT = 1;

/**
 * Owns one live connection for its whole lifetime. The host creates the game and
 * is the one who tells a joiner the current position; after that either side
 * broadcasts the new position when they move. Only the player on turn can move,
 * so the two never write at once.
 */
export function LiveGame({ role, roomCode, me, onExit }) {
  const seat = role === 'host' ? HOST_SEAT : GUEST_SEAT;
  const [game, setGame] = useState(() =>
    role === 'host' ? createGame(me, 'Opponent') : null,
  );
  const [peers, setPeers] = useState(0);
  const [problem, setProblem] = useState('');

  // Callbacks are registered once, so they read live values through refs.
  const gameRef = useRef(game);
  gameRef.current = game;
  const linkRef = useRef(null);

  useEffect(() => {
    const link = connect({
      roomCode,
      onPeers: (count) => {
        setPeers(count);
        if (count === 0) return;
        // A joiner announces itself; the host answers with the position. This
        // also covers the joiner reloading mid-game.
        if (role === 'host') {
          if (gameRef.current) link.sendState(gameRef.current);
        } else {
          link.sendHello(me);
        }
      },
      onState: (next) => {
        setProblem('');
        setGame(next);
      },
      onHello: (name) => {
        if (role !== 'host') return;
        const current = gameRef.current;
        if (!current || current.players[GUEST_SEAT].name === name) return;
        const renamed = {
          ...current,
          players: current.players.map((player, index) =>
            index === GUEST_SEAT ? { ...player, name } : player,
          ),
        };
        setGame(renamed);
        link.sendState(renamed);
      },
      onProblem: setProblem,
    });
    linkRef.current = link;
    return () => {
      link.leave();
      linkRef.current = null;
    };
    // eslint-disable-next-line -- one connection per mount, on purpose
  }, []);

  function push(next) {
    setGame(next);
    if (linkRef.current) linkRef.current.sendState(next);
  }

  if (!game) {
    return html`<div class="panel">
      <h2>Joining ${roomCode}</h2>
      <p aria-live="polite">
        ${peers > 0
          ? 'Connected — waiting for the position…'
          : 'Looking for the host. This can take a few seconds.'}
      </p>
      ${problem ? html`<p class="error" role="alert">${problem}</p>` : null}
      <button type="button" class="secondary outline" onClick=${onExit}>Back</button>
    </div>`;
  }

  if (role === 'host' && peers === 0 && game.history.length === 0) {
    const base = `${window.location.origin}${window.location.pathname}`;
    return html`<${WaitingRoom}
      roomCode=${roomCode}
      inviteUrl=${`${base}#r=${roomCode}`}
      onCancel=${onExit}
    />`;
  }

  const status = problem
    ? problem
    : peers === 0
      ? 'Your opponent has dropped out — waiting for them to come back…'
      : '';

  return html`<${Board}
    game=${game}
    youAre=${seat}
    locked=${game.turn !== seat || peers === 0}
    status=${status}
    onMove=${(pos, letter) => push(applyMove(game, pos, letter))}
    onSkip=${() => push(applySkip(game))}
    onResign=${(playerIdx) => push(resign(game, playerIdx))}
    onRematch=${() => push(createGame(game.players[0].name, game.players[1].name))}
    onExit=${onExit}
  />`;
}
