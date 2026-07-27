// Live games over WebRTC. Peers find each other through Trystero, which uses
// public WebTorrent trackers purely for signalling — there is no server of ours
// in the loop, and no account to create. Once connected, moves go peer to peer.
//
// The wire format is the same encoded string the share links use, so a move is
// ~2 characters and every received position is validated by replaying it
// through the rules before it is shown.
import { joinRoom, selfId } from '../vendor/trystero/torrent.js';
import { decodeGame, encodeGame } from './link.js';

export { selfId };

// Namespaces the signalling so codes cannot collide with another app's rooms.
const APP_ID = 'nascarsayan-char-replace-game';

// No 0/O/1/I/L: these get read aloud and typed by hand.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export function createRoomCode() {
  const values = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => CODE_ALPHABET[v % CODE_ALPHABET.length]).join('');
}

export function normaliseRoomCode(code) {
  return (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

export function isRoomCode(code) {
  return normaliseRoomCode(code).length === CODE_LENGTH;
}

/**
 * Joins a room and returns the handle used to talk to the other player.
 *
 * Callbacks:
 *   onPeers(count)      — connected peers changed
 *   onState(game)       — a validated position arrived
 *   onHello(name)       — the other player announced their name
 *   onProblem(message)  — a peer sent something unusable
 */
export function connect({ roomCode, onPeers, onState, onHello, onProblem }) {
  const room = joinRoom({ appId: APP_ID }, normaliseRoomCode(roomCode));
  const [sendStateRaw, getState] = room.makeAction('state');
  const [sendHelloRaw, getHello] = room.makeAction('hello');
  const peers = new Set();

  const announce = () => onPeers(peers.size);

  room.onPeerJoin((id) => {
    peers.add(id);
    announce();
  });
  room.onPeerLeave((id) => {
    peers.delete(id);
    announce();
  });

  getState((encoded) => {
    // Never trust the wire: decodeGame replays the moves through the rules, so a
    // corrupt or malicious position is rejected instead of rendered.
    try {
      onState(decodeGame(encoded));
    } catch (err) {
      onProblem(`Your opponent sent a position this game cannot make sense of: ${err.message}`);
    }
  });

  getHello((name) => {
    if (typeof name === 'string' && name.trim()) onHello(name.trim().slice(0, 24));
  });

  return {
    sendState: (game) => sendStateRaw(encodeGame(game)),
    sendHello: (name) => sendHelloRaw(name),
    leave: () => room.leave(),
  };
}
