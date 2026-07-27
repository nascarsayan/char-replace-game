// Pure game rules. Every state value is JSON-serialisable so it can round-trip
// through localStorage without custom revivers (hence arrays instead of Sets).
import { WORD_SET, WORDS } from './words.js';

export const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
export const WORD_LEN = 4;
export const WILDCARDS_PER_PLAYER = 1;
export const SKIPS_PER_PLAYER = 5;

// A player's deck is 26 letter cards plus one wildcard: 27 cards in total.
export const CARDS_PER_PLAYER = LETTERS.length + WILDCARDS_PER_PLAYER;

function replaceAt(word, pos, letter) {
  return word.slice(0, pos) + letter + word.slice(pos + 1);
}

// State is plain JSON by construction, so this is enough — and unlike
// structuredClone it needs no modern-runtime check.
const clone = (state) => JSON.parse(JSON.stringify(state));

/** Words reachable from `word` by substituting exactly one letter. */
function neighbours(word) {
  const out = [];
  for (let pos = 0; pos < WORD_LEN; pos++) {
    for (const letter of LETTERS) {
      if (letter === word[pos]) continue;
      const next = replaceAt(word, pos, letter);
      if (WORD_SET.has(next)) out.push({ pos, letter, word: next });
    }
  }
  return out;
}

/**
 * Picks an opening word that has at least one legal continuation, so a game
 * never starts already lost. `rand` is injectable to keep this testable.
 */
export function randomStartWord(rand = Math.random) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const word = WORDS[Math.floor(rand() * WORDS.length)];
    if (neighbours(word).length > 0) return word;
  }
  return 'word';
}

export function createGame(nameA, nameB, startWord = randomStartWord()) {
  const state = {
    version: 1,
    startWord,
    word: startWord,
    turn: 0,
    players: [makePlayer(nameA), makePlayer(nameB)],
    usedWords: [startWord],
    history: [],
    outcome: null,
  };
  return settleOutcome(state);
}

function makePlayer(name) {
  return { name, spent: [], wildcardsUsed: 0, skipsUsed: 0 };
}

export function cardsLeft(player) {
  return LETTERS.length - player.spent.length + (WILDCARDS_PER_PLAYER - player.wildcardsUsed);
}

export function hasWildcard(player) {
  return player.wildcardsUsed < WILDCARDS_PER_PLAYER;
}

export function skipsLeft(player) {
  return SKIPS_PER_PLAYER - (player.skipsUsed || 0);
}

/** The moves that need no wildcard: a letter the player still holds. */
export function normalMoves(state) {
  return legalMoves(state).filter((move) => move.kind === 'normal');
}

/**
 * The move the bot plays when someone gives up their turn.
 *
 * It may only play a card the player on turn could have played themselves — a
 * letter they have not spent. The bot is never allowed to spend a wildcard, so
 * this is exactly the set of normal moves, and the first one in slot-then-letter
 * order is taken. Determinism matters: share links and live peers replay a skip
 * rather than transmitting what the bot chose, so both sides must agree.
 */
export function botMove(state) {
  if (state.outcome) return null;
  return normalMoves(state)[0] || null;
}

/**
 * Skipping needs a plain letter for the bot to play, so it is unavailable
 * precisely when the player has no move that avoids their wildcard. Being out of
 * ordinary moves is therefore what the wildcard is for, not what a skip is for.
 */
export function canSkip(state) {
  if (state.outcome) return false;
  return skipsLeft(state.players[state.turn]) > 0 && botMove(state) !== null;
}

/** True when every remaining move would have to replay a spent letter. */
export function needsWildcard(state) {
  if (state.outcome) return false;
  const moves = legalMoves(state);
  return moves.length > 0 && moves.every((move) => move.kind === 'wildcard');
}

/**
 * A playable move, for the hint button. Moves that cost no wildcard come first,
 * so a hint never quietly pushes the player into spending one. `index` walks
 * through the alternatives and wraps, so asking again shows something new.
 */
export function hint(state, index = 0) {
  const moves = legalMoves(state);
  if (moves.length === 0) return null;
  const ordered = [
    ...moves.filter((move) => move.kind === 'normal'),
    ...moves.filter((move) => move.kind === 'wildcard'),
  ];
  return ordered[index % ordered.length];
}

/**
 * Gives up the turn. The bot plays a letter the giver still held, and that letter
 * is struck from *both* racks — from the giver always, and from the opponent only
 * if they still held it too. Nobody's wildcard is touched: a letter the opponent
 * had already spent simply stays spent.
 */
