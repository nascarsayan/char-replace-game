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

const base = () => DATABASE_URL.replace(/\/+$/, '');
const roomUrl = (roomCode) => `${base()}/rooms/${roomCode}.json`;

/**
 * Firebase keys cannot contain . $ # [ ] / or control characters, so a name is
 * percent-encoded to make one. Lowercasing is what makes names unique
 * case-insensitively: "Sayan" and "sayan" resolve to the same key.
 */
export const userKey = (name) =>
  // encodeURIComponent leaves "." alone, and Firebase rejects it in a key.
  encodeURIComponent(String(name).trim().toLowerCase()).replace(/\./g, '%2E');

async function send(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Database said HTTP ${response.status}. ${detail}`.trim());
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/** Every saved identity, newest activity first. */
export async function fetchUsers() {
  const users = (await send('GET', `${base()}/users.json`)) || {};
  return Object.entries(users)
    .filter(([, value]) => value && typeof value.name === 'string')
    .map(([key, value]) => ({
      key,
      name: value.name,
      lastSeen: value.lastSeen || 0,
      rooms: value.rooms ? Object.keys(value.rooms) : [],
    }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

/** Creates an identity, refusing a name that is taken. */
export async function createUser(name) {
  const key = userKey(name);
  const existing = await send('GET', `${base()}/users/${key}/name.json`);
  if (existing) throw new Error(`"${existing}" is already taken.`);
  await send('PUT', `${base()}/users/${key}.json`, {
    name: String(name).trim(),
    lastSeen: { '.sv': 'timestamp' },
  });
}

export async function deleteUser(name) {
  await send('DELETE', `${base()}/users/${userKey(name)}.json`);
}

export async function touchUser(name) {
  await send('PATCH', `${base()}/users/${userKey(name)}.json`, {
    lastSeen: { '.sv': 'timestamp' },
  });
}

/** Notes that this identity is in this room, so it can be found again later. */
export async function rememberRoom(name, roomCode) {
  await send('PATCH', `${base()}/users/${userKey(name)}/rooms.json`, { [roomCode]: true });
}

export async function forgetRoom(name, roomCode) {
  await send('DELETE', `${base()}/users/${userKey(name)}/rooms/${roomCode}.json`);
}

/**
 * The games an identity is in, described enough to choose between them. Rooms
 * that have since vanished are dropped from the index rather than listed.
 */
export async function fetchUserGames(name) {
  const codes = Object.keys((await send('GET', `${base()}/users/${userKey(name)}/rooms.json`)) || {});
  const summaries = await Promise.all(
    codes.map(async (code) => {
      const room = await send('GET', roomUrl(code)).catch(() => null);
      if (!room || typeof room.state !== 'string') {
        await forgetRoom(name, code).catch(() => {});
        return null;
      }
      try {
        const game = decodeGame(room.state);
        const you = game.players.findIndex((player) => player.name === name);
        return {
          code,
          word: game.word,
          plies: game.history.length,
          updatedAt: room.updatedAt || 0,
          opponent: game.players[you === 0 ? 1 : 0].name,
          yourTurn: you !== -1 && game.turn === you,
          onTurn: game.players[game.turn].name,
          outcome: game.outcome,
          winner: game.outcome ? game.players[game.outcome.winner].name : null,
        };
      } catch (err) {
        return { code, unreadable: err.message, updatedAt: room.updatedAt || 0 };
      }
    }),
  );
  return summaries.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

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
