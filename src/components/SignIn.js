import { html, useEffect, useState } from '../../vendor/preact-standalone.module.js';
import * as identity from '../identity.js';
import { UserPicker } from './UserPicker.js';

export function SignIn({ onSignedIn }) {
  const [users, setUsers] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const shared = identity.identitiesAreShared();

  async function refresh() {
    try {
      setUsers(await identity.listUsers());
    } catch (err) {
      setError(`Could not read the player list: ${err.message}`);
      setUsers([]);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const created = await identity.createUser(name);
      await identity.signIn(created);
      onSignedIn(created);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function pick(userName) {
    setBusy(true);
    try {
      await identity.signIn(userName);
      onSignedIn(userName);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function remove(userName) {
    setBusy(true);
    try {
      await identity.deleteUser(userName);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return html`
    <div class="panel">
      <h2>Who are you?</h2>
      <p>
        ${shared
          ? 'Players are saved with the game, so signing in as an existing name on any device picks up where it left off.'
          : 'Players are saved in this browser only, because no database is configured.'}
      </p>

      <form onSubmit=${create}>
        <label>
          New player name
          <input
            type="text"
            name="username"
            maxlength="24"
            autocomplete="off"
            placeholder="e.g. Sayan"
            value=${name}
            onInput=${(e) => {
              setName(e.target.value);
              setError('');
            }}
            aria-invalid=${error ? 'true' : undefined}
            aria-describedby="signin-error"
          />
        </label>
        <p id="signin-error" class="error" role="alert">${error}</p>
        <button type="submit" class="big" disabled=${busy}>Create and continue</button>
      </form>

      <h3>Saved players</h3>
      ${users === null
        ? html`<p class="muted" aria-live="polite">Loading players…</p>`
        : html`<${UserPicker}
            users=${users}
            pickLabel="Continue as"
            onPick=${pick}
            onDelete=${remove}
          />`}
      <p>
        <small>
          ${shared
            ? 'Anyone with the page password can sign in as any of these names — there are no per-player passwords. Remove anyone who is stale.'
            : 'Remove anyone who is stale.'}
        </small>
      </p>
    </div>
  `;
}
