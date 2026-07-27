// localStorage-backed persistence. There is no server: the "login" below is a
// shared-secret speed bump for a party game, not access control.
export const GATE_PASSWORD = 'chargame';

const KEY_USERS = 'crg.users.v1';
const KEY_SESSION = 'crg.session.v1';
const KEY_GAME = 'crg.game.v1';
const KEY_UNLOCKED = 'crg.unlocked.v1';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private-mode or quota: the game still works, it just will not persist */
  }
}

export function isUnlocked() {
  return read(KEY_UNLOCKED, false) === true;
}

export function unlock(password) {
  if (password !== GATE_PASSWORD) return false;
  write(KEY_UNLOCKED, true);
  return true;
}

export function lock() {
  write(KEY_UNLOCKED, null);
  write(KEY_SESSION, null);
}

/** Users are `{ name, wins, losses, lastSeen }`, keyed by lowercased name. */
export function listUsers() {
  const users = read(KEY_USERS, []);
  return Array.isArray(users) ? users : [];
}

function saveUsers(users) {
  write(KEY_USERS, users);
}

export const normaliseName = (name) => name.trim().replace(/\s+/g, ' ');

export function findUser(name) {
  const key = normaliseName(name).toLowerCase();
  return listUsers().find((u) => u.name.toLowerCase() === key) || null;
}

export function addUser(name) {
  const clean = normaliseName(name);
  if (!clean) throw new Error('Pick a name first.');
  if (clean.length > 24) throw new Error('Names are capped at 24 characters.');
  if (findUser(clean)) throw new Error(`"${clean}" is already taken.`);
  const user = { name: clean, wins: 0, losses: 0, lastSeen: Date.now() };
  saveUsers([...listUsers(), user]);
  return user;
}

export function touchUser(name) {
  const key = normaliseName(name).toLowerCase();
  saveUsers(
    listUsers().map((u) => (u.name.toLowerCase() === key ? { ...u, lastSeen: Date.now() } : u)),
  );
}

/**
 * Deleting a user also clears the session and any saved game they were part of,
 * so a stale entry cannot leave a half-referenced match behind.
 */
export function deleteUser(name) {
  const key = normaliseName(name).toLowerCase();
  saveUsers(listUsers().filter((u) => u.name.toLowerCase() !== key));

  const session = getSession();
  if (session && session.toLowerCase() === key) write(KEY_SESSION, null);

  const game = loadGame();
  if (game && game.players.some((p) => p.name.toLowerCase() === key)) clearGame();
}

export function recordResult(winnerName, loserName) {
  const win = normaliseName(winnerName).toLowerCase();
  const lose = normaliseName(loserName).toLowerCase();
  saveUsers(
    listUsers().map((u) => {
      const key = u.name.toLowerCase();
      if (key === win) return { ...u, wins: u.wins + 1 };
      if (key === lose) return { ...u, losses: u.losses + 1 };
      return u;
    }),
  );
}

export function getSession() {
  const name = read(KEY_SESSION, null);
  return typeof name === 'string' && findUser(name) ? name : null;
}

export function setSession(name) {
  write(KEY_SESSION, name);
  if (name) touchUser(name);
}

export function loadGame() {
  const game = read(KEY_GAME, null);
  if (!game || game.version !== 1 || !Array.isArray(game.players)) return null;
  return game;
}

export function saveGame(game) {
  write(KEY_GAME, game);
}

export function clearGame() {
  write(KEY_GAME, null);
}
