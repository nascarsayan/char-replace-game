// Shareable-game links. There is no server, so the URL fragment *is* the
// transport: you move, send the link, your opponent opens it and plays their
// turn, and so on.
//
// Only the names, the opening word and the move list are encoded. Everything
// else — spent cards, wildcard usage, whose turn it is, whether the game is
// over — falls out of replaying those moves through the rules, so there is no
// second source of truth to drift. Decoding replays through applyMove(), which
// means a truncated or hand-edited link is rejected instead of loading a
// board that could not have arisen from legal play.
import { WORD_LEN, applyMove, applySkip, createGame, resign } from './game.js';
import { WORD_SET } from './words.js';

const VERSION = 2;
export const FRAGMENT_KEY = 'g';

function toBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded) {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Two characters per move: the 1-based slot then the letter, or "0-" for a
// skip. Fixed width keeps parsing trivial, and a skip needs no letter recorded
// because the bot's choice is recomputed deterministically on the way back in.
const SKIP_TOKEN = '0-';

/** Moves are two characters each: the 1-based slot, then the letter. */
function encodeMoves(history) {
  return history
    .map((move) => (move.kind === 'skip' ? SKIP_TOKEN : `${move.pos + 1}${move.letter}`))
    .join('');
}

function decodeMoves(packed) {
  if (typeof packed !== 'string') throw new Error('malformed move list');
  if (packed.length % 2 !== 0) throw new Error('truncated move list');
  const moves = [];
  for (let i = 0; i < packed.length; i += 2) {
    const pair = packed.slice(i, i + 2);
    if (pair === SKIP_TOKEN) {
      moves.push({ skip: true });
      continue;
    }
    const pos = Number(pair[0]) - 1;
    const letter = pair[1];
    if (!Number.isInteger(pos) || pos < 0 || pos >= WORD_LEN) {
      throw new Error(`move ${moves.length + 1} names slot ${pair[0]}`);
    }
    if (!/^[a-z]$/.test(letter)) throw new Error(`move ${moves.length + 1} is not a letter`);
    moves.push({ pos, letter });
  }
  return moves;
}

export function encodeGame(game) {
  const payload = [
    VERSION,
    game.players[0].name,
    game.players[1].name,
    game.startWord,
    encodeMoves(game.history),
    game.outcome && game.outcome.reason === 'resigned' ? game.outcome.loser : null,
  ];
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Rebuilds a game from an encoded link. Throws with a human-readable reason if
 * the payload is not a legal game, so callers can show the reason rather than
 * silently loading a broken board.
 */
export function decodeGame(encoded) {
  let payload;
  try {
    payload = JSON.parse(fromBase64Url(encoded));
  } catch {
    throw new Error('This link is damaged — it may have been cut short when it was shared.');
  }
  if (!Array.isArray(payload) || payload.length < 5) throw new Error('This link is not a game.');

  const [version, nameA, nameB, startWord, packedMoves, resignedBy] = payload;
  if (version !== VERSION) throw new Error(`This link was made by a different version (${version}).`);
  if (typeof nameA !== 'string' || typeof nameB !== 'string' || !nameA || !nameB) {
    throw new Error('This link is missing a player name.');
  }
  if (typeof startWord !== 'string' || !/^[a-z]{4}$/.test(startWord)) {
    throw new Error('This link has no valid opening word.');
  }
  // createGame does not check the opening word, and an unknown one would settle
  // as an instantly-lost game rather than an error. Reject it here instead.
  if (!WORD_SET.has(startWord)) {
    throw new Error(`"${startWord.toUpperCase()}" is not a word in this dictionary.`);
  }

  let game = createGame(nameA, nameB, startWord);

  // Replaying through the real rules is the validation: an illegal sequence
  // cannot be smuggled in by editing the link.
  for (const [index, move] of decodeMoves(packedMoves).entries()) {
    try {
      game = move.skip ? applySkip(game) : applyMove(game, move.pos, move.letter);
    } catch (err) {
      throw new Error(`Move ${index + 1} in this link is not legal: ${err.message}`);
    }
  }

  if (resignedBy === 0 || resignedBy === 1) game = resign(game, resignedBy);
  return game;
}

/** The absolute URL to send to the other player. */
export function buildShareUrl(game, location = window.location) {
  const base = `${location.origin}${location.pathname}${location.search}`;
  return `${base}#${FRAGMENT_KEY}=${encodeGame(game)}`;
}

/**
 * Reads a game out of the current fragment.
 * Returns `{ game }`, `{ error }`, or null when there is no shared game.
 */
export function readGameFromLocation(location = window.location) {
  const match = /(?:^|[#&])g=([A-Za-z0-9\-_]+)/.exec(location.hash || '');
  if (!match) return null;
  try {
    return { game: decodeGame(match[1]) };
  } catch (err) {
    return { error: err.message };
  }
}

/** Keeps the address bar in step with the position, so a reload is safe. */
export function writeGameToLocation(game, history = window.history) {
  history.replaceState(null, '', `#${FRAGMENT_KEY}=${encodeGame(game)}`);
}
