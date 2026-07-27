// Paste your Firebase Realtime Database URL here to turn on reliable live games.
//
//   1. console.firebase.google.com -> Add project (skip Analytics)
//   2. Build -> Realtime Database -> Create Database -> start in test mode
//   3. Copy the URL from the top of that page and paste it below
//
// It looks like 'https://your-project-default-rtdb.firebaseio.com' (or
// '...-default-rtdb.europe-west1.firebasedatabase.app' outside the US).
//
// Only the database URL is needed: the REST API this uses takes no API key when
// the rules are open. Leaving it empty is fine — live games then fall back to the
// peer-to-peer transport, and link play is unaffected either way.
//
// The URL is not a secret (it ships in the page), but with open rules anyone who
// knows a room code can read or write that room. See the rules in README.md for
// the version that at least confines writes to /rooms.
export const DATABASE_URL = 'https://chargame-76609-default-rtdb.asia-southeast1.firebasedatabase.app';
