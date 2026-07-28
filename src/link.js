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
import {
  WORD_LEN,
  applyMove,
  applyRecordedSkip,
  botMove,
  createGame,
  legacyBotMove,
  legalMoves,
  passerOnlyBotMove,
  resign,
  settle,
} from './game.js';
import { WORD_SET } from './words.js';

// Every version is still readable, and each one's skips are replayed with the bot
// rule that was in force when they were recorded:
//
//   1  no passes existed yet
//   2  the bot ignored rack limits                      -> legacyBotMove
//   3  the bot needed a letter the passer still held     -> passerOnlyBotMove
//   4  the pass records the letter it used, so nothing is recomputed
//   5  the bot may use a letter either player holds, and passes score
//
// From version 4 the letter is written down, which is what stops a change to how
// the bot chooses from stranding a game in progress — as versions 3 and 5 both
// were. Versions before 5 also predate passes deciding the game, so they are
// replayed without that rule and meet it once at the end.
const VERSION = 5;
const OLDEST_READABLE_VERSION = 1;

/** Exported so tools cannot drift out of step with the format they rewrite. */
export const LINK_VERSION = VERSION;
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

// Two characters per move: the 1-based slot, then the letter. An UPPERCASE letter
// marks a skip, which keeps the width fixed and the parsing trivial while still
// recording what the bot played. Versions before 4 wrote "0-" for a skip and left
// the letter to be recomputed.
const LEGACY_SKIP_TOKEN = '0-';

function encodeMoves(history) {
  return history
    .map((move) =>
      move.kind === 'skip'
        ? `${move.pos + 1}${move.letter.toUpperCase()}`
        : `${move.pos + 1}${move.letter}`,
    )
    .join('');
}

function decodeMoves(packed) {
  if (typeof packed !== 'string') throw new Error('malformed move list');
  if (packed.length % 2 !== 0) throw new Error('truncated move list');
  const moves = [];
  for (let i = 0; i < packed.length; i += 2) {
    const pair = packed.slice(i, i + 2);
    if (pair === LEGACY_SKIP_TOKEN) {
      // Pre-version-4 skip: the letter has to be recomputed by the caller.
      moves.push({ skip: true });
      continue;
    }
    const pos = Number(pair[0]) - 1;
    const letter = pair[1];
    if (!Number.isInteger(pos) || pos < 0 || pos >= WORD_LEN) {
      throw new Error(`move ${moves.length + 1} names slot ${pair[0]}`);
    }
    if (!/^[a-zA-Z]$/.test(letter)) throw new Error(`move ${moves.length + 1} is not a letter`);
    // Uppercase marks a skip that recorded the letter the bot used.
    const skip = letter !== letter.toLowerCase();
    moves.push({ pos, letter: letter.toLowerCase(), skip });
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
  // Games that only make sense under the pre-version-3 end rule carry a flag, so
  // that re-encoding one does not produce a link that can no longer be replayed.
  if (game.legacyRules) payload.push(true);
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

  const [version, nameA, nameB, startWord, packedMoves, resignedBy, legacyFlag] = payload;
  if (!Number.isInteger(version) || version < OLDEST_READABLE_VERSION || version > VERSION) {
    throw new Error(`This link was made by a different version (${version}).`);
  }

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

  // Whichever bot rule was in force when this game was recorded. Only needed for
  // passes written before version 4, which did not record their letter.
  const resolveSkip = version === 3 ? passerOnlyBotMove : version === 2 ? legacyBotMove : botMove;
  // Versions 1 and 2 also ended the game later: back then a skip could rescue a
  // player with no move, so replaying under today's rule would declare the game
  // over partway through one that really did carry on. The old rule is used for
  // the replay, and the current one applied once at the end.
  // Passes only started deciding games in version 5, so everything older is
  // replayed under the end rules of its own time.
  const legacyRules = version < VERSION || legacyFlag === true;
  const options = legacyRules ? { legacyOutcome: true } : {};

  // Set only if the old end rule actually kept a game alive that today's rule
  // would have finished. Most older games never depended on it, and those come
  // back indistinguishable from one played today.
  let usedLegacyRescue = false;

  // Replaying through the real rules is the validation: an illegal sequence
  // cannot be smuggled in by editing the link.
  for (const [index, move] of decodeMoves(packedMoves).entries()) {
    try {
      if (!move.skip) {
        game = applyMove(game, move.pos, move.letter, options);
      } else if (move.letter) {
        game = applyRecordedSkip(game, move.pos, move.letter, options);
      } else {
        const chosen = resolveSkip(game);
        if (!chosen) throw new Error('there is no word left for the bot to play');
        game = applyRecordedSkip(game, chosen.pos, chosen.letter, options);
      }
    } catch (err) {
      throw new Error(`Move ${index + 1} in this link is not legal: ${err.message}`);
    }
    if (legacyRules && !game.outcome && legalMoves(game).length === 0) {
      usedLegacyRescue = true;
    }
  }

  if (resignedBy === 0 || resignedBy === 1) game = resign(game, resignedBy);
  if (!legacyRules) return game;

  // An older game replayed under its own end rule still has to face the current
  // one before play resumes.
  const settled = settle(game);
  // Carry the flag only when it is load-bearing, so re-encoding cannot turn the
  // game into a link that no longer replays.
  if (usedLegacyRescue) settled.legacyRules = true;
  return settled;
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
