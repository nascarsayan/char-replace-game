// Rules smoke test for src/game.js. No test framework, no npm:
//   node tools/test-game.mjs
import assert from 'node:assert/strict';
import {
  CARDS_PER_PLAYER,
  applyMove,
  cardsLeft,
  createGame,
  hasWildcard,
  inspectMove,
  legalMoves,
  randomStartWord,
  resign,
} from '../src/game.js';
import { WORDS, WORD_SET, isWord } from '../src/words.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

test('dictionary is non-trivial and uniform', () => {
  assert.ok(WORDS.length > 5000, `only ${WORDS.length} words`);
  assert.ok(WORDS.every((w) => /^[a-z]{4}$/.test(w)));
  assert.equal(new Set(WORDS).size, WORDS.length, 'duplicates in word list');
  assert.ok(isWord('WORD') && isWord('word'));
  assert.ok(!isWord('zzzz'));
});

test('a fresh game starts with full decks and a playable word', () => {
  const g = createGame('A', 'B', 'cold');
  assert.equal(g.word, 'cold');
  assert.equal(g.turn, 0);
  assert.equal(g.outcome, null);
  assert.equal(cardsLeft(g.players[0]), CARDS_PER_PLAYER);
  assert.equal(cardsLeft(g.players[1]), CARDS_PER_PLAYER);
  assert.equal(CARDS_PER_PLAYER, 27);
  assert.ok(legalMoves(g).length > 0);
});

test('randomStartWord never opens on a dead word', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 50; i++) {
    const w = randomStartWord(rand);
    assert.ok(WORD_SET.has(w), `${w} not a word`);
    assert.ok(legalMoves(createGame('A', 'B', w)).length > 0, `${w} opens dead`);
  }
});

test('a legal move spends the letter card and passes the turn', () => {
  const g = applyMove(createGame('A', 'B', 'cold'), 0, 'b'); // cold -> bold
  assert.equal(g.word, 'bold');
  assert.equal(g.turn, 1);
  assert.deepEqual(g.players[0].spent, ['b']);
  assert.deepEqual(g.players[1].spent, []);
  assert.equal(cardsLeft(g.players[0]), CARDS_PER_PLAYER - 1);
  assert.deepEqual(g.history, [
    { by: 0, from: 'cold', to: 'bold', pos: 0, letter: 'b', kind: 'normal' },
  ]);
});

test('applyMove does not mutate the state it was given', () => {
  const before = createGame('A', 'B', 'cold');
  const snapshot = JSON.stringify(before);
  applyMove(before, 0, 'b');
  assert.equal(JSON.stringify(before), snapshot);
});

test('non-words, no-ops and out-of-range slots are rejected', () => {
  const g = createGame('A', 'B', 'cold');
  assert.match(inspectMove(g, 0, 'q').reason, /not in the dictionary/);
  assert.match(inspectMove(g, 0, 'c').reason, /already/);
  assert.match(inspectMove(g, 9, 'b').reason, /slots/);
  assert.match(inspectMove(g, -1, 'b').reason, /slots/);
  assert.match(inspectMove(g, 0, '1').reason, /Not a letter/);
  assert.throws(() => applyMove(g, 0, 'q'), /not in the dictionary/);
});

test('a word cannot be replayed in the same game', () => {
  const g = applyMove(createGame('A', 'B', 'cold'), 0, 'b'); // cold -> bold
  const back = inspectMove(g, 0, 'c'); // bold -> cold, but cold is on the board already
  assert.equal(back.ok, false);
  assert.match(back.reason, /already been played/);
  assert.throws(() => applyMove(g, 0, 'c'), /already been played/);
});

