import { html, useState } from '../../vendor/preact-standalone.module.js';
import { addUser, deleteUser, listUsers, setSession } from '../store.js';
import { UserPicker } from './UserPicker.js';

export function SignIn({ onSignedIn }) {
  const [users, setUsers] = useState(listUsers);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  function create(event) {
    event.preventDefault();
    try {
      const user = addUser(name);
      setSession(user.name);
      onSignedIn(user.name);
    } catch (err) {
      setError(err.message);
    }
  }

  function pick(userName) {
    setSession(userName);
    onSignedIn(userName);
  }

  function remove(userName) {
    deleteUser(userName);
    setUsers(listUsers());
  }

  return html`
    <div class="panel">
      <h2>Who are you?</h2>

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
        <button type="submit" class="big">Create and continue</button>
      </form>

      <h3>Saved players</h3>
      <${UserPicker}
        users=${users}
        pickLabel="Continue as"
        onPick=${pick}
        onDelete=${remove}
      />
      <p><small>Players are stored in this browser only. Remove anyone who is stale.</small></p>
    </div>
  `;
}
