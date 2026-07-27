// Rules smoke test for src/game.js. No test framework, no npm:
//   node tools/test-game.mjs
import assert from 'node:assert/strict';
import {
  CARDS_PER_PLAYER,
  SKIPS_PER_PLAYER,
  applyMove,
  applySkip,
  botMove,
  canSkip,
  cardsLeft,
  createGame,
  hasWildcard,
  inspectMove,
  hint,
  legalMoves,
  needsWildcard,
  normalMoves,
  randomStartWord,
  resign,
  skipsLeft,
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
  assert.equal(g.players[0].skipsUsed, 0);
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

test('a stranded opponent must use their wildcard, and cannot skip instead', () => {
  const g = createGame('A', 'B', 'cold');
  g.players[1].spent = 'abcdefghijklmnopqrstuvwxyz'.split(''); // wildcard still held
  const after = applyMove(g, 0, 'b'); // A: cold -> bold
  assert.equal(after.outcome, null, 'the wildcard is still a way out');
  assert.equal(normalMoves(after).length, 0);
  assert.ok(legalMoves(after).length > 0);
  assert.equal(needsWildcard(after), true);
  // A skip would need the bot to play a letter B still holds, and there is none.
  assert.equal(canSkip(after), false);
  assert.throws(() => applySkip(after), /no plain letter/);
});

test('the move that strands an opponent with no wildcard ends the game', () => {
  const g = createGame('A', 'B', 'cold');
  g.players[1].spent = 'abcdefghijklmnopqrstuvwxyz'.split('');
  g.players[1].wildcardsUsed = 1;
  const after = applyMove(g, 0, 'b'); // A: cold -> bold
  assert.deepEqual(after.outcome, { loser: 1, winner: 0, reason: 'stuck' });
  assert.equal(after.turn, 1, 'the stuck player is the one on turn');
  assert.equal(needsWildcard(after), false, 'a finished game needs nothing');
});

test('the bot only plays a letter the giver still holds', () => {
  const g = createGame('A', 'B', 'cold');
  assert.deepEqual(botMove(g), { pos: 0, letter: 'b', word: 'bold', kind: 'normal' });

  // Spend 'b': the bot must move on rather than replay it with a wildcard.
  g.players[0].spent = ['b'];
  const move = botMove(g);
  assert.notEqual(move.letter, 'b');
  assert.equal(move.kind, 'normal');
  assert.ok(!g.players[0].spent.includes(move.letter));
});

test("a skip never spends anybody's wildcard", () => {
  const g = createGame('A', 'B', 'cold');
  // B has already spent every letter the bot might choose, but holds a wildcard.
  g.players[1].spent = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const after = applySkip(g);
  assert.equal(after.players[0].wildcardsUsed, 0);
  assert.equal(after.players[1].wildcardsUsed, 0, 'the opponent keeps their wildcard');
  // The giver always loses the letter; the opponent had already spent it.
  const letter = after.history[0].letter;
  assert.ok(after.players[0].spent.includes(letter));
  assert.equal(after.players[1].spent.length, 26, 'nothing new was taken from them');
});

test('a skip strikes the letter off the opponent only when they still held it', () => {
  const g = createGame('A', 'B', 'cold');
  const letter = botMove(g).letter;
  const both = applySkip(g);
  assert.ok(both.players[0].spent.includes(letter));
  assert.ok(both.players[1].spent.includes(letter), 'playable for them too, so struck off');

  const already = createGame('A', 'B', 'cold');
  already.players[1].spent = [letter];
  const after = applySkip(already);
  assert.deepEqual(after.players[1].spent, [letter], 'no double-count');
  assert.equal(after.players[1].wildcardsUsed, 0);
});

test('needsWildcard is only true when nothing ordinary is left', () => {
  const fresh = createGame('A', 'B', 'cold');
  assert.equal(needsWildcard(fresh), false);

  const cornered = createGame('A', 'B', 'cold');
  cornered.players[0].spent = 'abcdefghijklmnopqrstuvwxyz'.split('');
  assert.equal(needsWildcard(cornered), true);

  const done = createGame('A', 'B', 'cold');
  done.players[0].spent = 'abcdefghijklmnopqrstuvwxyz'.split('');
  done.players[0].wildcardsUsed = 1;
  assert.equal(legalMoves(done).length, 0);
  assert.equal(needsWildcard(done), false, 'no moves at all is a loss, not a wildcard case');
});

test('hints are playable, prefer plain letters, and cycle', () => {
  const g = createGame('A', 'B', 'cold');
  const first = hint(g);
  assert.equal(first.kind, 'normal');
  assert.equal(inspectMove(g, first.pos, first.letter).ok, true);

  const seen = new Set();
  for (let i = 0; i < 4; i++) seen.add(`${hint(g, i).pos}${hint(g, i).letter}`);
  assert.equal(seen.size, 4, 'asking again should offer something new');
  assert.deepEqual(hint(g, 0), hint(g, legalMoves(g).length), 'the walk wraps');

  // With only wildcard moves left, the hint says so rather than giving up.
  const cornered = createGame('A', 'B', 'cold');
  cornered.players[0].spent = 'abcdefghijklmnopqrstuvwxyz'.split('');
  assert.equal(hint(cornered).kind, 'wildcard');

  const done = createGame('A', 'B', 'cold');
  done.players[0].spent = 'abcdefghijklmnopqrstuvwxyz'.split('');
  done.players[0].wildcardsUsed = 1;
  assert.equal(hint(done), null);
});

test('a fresh game gives both players their skips', () => {
  const g = createGame('A', 'B', 'cold');
  assert.equal(skipsLeft(g.players[0]), SKIPS_PER_PLAYER);
  assert.equal(skipsLeft(g.players[1]), SKIPS_PER_PLAYER);
  assert.equal(SKIPS_PER_PLAYER, 5);
  assert.equal(canSkip(g), true);
});

test('the bot move is deterministic and never repeats a played word', () => {
  const g = createGame('A', 'B', 'cold');
  assert.deepEqual(botMove(g), { pos: 0, letter: 'b', word: 'bold', kind: 'normal' });
  assert.deepEqual(botMove(g), botMove(g), 'must not vary between calls');

  const seen = createGame('A', 'B', 'cold');
  seen.usedWords = ['cold', 'bold'];
  const next = botMove(seen);
  assert.notEqual(next.word, 'bold');
  assert.ok(!seen.usedWords.includes(next.word));
});

test('giving up the turn costs both players the letter', () => {
  const g = createGame('A', 'B', 'cold');
  const after = applySkip(g);

  assert.equal(after.word, 'bold');
  assert.equal(after.turn, 1, 'the turn passes');
  assert.equal(after.players[0].skipsUsed, 1);
  assert.equal(after.players[1].skipsUsed, 0, 'only the giver spends a skip');
  // The whole point: the letter is struck off both racks.
  assert.deepEqual(after.players[0].spent, ['b']);
  assert.deepEqual(after.players[1].spent, ['b']);
  assert.equal(cardsLeft(after.players[0]), CARDS_PER_PLAYER - 1);
  assert.equal(cardsLeft(after.players[1]), CARDS_PER_PLAYER - 1);
  assert.deepEqual(after.history, [
    { by: 0, from: 'cold', to: 'bold', pos: 0, letter: 'b', kind: 'skip' },
  ]);
  assert.equal(skipsLeft(after.players[0]), SKIPS_PER_PLAYER - 1);
});

test('the giver always spends a fresh card, never one already gone', () => {
  const g = createGame('A', 'B', 'cold');
  g.players[0].spent = ['b'];
  const move = botMove(g);
  assert.notEqual(move.letter, 'b', 'the bot must not pick a letter the giver spent');

  const after = applySkip(g);
  assert.deepEqual(after.players[0].spent, ['b', move.letter].sort());
  assert.equal(after.players[0].wildcardsUsed, 0, 'and never through the wildcard');
});

test('applySkip does not mutate the state it was given', () => {
  const before = createGame('A', 'B', 'cold');
  const snapshot = JSON.stringify(before);
  applySkip(before);
  assert.equal(JSON.stringify(before), snapshot);
});

test('skips run out after five, and then cannot be used', () => {
  let g = createGame('A', 'B', 'cold');
  g.players[0].skipsUsed = SKIPS_PER_PLAYER;
  assert.equal(skipsLeft(g.players[0]), 0);
  assert.equal(canSkip(g), false);
  assert.throws(() => applySkip(g), /no skips left/);
});

test('a skip is impossible when the bot has nowhere to go', () => {
  const g = createGame('A', 'B', 'cold');
  // Mark every neighbour of "cold" as already played.
  const neighbours = [];
  for (let pos = 0; pos < 4; pos++) {
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
      if (letter === 'cold'[pos]) continue;
      const candidate = 'cold'.slice(0, pos) + letter + 'cold'.slice(pos + 1);
      neighbours.push(candidate);
    }
  }
  g.usedWords = ['cold', ...neighbours];
  assert.equal(botMove(g), null);
  assert.equal(canSkip(g), false);
  assert.throws(() => applySkip(g), /no plain letter/);
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
      // A live game always has a move: running out of them *is* the loss.
      assert.ok(moves.length > 0, 'an unfinished game must offer a move');
      if (turns % 9 === 0 && canSkip(g)) {
        g = applySkip(g);
      } else {
        const pick = moves[Math.floor(rand() * moves.length)];
        g = applyMove(g, pick.pos, pick.letter);
      }
      turns += 1;
      assert.ok(turns < 400, 'game failed to terminate');
    }
    assert.ok(g.outcome.winner !== g.outcome.loser);
    assert.equal(g.outcome.reason, 'stuck');
    assert.equal(g.outcome.loser, g.turn, 'the stuck player is the one on turn');
    assert.equal(new Set(g.usedWords).size, g.usedWords.length, 'a word repeated');
    for (const p of g.players) {
      assert.ok(p.spent.length <= 26 && p.wildcardsUsed <= 1);
      assert.ok(p.skipsUsed <= SKIPS_PER_PLAYER, 'a player used more skips than allowed');
      assert.equal(new Set(p.spent).size, p.spent.length, 'a letter card was spent twice');
    }
    // Every recorded move must have been a real dictionary step.
    for (const m of g.history) {
      assert.ok(WORD_SET.has(m.to));
      assert.equal(m.to, m.from.slice(0, m.pos) + m.letter + m.from.slice(m.pos + 1));
      assert.ok(['normal', 'wildcard', 'skip'].includes(m.kind));
      if (m.kind === 'skip') {
        assert.ok(
          g.players.every((p) => p.spent.includes(m.letter)),
          'a skipped letter must be gone from both racks',
        );
        assert.ok(
          g.history.filter((h) => h.kind === 'wildcard').every((h) => h.by !== undefined),
          'sanity: wildcard moves are only ever made by players',
        );
      }
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
