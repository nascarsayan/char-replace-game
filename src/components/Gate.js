import { html, useState } from '../../vendor/preact-standalone.module.js';
import { unlock } from '../store.js';
import { Rules } from './Rules.js';

/**
 * Shared-password screen. This is a party-game speed bump, not security: the
 * check runs in the browser and the password is in the source. Said so on screen
 * rather than implying otherwise.
 */
export function Gate({ onUnlocked }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function submit(event) {
    event.preventDefault();
    if (unlock(password)) {
      onUnlocked();
      return;
    }
    setError('Wrong password.');
    setPassword('');
  }

  return html`
    <form class="panel" onSubmit=${submit}>
      <h2>Enter the password</h2>
      <label>
        Password
        <input
          type="password"
          name="password"
          autocomplete="current-password"
          value=${password}
          onInput=${(e) => {
            setPassword(e.target.value);
            setError('');
          }}
          aria-invalid=${error ? 'true' : undefined}
          aria-describedby="gate-error"
          autofocus
        />
      </label>
      <p id="gate-error" class="error" role="alert">${error}</p>
      <button type="submit" class="big">Unlock</button>
      <p>
        <small
          >The password is shared and checked in the browser. It keeps passers-by out, nothing
          more.</small
        >
      </p>
      <${Rules} />
    </form>
  `;
}
