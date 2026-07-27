// Share-link encoding tests for src/link.js:
//   node tools/test-link.mjs
import assert from 'node:assert/strict';
import {
  SKIPS_PER_PLAYER,
  applyMove,
  applySkip,
  botMove,
  canSkip,
  createGame,
  legacyBotMove,
  legalMoves,
  resign,
} from '../src/game.js';
import {
  buildShareUrl,
  decodeGame,
  encodeGame,
  readGameFromLocation,
  writeGameToLocation,
} from '../src/link.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const rand = (() => {
  let seed = 4242;
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
})();

// A game can now have no legal move and still be alive, because a skip is a way
// out — so the helper gives up the turn rather than falling over.
function playRandom(game, plies) {
  for (let i = 0; i < plies && !game.outcome; i++) {
    const moves = legalMoves(game);
    if (moves.length === 0) {
      game = applySkip(game);
      continue;
    }
    const pick = moves[Math.floor(rand() * moves.length)];
    game = applyMove(game, pick.pos, pick.letter);
  }
  return game;
}

test('a fresh game round-trips', () => {
  const game = createGame('Sayan', 'Riya', 'cold');
  assert.deepEqual(decodeGame(encodeGame(game)), game);
});

test('a game in progress round-trips exactly, spent cards included', () => {
  const game = playRandom(createGame('Sayan', 'Riya', 'cold'), 12);
  const revived = decodeGame(encodeGame(game));
  assert.deepEqual(revived, game);
  // The parts that are *derived* rather than encoded are what matter here.
  assert.deepEqual(revived.players[0].spent, game.players[0].spent);
  assert.deepEqual(revived.players[1].spent, game.players[1].spent);
  assert.equal(revived.players[0].wildcardsUsed, game.players[0].wildcardsUsed);
  assert.equal(revived.turn, game.turn);
  assert.deepEqual(revived.usedWords, game.usedWords);
});

test('a wildcard move survives the round trip', () => {
  // Wildcard-ness is not stored in the link — it is re-derived by replay — so
  // this plays on until the engine itself offers a wildcard move, then takes
  // it. Asking the engine beats hand-writing a word chain that must stay valid.
  let game = createGame('Sayan', 'Riya', 'cold');
  let played = false;
  for (let ply = 0; ply < 200 && !game.outcome; ply++) {
    const moves = legalMoves(game);
    const wild = moves.find((move) => move.kind === 'wildcard');
    if (wild) {
      game = applyMove(game, wild.pos, wild.letter);
      played = true;
      break;
    }
    const pick = moves[Math.floor(rand() * moves.length)];
    game = applyMove(game, pick.pos, pick.letter);
  }
  assert.ok(played, 'no wildcard move ever became available');

  const last = game.history[game.history.length - 1];
  assert.equal(last.kind, 'wildcard');
  const mover = last.by;
  assert.equal(game.players[mover].wildcardsUsed, 1);

  const revived = decodeGame(encodeGame(game));
  assert.deepEqual(revived, game);
  assert.equal(revived.history[revived.history.length - 1].kind, 'wildcard');
  assert.equal(revived.players[mover].wildcardsUsed, 1);
  // The replayed letter must not be double-counted as a fresh card.
  assert.deepEqual(revived.players[mover].spent, game.players[mover].spent);
});

test('a finished game round-trips, stuck or resigned', () => {
  const stuck = playRandom(createGame('Sayan', 'Riya', 'cold'), 500);
  assert.equal(stuck.outcome.reason, 'stuck');
  assert.deepEqual(decodeGame(encodeGame(stuck)), stuck);

  const quit = resign(playRandom(createGame('Sayan', 'Riya', 'cold'), 5), 1);
  assert.equal(quit.outcome.reason, 'resigned');
  const revivedQuit = decodeGame(encodeGame(quit));
  assert.deepEqual(revivedQuit.outcome, { loser: 1, winner: 0, reason: 'resigned' });
  assert.deepEqual(revivedQuit, quit);
});

test('names with spaces and non-ASCII survive', () => {
  const game = playRandom(createGame('Ada Löve', 'Ríya 🎲', 'cold'), 4);
  const revived = decodeGame(encodeGame(game));
  assert.equal(revived.players[0].name, 'Ada Löve');
  assert.equal(revived.players[1].name, 'Ríya 🎲');
});

test('the payload is URL-safe and stays short', () => {
  const long = playRandom(createGame('Sayan', 'Riya', 'cold'), 500);
  const encoded = encodeGame(long);
  assert.match(encoded, /^[A-Za-z0-9\-_]+$/, 'must need no percent-encoding');
  assert.ok(encoded.length < 400, `payload was ${encoded.length} chars for ${long.history.length} plies`);
});

test('a truncated link is refused, not half-loaded', () => {
  const encoded = encodeGame(playRandom(createGame('Sayan', 'Riya', 'cold'), 10));
  assert.throws(() => decodeGame(encoded.slice(0, encoded.length - 6)), /damaged|not a game|not legal/i);
  assert.throws(() => decodeGame('nonsense'), /damaged|not a game/i);
  assert.throws(() => decodeGame(''), /damaged|not a game/i);
});

