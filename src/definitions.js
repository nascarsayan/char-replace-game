// Definitions are a few hundred kilobytes, so they load once in the background
// rather than blocking the game. Everything here degrades quietly: if the fetch
// fails the board simply shows no gloss.
// Not named URL: that would shadow the global URL used in its own initialiser.
const DEFINITIONS_URL = new URL('../assets/definitions.json', import.meta.url);

let cache = null;
let pending = null;
const listeners = new Set();

/** Kicks off the load. Safe to call repeatedly; only the first fetch happens. */
export function loadDefinitions() {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = fetch(DEFINITIONS_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`definitions: HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        cache = data;
        listeners.forEach((listener) => listener());
        return cache;
      })
      .catch(() => {
        // An empty map means "loaded, nothing known" — the UI copes with that.
        cache = {};
        listeners.forEach((listener) => listener());
        return cache;
      });
  }
  return pending;
}

/** Notifies when the load finishes, so components can re-render. */
export function onDefinitionsReady(listener) {
  if (cache) {
    listener();
    return () => {};
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const definitionsReady = () => cache !== null;

/**
 * The gloss for a word, or null when there is none. Returns undefined while the
 * data is still loading, so callers can tell "not yet" from "nothing known".
 */
export function define(word) {
  if (!cache) return undefined;
  return cache[word.toLowerCase()] || null;
}
