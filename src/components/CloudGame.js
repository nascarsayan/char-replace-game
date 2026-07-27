import { html, useEffect, useRef, useState } from '../../vendor/preact-standalone.module.js';
import { applyMove, applySkip, createGame, resign } from '../game.js';
import { connectCloud } from '../cloud.js';
import { Board } from './Board.js';
import { WaitingRoom } from './LiveLobby.js';

// Seats are fixed by role, so both browsers agree without negotiating.
const HOST_SEAT = 0;
const GUEST_SEAT = 1;

/**
 * A live game relayed through the database. The host creates the room; after
 * that whoever is on turn writes the new position and the other side sees it.
 * Only one player can move at a time, so the two never write at once.
 *
 * The room persists, which is the real gain over peer-to-peer: you can close the
 * tab, come back later, and the game is still there.
 */
export function CloudGame({ role, roomCode, me, onExit }) {
  const seat = role === 'host' ? HOST_SEAT : GUEST_SEAT;
  const [game, setGame] = useState(null);
  const [room, setRoom] = useState(null);
  const [problem, setProblem] = useState('');

  const gameRef = useRef(game);
  gameRef.current = game;
  const linkRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const link = connectCloud({
      roomCode,
      onRoom: (next) => {
        if (cancelled) return;
        setRoom(next);
        // The host owns the names, so it applies whatever the guest announced.
        if (role === 'host' && next.guest && gameRef.current) {
          const current = gameRef.current;
          if (current.players[GUEST_SEAT].name !== next.guest) {
            const renamed = {
              ...current,
              players: current.players.map((player, index) =>
                index === GUEST_SEAT ? { ...player, name: next.guest } : player,
              ),
            };
            setGame(renamed);
            link.publish(renamed).catch((err) => setProblem(err.message));
          }
        }
      },
      onGame: (next) => {
        if (cancelled) return;
        setProblem('');
        setGame(next);
      },
      onProblem: (message) => {
        if (!cancelled) setProblem(message);
      },
    });
    linkRef.current = link;

    // The host seeds the room; a guest only announces itself and waits.
    if (role === 'host') {
      const fresh = createGame(me, 'Opponent');
      setGame(fresh);
      link
        .publish(fresh)
        .then(() => link.setNames({ host: me }))
        .catch((err) => setProblem(err.message));
    } else {
      link.setNames({ guest: me }).catch((err) => setProblem(err.message));
    }

    return () => {
      cancelled = true;
      link.close();
      linkRef.current = null;
    };
    // eslint-disable-next-line -- one connection per mount, on purpose
  }, []);

  function push(next) {
    setGame(next);
    if (linkRef.current) {
      linkRef.current.publish(next).catch((err) => setProblem(err.message));
    }
  }

  if (!game) {
    return html`<div class="panel">
      <h2>${`Joining ${roomCode}`}</h2>
      <p aria-live="polite">
        ${room === null ? 'Connecting to the game room…' : 'Waiting for the host to open the game…'}
      </p>
      ${problem ? html`<p class="error" role="alert">${problem}</p>` : null}
      <button type="button" class="secondary outline" onClick=${onExit}>Back</button>
    </div>`;
  }

  // Nobody has joined yet: show the code rather than an idle board.
  const opponentHere = role === 'host' ? Boolean(room && room.guest) : true;
  if (role === 'host' && !opponentHere && game.history.length === 0) {
    const base = `${window.location.origin}${window.location.pathname}`;
    return html`<${WaitingRoom}
      roomCode=${roomCode}
      inviteUrl=${`${base}#r=${roomCode}`}
      onCancel=${onExit}
    />`;
  }

  return html`<${Board}
    game=${game}
    youAre=${seat}
    locked=${game.turn !== seat}
    status=${problem}
    onMove=${(pos, letter) => push(applyMove(game, pos, letter))}
    onSkip=${() => push(applySkip(game))}
    onResign=${(playerIdx) => push(resign(game, playerIdx))}
    onRematch=${() => push(createGame(game.players[0].name, game.players[1].name))}
    onExit=${onExit}
  />`;
}
