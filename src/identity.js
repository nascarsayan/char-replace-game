// Who is playing, and which games they are in.
//
// With a database configured, identities live there, so signing in as an existing
// name on a fresh device finds both the name and the games it left half-played.
// Without one, everything falls back to this browser's localStorage, which is the
// old behaviour: the app still works, it just cannot follow you between devices.
//
// There is no per-identity password. Anyone past the shared page password can sign
// in as any name — the same trust model as the rest of this, and deliberate.
import * as cloud from './cloud.js';
import * as store from './store.js';

export const identitiesAreShared = cloud.cloudConfigured;

/** `[{ name, lastSeen, wins, losses }]`. */
export async function listUsers() {
  if (!cloud.cloudConfigured()) {
    return store.listUsers().map((user) => ({ ...user, shared: false }));
  }
  const users = await cloud.fetchUsers();
  // Records are derived from the games themselves rather than counted up as they
  // finish, so two clients writing at once cannot double-count anything.
  return Promise.all(
    users.map(async (user) => {
      let wins = 0;
      let losses = 0;
      try {
        for (const game of await cloud.fetchUserGames(user.name)) {
          if (!game.outcome) continue;
          if (game.winner === user.name) wins += 1;
          else losses += 1;
        }
      } catch {
        // A record is a nicety; never let it stop somebody signing in.
      }
      return { ...user, wins, losses, shared: true };
    }),
  );
}

export async function createUser(name) {
  const clean = store.normaliseName(name);
  if (!clean) throw new Error('Pick a name first.');
  if (clean.length > 24) throw new Error('Names are capped at 24 characters.');
  if (!cloud.cloudConfigured()) return store.addUser(clean).name;
  await cloud.createUser(clean);
  return clean;
}

export async function deleteUser(name) {
  if (!cloud.cloudConfigured()) return store.deleteUser(name);
  await cloud.deleteUser(name);
  if (store.getSession() === name) store.setSession(null);
}

export async function signIn(name) {
  store.setSession(name);
  if (cloud.cloudConfigured()) await cloud.touchUser(name).catch(() => {});
}

/**
 * The unfinished games this identity can pick up again. Only relayed games can
 * be resumed elsewhere; a game saved on this device is reported separately by
 * the caller, because it cannot follow anyone anywhere.
 */
export async function listResumableGames(name) {
  if (!cloud.cloudConfigured() || !name) return [];
  const games = await cloud.fetchUserGames(name);
  return games.filter((game) => !game.unreadable && !game.outcome);
}

export async function listFinishedGames(name) {
  if (!cloud.cloudConfigured() || !name) return [];
  return (await cloud.fetchUserGames(name)).filter((game) => game.outcome);
}

/** Called when someone hosts or joins, so the room turns up in their list. */
export async function rememberGame(name, roomCode) {
  if (!cloud.cloudConfigured() || !name) return;
  await cloud.rememberRoom(name, roomCode).catch(() => {});
}

export async function forgetGame(name, roomCode) {
  if (!cloud.cloudConfigured() || !name) return;
  await cloud.forgetRoom(name, roomCode).catch(() => {});
}
