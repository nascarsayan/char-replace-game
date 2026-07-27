// Live games relayed through Firebase Realtime Database.
//
// Deliberately no Firebase SDK: the REST API is enough, so there is nothing to
// bundle. Writes are plain fetch(PATCH); updates arrive over EventSource, which
// sets `Accept: text/event-stream` itself, and that is exactly what makes the
// database answer with its streaming protocol.
//
// Unlike the peer-to-peer transport this is a relay, so it works through any NAT
// or firewall, and the room persists: both players do not have to be online at
// the same moment.
import { DATABASE_URL } from './cloud-config.js';
import { decodeGame, encodeGame } from './link.js';

export const cloudConfigured = () => Boolean(DATABASE_URL);

const roomUrl = (roomCode) => `${DATABASE_URL.replace(/\/+$/, '')}/rooms/${roomCode}.json`;

/**
 * Applies one streaming event to our local copy of the room.
 *
 * The database sends `{path, data}`; a null `data` means the value was removed.
 * `put` replaces what is at `path`, `patch` merges into it. Only the shallow
 * paths this schema actually produces are handled.
 */
export function applyEvent(room, { path, data }, isPatch) {
  if (path === '/') {
    if (!isPatch) return data === null ? {} : { ...data };
    return { ...room, ...(data || {}) };
  }
  const key = path.replace(/^\//, '').split('/')[0];
  const next = { ...room };
  if (data === null) delete next[key];
  else next[key] = data;
  return next;
}

/**
 * Joins a room and returns the handle used to talk to the other player.
 *
 * Callbacks:
 *   onRoom(room)        — the room changed; `room.state` is an encoded game
 *   onGame(game)        — a validated position arrived
 *   onProblem(message)  — the room holds something unusable, or the stream broke
 */
export function connectCloud({ roomCode, onRoom, onGame, onProblem }) {
  const url = roomUrl(roomCode);
  let room = {};
  let lastState = null;
  let closed = false;

  const stream = new EventSource(url);

  function handle(event, isPatch) {
    if (closed) return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return; // keep-alive frames are not JSON
    }
    room = applyEvent(room, payload, isPatch);
    onRoom(room);

    if (typeof room.state === 'string' && room.state !== lastState) {
      lastState = room.state;
      // Never trust the wire: decoding replays the moves through the rules.
      try {
        onGame(decodeGame(room.state));
      } catch (err) {
        onProblem(`The room holds a position this game cannot make sense of: ${err.message}`);
      }
    }
  }

  stream.addEventListener('put', (event) => handle(event, false));
  stream.addEventListener('patch', (event) => handle(event, true));
  stream.addEventListener('error', () => {
    // EventSource reconnects on its own; only say something if it stays broken.
    if (!closed && stream.readyState === EventSource.CLOSED) {
      onProblem('Lost the connection to the game room. Reload to try again.');
    }
  });

  async function patch(body) {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Database rejected the write (HTTP ${response.status}). ${detail}`.trim());
    }
  }

  return {
    /** Publishes a position. `lastState` guards against echoing it back to us. */
    publish: async (game) => {
      const state = encodeGame(game);
      lastState = state;
      await patch({ state, updatedAt: { '.sv': 'timestamp' } });
    },
    setNames: (names) => patch(names),
    close: () => {
      closed = true;
      stream.close();
    },
  };
}
