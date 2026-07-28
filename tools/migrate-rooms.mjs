// Reports on live rooms in the database, and can normalise them to the current
// link format.
//
//   node tools/migrate-rooms.mjs                 # report only, changes nothing
//   node tools/migrate-rooms.mjs --apply         # write the upgrades
//   node tools/migrate-rooms.mjs --room 7F8K49   # just one room
//   node tools/migrate-rooms.mjs --index --apply  # list existing rooms under their players
//
// Upgrading is OPTIONAL: the app reads older skip-free rooms directly, so a room
// left alone still plays. Its real use is the report — in particular spotting a
// room recorded before version 3 whose move list contains a skip, which cannot be
// continued at all. Back then the bot could play a letter the giver had already
// spent, and the current bot never will, so replaying that skip would land on a
// different board. Those are reported and left untouched rather than quietly
// rewritten into a different game.
//
// Rewriting a room a player still has open will break THEIR tab if it is running
// older code: it will refuse the newer state, and the next move it publishes will
// overwrite the upgrade. Have both players reload first, or just leave the room
// alone and let it become current the next time someone moves.
//
// Originals are written to .local/room-backups/ before anything changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINK_VERSION, decodeGame } from '../src/link.js';
import { userKey } from '../src/cloud.js';
import { DATABASE_URL } from '../src/cloud-config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUPS = join(ROOT, '.local', 'room-backups');
// Read from link.js rather than repeated here: a stale copy of this number would
// make the tool "upgrade" current rooms by rewriting them to an older format.
const CURRENT_VERSION = LINK_VERSION;
const SKIP_TOKEN = '0-';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const index = args.includes('--index');
const onlyRoom = args.includes('--room') ? args[args.indexOf('--room') + 1] : null;

function http(method, url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        method,
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        headers: body ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () =>
          res.statusCode >= 200 && res.statusCode < 300
            ? resolve(text ? JSON.parse(text) : null)
            : reject(new Error(`HTTP ${res.statusCode} for ${method} ${url}: ${text}`)),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const fromBase64Url = (encoded) => {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return new TextDecoder().decode(
    Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (c) =>
      c.charCodeAt(0),
    ),
  );
};

const toBase64Url = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

if (!DATABASE_URL) {
  console.error('src/cloud-config.js has no DATABASE_URL, so there are no rooms to migrate.');
  process.exit(1);
}
const base = DATABASE_URL.replace(/\/+$/, '');

const codes = onlyRoom
  ? [onlyRoom]
  : Object.keys((await http('GET', `${base}/rooms.json?shallow=true`)) || {});

if (codes.length === 0) {
  console.log('No rooms found.');
  process.exit(0);
}

console.log(`${codes.length} room(s); target format is version ${CURRENT_VERSION}.`);
if (!apply) console.log('Dry run — pass --apply to write.\n');

let upgraded = 0;
let blocked = 0;

for (const code of codes) {
  const room = await http('GET', `${base}/rooms/${code}.json`);
  if (!room || typeof room.state !== 'string') {
    console.log(`  ${code}: no game stored, skipping`);
    continue;
  }

  let payload;
  try {
    payload = JSON.parse(fromBase64Url(room.state));
  } catch (err) {
    console.log(`  ${code}: state is not readable (${err.message}), leaving alone`);
    blocked += 1;
    continue;
  }

  const [version, nameA, nameB, startWord, moves, resignedBy] = payload;
  const plies = typeof moves === 'string' ? moves.length / 2 : 0;
  const label = `${code}: v${version}, ${nameA} vs ${nameB}, from ${String(startWord).toUpperCase()}, ${plies} plies`;

  if (version === CURRENT_VERSION) {
    try {
      decodeGame(room.state);
      console.log(`  ${label} — already current`);
    } catch (err) {
      console.log(`  ${label} — current version but will not replay: ${err.message}`);
      blocked += 1;
    }
    continue;
  }

  if (typeof moves === 'string' && moves.includes(SKIP_TOKEN)) {
    const skips = moves.split(SKIP_TOKEN).length - 1;
    console.log(
      `  ${label} — CANNOT migrate: ${skips} skip(s) recorded under the old bot rule, ` +
        'which would replay onto a different board. Left untouched.',
    );
    blocked += 1;
    continue;
  }

  // No skips, so the only rule that changed cannot apply: the move list means
  // exactly the same thing, and only the version number needs to move.
  const migrated = toBase64Url(
    JSON.stringify([CURRENT_VERSION, nameA, nameB, startWord, moves, resignedBy ?? null]),
  );

  let game;
  try {
    game = decodeGame(migrated);
  } catch (err) {
    console.log(`  ${label} — refusing to write: it does not replay legally (${err.message})`);
    blocked += 1;
    continue;
  }

  const onTurn = game.outcome
    ? `finished, ${game.players[game.outcome.winner].name} won`
    : `${game.players[game.turn].name} to play`;
  console.log(`  ${label} — upgradeable; replays to ${game.word.toUpperCase()}, ${onTurn}`);

  if (!apply) continue;

  console.log('    note: any tab still running older code will overwrite this');
  mkdirSync(BACKUPS, { recursive: true });
  const backup = join(BACKUPS, `${code}.json`);
  writeFileSync(backup, JSON.stringify({ room, migrated }, null, 2));

  await http('PATCH', `${base}/rooms/${code}.json`, {
    state: migrated,
    updatedAt: { '.sv': 'timestamp' },
  });

  const after = await http('GET', `${base}/rooms/${code}.json`);
  if (after.state !== migrated) throw new Error(`${code}: write did not stick`);
  decodeGame(after.state);
  console.log(`    upgraded (original saved to ${backup.replace(ROOT, '.')})`);
  upgraded += 1;
}

console.log(
  `\n${apply ? 'Upgraded' : 'Upgradeable'}: ${apply ? upgraded : codes.length - blocked}. ` +
    `Left alone: ${blocked}.`,
);

// Rooms that predate per-player game lists are invisible in the lobby until they
// are indexed, which is what makes "sign in and resume" find them.
if (index) {
  console.log('\nIndexing rooms under their players:');
  for (const code of codes) {
    const room = await http('GET', `${base}/rooms/${code}.json`);
    if (!room || typeof room.state !== 'string') continue;

    let names;
    try {
      names = decodeGame(room.state).players.map((player) => player.name);
    } catch (err) {
      console.log(`  ${code}: cannot read, skipping (${err.message})`);
      continue;
    }

    for (const name of [...new Set(names)]) {
      const key = userKey(name);
      const existing = await http('GET', `${base}/users/${key}/name.json`);
      const action = existing ? 'linked to' : 'created and linked to';
      if (!apply) {
        console.log(`  ${code}: would be ${action} ${name}`);
        continue;
      }
      if (!existing) {
        await http('PATCH', `${base}/users/${key}.json`, {
          name,
          lastSeen: { '.sv': 'timestamp' },
        });
      }
      await http('PATCH', `${base}/users/${key}/rooms.json`, { [code]: true });
      console.log(`  ${code}: ${action} ${name}`);
    }
  }
  if (!apply) console.log('  (dry run — pass --apply to write)');
}