test('a link describing illegal play is refused', () => {
  const b64 = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  // "cold" -> "qold" is not a word.
  assert.throws(() => decodeGame(b64([3, 'A', 'B', 'cold', '1q', null])), /not legal/i);
  // Slot 9 does not exist.
  assert.throws(() => decodeGame(b64([3, 'A', 'B', 'cold', '9b', null])), /slot 9/i);
  // An odd number of characters means the move list was cut mid-move.
  assert.throws(() => decodeGame(b64([3, 'A', 'B', 'cold', '1b3', null])), /truncated/i);
  // Not a dictionary word to start from.
  assert.throws(() => decodeGame(b64([3, 'A', 'B', 'zzzz', '', null])), /not a word/i);
  // A future version is rejected rather than misread.
  assert.throws(() => decodeGame(b64([99, 'A', 'B', 'cold', '', null])), /different version/i);
  // Missing a name.
  assert.throws(() => decodeGame(b64([3, '', 'B', 'cold', '', null])), /missing a player name/i);
});

test('replaying the same word twice cannot be smuggled in', () => {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // cold -> bold -> cold repeats the opening word.
  assert.throws(() => decodeGame(b64([3, 'A', 'B', 'cold', '1b1c', null])), /already been played/i);
});

test('a skip round-trips, and the bot is replayed identically', () => {
  let game = createGame('Sayan', 'Riya', 'cold');
  game = applySkip(game);           // A gives up; the bot plays
  game = applyMove(game, 3, 'e');   // B replies
  game = applySkip(game);           // A gives up again

  const revived = decodeGame(encodeGame(game));
  // The bot's choice is never transmitted — it is recomputed. If that drifted,
  // the two sides would silently disagree about the board.
  assert.deepEqual(revived, game);
  assert.equal(revived.word, game.word);
  assert.equal(revived.players[0].skipsUsed, 2);
  assert.equal(revived.players[1].skipsUsed, 0);
  const skips = revived.history.filter((m) => m.kind === 'skip');
  assert.equal(skips.length, 2);
  for (const skip of skips) {
    assert.ok(
      revived.players.every((p) => p.spent.includes(skip.letter)),
      'a skipped letter must be spent for both players after a round trip',
    );
  }
});

test('a link cannot claim more skips than the rules allow', () => {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // Six skips by the same player: the first five alternate turns, so player A
  // skipping six times needs 11 tokens. Simpler: hand-build an over-long run.
  const tokens = '0-'.repeat(2 * SKIPS_PER_PLAYER + 2);
  assert.throws(
    () => decodeGame(b64([3, 'A', 'B', 'cold', tokens, null])),
    /no skips left|no word left|not legal/i,
  );
});

test('a game mixing moves and skips plays out and round-trips', () => {
  let game = createGame('Sayan', 'Riya', 'cold');
  let guard = 0;
  while (!game.outcome && guard++ < 400) {
    const moves = legalMoves(game);
    if (moves.length === 0) {
      assert.equal(canSkip(game), true);
      game = applySkip(game);
    } else if (guard % 7 === 0 && canSkip(game)) {
      game = applySkip(game);
    } else {
      const pick = moves[Math.floor(rand() * moves.length)];
      game = applyMove(game, pick.pos, pick.letter);
    }
  }
  assert.ok(game.outcome, 'game should have finished');
  assert.ok(
    game.history.some((m) => m.kind === 'skip'),
    'this playout should contain skips',
  );
  assert.deepEqual(decodeGame(encodeGame(game)), game);
});

test('older links still play when they contain no skips', () => {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const current = createGame('A', 'B', 'cold');
  const expected = applyMove(applyMove(current, 0, 'b'), 3, 'e'); // cold -> bold -> bole

  // Only the meaning of a *skip* changed, so a skip-free older list is identical.
  for (const version of [1, 2]) {
    const revived = decodeGame(b64([version, 'A', 'B', 'cold', '1b4e', null]));
    assert.deepEqual(revived, expected, `version ${version} should replay unchanged`);
  }

  // Writing always uses the current format, so a game read from an old link is
  // handed on as a current one.
  const passedOn = decodeGame(b64([2, 'A', 'B', 'cold', '1b4e', null]));
  const reencoded = JSON.parse(Buffer.from(encodeGame(passedOn), 'base64url').toString());
  assert.equal(reencoded[0], 4, 'must be re-encoded as the current version');
});