test('replaying a spent letter costs the wildcard, and only once', () => {
  const h = createGame('A', 'B', 'cold');
  h.players[0].spent = ['b'];
  const replay = inspectMove(h, 0, 'b'); // cold -> bold, 'b' already spent
  assert.equal(replay.ok, true);
  assert.equal(replay.kind, 'wildcard');

  const after = applyMove(h, 0, 'b');
  assert.equal(after.players[0].wildcardsUsed, 1);
  assert.deepEqual(after.players[0].spent, ['b'], 'wildcard must not double-spend the letter');
  assert.equal(hasWildcard(after.players[0]), false);
  assert.equal(cardsLeft(after.players[0]), CARDS_PER_PLAYER - 2);

  // Second replay attempt is dead.
  const spentOut = createGame('A', 'B', 'cold');
  spentOut.players[0].spent = ['b'];
  spentOut.players[0].wildcardsUsed = 1;
  const denied = inspectMove(spentOut, 0, 'b');
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /wildcard is gone/);
});

test('the wildcard still requires a real word', () => {
  const g = createGame('A', 'B', 'cold');
  g.players[0].spent = ['q'];
  const verdict = inspectMove(g, 0, 'q'); // qold is not a word
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not in the dictionary/);
});

test('a player with an empty deck has no moves', () => {
  const g = createGame('A', 'B', 'cold');
  g.players[0].spent = 'abcdefghijklmnopqrstuvwxyz'.split('');
  g.players[0].wildcardsUsed = 1;
  assert.equal(legalMoves(g).length, 0);
});

test('the move that strands the opponent ends the game on their turn', () => {
  const g = createGame('A', 'B', 'cold');
  // B has nothing left, so the turn handover after A's move must settle the game.
  g.players[1].spent = 'abcdefghijklmnopqrstuvwxyz'.split('');
  g.players[1].wildcardsUsed = 1;
  const after = applyMove(g, 0, 'b'); // A: cold -> bold
  assert.deepEqual(after.outcome, { loser: 1, winner: 0, reason: 'stuck' });
  assert.equal(after.turn, 1, 'the stuck player is the one on turn');
});

test('resigning hands the win to the other player', () => {
  const g = resign(createGame('A', 'B', 'cold'), 0);
  assert.deepEqual(g.outcome, { loser: 0, winner: 1, reason: 'resigned' });
  assert.equal(legalMoves(g).length, 0, 'a finished game offers no moves');
  assert.match(inspectMove(g, 0, 'b').reason, /already over/);
});

test('a full random game terminates with exactly one loser', () => {
  let seed = 99;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let game = 0; game < 25; game++) {
    let g = createGame('A', 'B', randomStartWord(rand));
    let turns = 0;
    while (!g.outcome) {
      const moves = legalMoves(g);
      const pick = moves[Math.floor(rand() * moves.length)];
      g = applyMove(g, pick.pos, pick.letter);
      turns += 1;
      assert.ok(turns < 200, 'game failed to terminate');
    }
    assert.ok(g.outcome.winner !== g.outcome.loser);
    assert.equal(g.outcome.reason, 'stuck');
    assert.equal(g.outcome.loser, g.turn, 'the stuck player is the one on turn');
    assert.equal(new Set(g.usedWords).size, g.usedWords.length, 'a word repeated');
    for (const p of g.players) {
      assert.ok(p.spent.length <= 26 && p.wildcardsUsed <= 1);
      assert.equal(new Set(p.spent).size, p.spent.length, 'a letter card was spent twice');
    }
    // Every recorded move must have been a real dictionary step.
    for (const m of g.history) {
      assert.ok(WORD_SET.has(m.to));
      assert.equal(m.to, m.from.slice(0, m.pos) + m.letter + m.from.slice(m.pos + 1));
    }
  }
});

test('state survives a localStorage round-trip', () => {
  let g = createGame('A', 'B', 'cold');
  g = applyMove(g, 0, 'b');
  const revived = JSON.parse(JSON.stringify(g));
  assert.deepEqual(revived, g);
  assert.equal(legalMoves(revived).length, legalMoves(g).length);
});

console.log(`\n${passed} test groups passed`);
