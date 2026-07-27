// Pure game rules. Every state value is JSON-serialisable so it can round-trip
// through localStorage without custom revivers (hence arrays instead of Sets).
import { WORD_SET, WORDS } from './words.js';

export const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
export const WORD_LEN = 4;
export const WILDCARDS_PER_PLAYER = 1;

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
  return { name, spent: [], wildcardsUsed: 0 };
}

export function cardsLeft(player) {
  return LETTERS.length - player.spent.length + (WILDCARDS_PER_PLAYER - player.wildcardsUsed);
}

export function hasWildcard(player) {
  return player.wildcardsUsed < WILDCARDS_PER_PLAYER;
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

/** The player on turn loses the moment they have no legal move left. */
function settleOutcome(state) {
  if (state.outcome) return state;
  if (legalMoves(state).length === 0) {
    state.outcome = { loser: state.turn, winner: 1 - state.turn, reason: 'stuck' };
  }
  return state;
}