test('an older skip replays with the bot rule of its own era', () => {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

  // Version 2's bot ignored rack limits. Spend the letter it would have chosen
  // and the two eras diverge, which is exactly what has to be honoured.
  const seed = createGame('A', 'B', 'cold');
  assert.equal(legacyBotMove(seed).letter, 'b');
  const cornered = createGame('A', 'B', 'cold');
  cornered.players[0].spent = ['b'];
  assert.equal(legacyBotMove(cornered).letter, 'b', 'the old bot ignored the rack');
  assert.notEqual(botMove(cornered).letter, 'b', "today's bot does not");

  // A version 2 skip is replayed with the old rule...
  const old = decodeGame(b64([2, 'A', 'B', 'cold', '0-', null]));
  assert.equal(old.word, 'bold');
  assert.equal(old.history[0].kind, 'skip');
  // ...and a version 3 one with the rule that was current then, which is today's.
  const newer = decodeGame(b64([3, 'A', 'B', 'cold', '0-', null]));
  assert.equal(newer.word, 'bold');

  // A skip recorded under the current rules round-trips as ever.
  const withSkip = applySkip(createGame('A', 'B', 'cold'));
  assert.deepEqual(decodeGame(encodeGame(withSkip)), withSkip);
});

test('a version 4 skip records its letter rather than recomputing it', () => {
  const game = applySkip(createGame('A', 'B', 'cold'));
  const payload = JSON.parse(Buffer.from(encodeGame(game), 'base64url').toString());
  assert.equal(payload[0], 4);
  // Uppercase marks the skip and keeps the token two characters wide.
  assert.equal(payload[4], '1B');
  assert.deepEqual(decodeGame(encodeGame(game)), game);
});

// A real version 2 game, 52 plies from HOTS, whose last two skipped turns were
// only legal because a skip could then rescue a player with no move. Kept as a
// fixture because that situation is far easier to encounter than to construct.
const LEGACY_GAME_MOVES =
  '2i1t1w1f1r4e1z1v3v3c3n1l3k2u1y1j1p1b3t1m1j3r1c4d4l1g1b4p4g4k1m2i1d3n1f4o4s1z1h1w4o4y4e1a1m1s2a3x0-3v0-1h';

test('a real game that depended on the old end rule still loads', () => {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const game = decodeGame(b64([2, 'A', 'B', 'hots', LEGACY_GAME_MOVES, null]));

  assert.equal(game.history.length, 52);
  assert.equal(game.word, 'have');
  assert.equal(game.history.filter((move) => move.kind === 'skip').length, 2);
  assert.deepEqual(game.players.map((p) => p.skipsUsed), [2, 0]);

  // Today's rule finishes it: the player on turn has nothing left to play.
  assert.equal(legalMoves(game).length, 0);
  assert.deepEqual(game.outcome, { loser: 0, winner: 1, reason: 'stuck' });

  // The flag is load-bearing here, and keeps the game readable once re-encoded.
  assert.equal(game.legacyRules, true);
  const reencoded = encodeGame(game);
  assert.equal(JSON.parse(Buffer.from(reencoded, 'base64url').toString())[6], true);
  assert.deepEqual(decodeGame(reencoded), game);
});

test('an older game that never needed the old rule comes back unflagged', () => {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // The same fixture, cut short before the position went dead.
  const early = decodeGame(b64([2, 'A', 'B', 'hots', LEGACY_GAME_MOVES.slice(0, 40), null]));
  assert.equal(early.legacyRules, undefined, 'no rescue happened, so no flag');
  assert.equal(JSON.parse(Buffer.from(encodeGame(early), 'base64url').toString()).length, 6);
  assert.deepEqual(decodeGame(encodeGame(early)), early);
});

test('versions outside the readable range are refused', () => {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const version of [0, 5, 99, 'two', null]) {
    assert.throws(
      () => decodeGame(b64([version, 'A', 'B', 'cold', '', null])),
      /different version/i,
      `version ${version} should be refused`,
    );
  }
});

test('buildShareUrl and readGameFromLocation agree', () => {
  const game = playRandom(createGame('Sayan', 'Riya', 'cold'), 7);
  const location = {
    origin: 'https://nascarsayan.github.io',
    pathname: '/char-replace-game/',
    search: '',
    hash: '',
  };
  const url = buildShareUrl(game, location);
  assert.ok(url.startsWith('https://nascarsayan.github.io/char-replace-game/#g='));
  assert.deepEqual(readGameFromLocation({ hash: new URL(url).hash }).game, game);
  assert.equal(readGameFromLocation({ hash: '' }), null);
  assert.match(readGameFromLocation({ hash: '#g=nonsense' }).error, /damaged|not a game/i);
});

test('writeGameToLocation replaces the fragment in place', () => {
  const game = playRandom(createGame('Sayan', 'Riya', 'cold'), 3);
  const calls = [];
  writeGameToLocation(game, { replaceState: (a, b, url) => calls.push(url) });
  assert.equal(calls.length, 1);
  assert.deepEqual(readGameFromLocation({ hash: calls[0] }).game, game);
});

test('a link is a baton: decoding gives the position with the turn handed over', () => {
  let game = createGame('Sayan', 'Riya', 'cold');
  assert.equal(game.turn, 0);
  game = applyMove(game, 0, 'b'); // Sayan moves, so the link is Riya's to open
  const revived = decodeGame(encodeGame(game));
  assert.equal(revived.turn, 1);
  assert.equal(revived.players[revived.turn].name, 'Riya');
});

console.log(`\n${passed} test groups passed`);