export function applySkip(state) {
  if (state.outcome) throw new Error('The game is already over.');
  const player = state.players[state.turn];
  if (skipsLeft(player) <= 0) throw new Error(`${player.name} has no skips left.`);
  const move = botMove(state);
  if (!move) {
    throw new Error(
      `${player.name} has no plain letter left for the bot to play — that needs the wildcard.`,
    );
  }

  const next = clone(state);
  next.players[next.turn].skipsUsed += 1;
  // Struck off whoever still had it; already-spent stays spent, costing nothing.
  for (const seat of next.players) {
    if (!seat.spent.includes(move.letter)) {
      seat.spent = [...seat.spent, move.letter].sort();
    }
  }
  next.history.push({
    by: next.turn,
    from: state.word,
    to: move.word,
    pos: move.pos,
    letter: move.letter,
    kind: 'skip',
  });
  next.word = move.word;
  next.usedWords.push(move.word);
  next.turn = 1 - next.turn;
  return settleOutcome(next);
}

/**
 * Classifies a candidate move without mutating anything.
 * Returns `{ ok: true, kind, word }` or `{ ok: false, reason }`.
 */
export function inspectMove(state, pos, letter) {
  if (state.outcome) return { ok: false, reason: 'The game is already over.' };
  if (!Number.isInteger(pos) || pos < 0 || pos >= WORD_LEN) {
    return { ok: false, reason: 'Pick one of the four slots first.' };
  }
  if (!LETTERS.includes(letter)) return { ok: false, reason: 'Not a letter.' };
  if (state.word[pos] === letter) {
    return { ok: false, reason: `Slot ${pos + 1} is already "${letter.toUpperCase()}".` };
  }

  const next = replaceAt(state.word, pos, letter);
  if (!WORD_SET.has(next)) {
    return { ok: false, reason: `"${next.toUpperCase()}" is not in the dictionary.` };
  }
  if (state.usedWords.includes(next)) {
    return { ok: false, reason: `"${next.toUpperCase()}" has already been played.` };
  }

  const player = state.players[state.turn];
  const isSpent = player.spent.includes(letter);
  if (!isSpent) return { ok: true, kind: 'normal', word: next };
  if (hasWildcard(player)) return { ok: true, kind: 'wildcard', word: next };
  return {
    ok: false,
    reason: `You already spent "${letter.toUpperCase()}" and your wildcard is gone.`,
  };
}

/** Every move the player on turn could legally make right now. */
export function legalMoves(state) {
  if (state.outcome) return [];
  const moves = [];
  for (let pos = 0; pos < WORD_LEN; pos++) {
    for (const letter of LETTERS) {
      const verdict = inspectMove(state, pos, letter);
      if (verdict.ok) moves.push({ pos, letter, word: verdict.word, kind: verdict.kind });
    }
  }
  return moves;
}

/**
 * Applies a move and hands the turn over. Returns a fresh state; the input is
 * left untouched so callers can keep the previous state for undo/history.
 */
export function applyMove(state, pos, letter) {
  const verdict = inspectMove(state, pos, letter);
  if (!verdict.ok) throw new Error(verdict.reason);

  const next = clone(state);
  const player = next.players[next.turn];
  if (verdict.kind === 'wildcard') player.wildcardsUsed += 1;
  else player.spent = [...player.spent, letter].sort();

  next.history.push({
    by: next.turn,
    from: state.word,
    to: verdict.word,
    pos,
    letter,
    kind: verdict.kind,
  });
  next.word = verdict.word;
  next.usedWords.push(verdict.word);
  next.turn = 1 - next.turn;
  return settleOutcome(next);
}

/** Marks the game lost for `playerIdx` (used by the resign button). */
export function resign(state, playerIdx) {
  const next = clone(state);
  next.outcome = { loser: playerIdx, winner: 1 - playerIdx, reason: 'resigned' };
  return next;
}

/**
 * The player on turn loses the moment they have no legal move at all. A skip
 * cannot save them: the bot only plays letters they still hold, so if they have
 * nothing playable there is nothing for it to play either.
 */
function settleOutcome(state) {
  if (state.outcome) return state;
  if (legalMoves(state).length === 0) {
    state.outcome = { loser: state.turn, winner: 1 - state.turn, reason: 'stuck' };
  }
  return state;
}
