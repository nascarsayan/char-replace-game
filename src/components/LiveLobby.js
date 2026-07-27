import { html, useState } from '../../vendor/preact-standalone.module.js';
import { cloudConfigured } from '../cloud.js';
import { isRoomCode, normaliseRoomCode } from '../net.js';

/** Host a live game, or join one with a code. */
export function LiveLobby({ me, onHost, onJoin, onCancel }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  function join(event) {
    event.preventDefault();
    if (!isRoomCode(code)) {
      setError('A room code is six letters and digits.');
      return;
    }
    onJoin(normaliseRoomCode(code));
  }

  return html`
    <div class="panel">
      <h2>Play live</h2>
      <p>
        ${cloudConfigured()
          ? 'Moves are relayed through a database, so the room survives a closed tab and works on any network.'
          : 'Moves travel directly between your two browsers, so you both need to be online at once. On restrictive networks this can fail to connect — link play always works.'}
      </p>

      <button type="button" class="big" onClick=${onHost}>Host a new game</button>

      <h3>Or join with a code</h3>
      <form onSubmit=${join}>
        <label>
          Room code
          <input
            type="text"
            name="room"
            class="room-input"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            placeholder="ABC123"
            maxlength="6"
            value=${code}
            onInput=${(e) => {
              const next = normaliseRoomCode(e.target.value);
              e.target.value = next;
              setCode(next);
              setError('');
            }}
            aria-invalid=${error ? 'true' : undefined}
            aria-describedby="live-error"
          />
        </label>
        <p id="live-error" class="error" role="alert">${error}</p>
        <button type="submit" class="big" disabled=${!isRoomCode(code)}>
          ${`Join as ${me}`}
        </button>
      </form>

      <button type="button" class="secondary outline" onClick=${onCancel}>Back</button>
    </div>
  `;
}

/** Shown to the host while waiting for the other player to arrive. */
export function WaitingRoom({ roomCode, inviteUrl, onCancel, note }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      const field = document.getElementById('invite-url');
      if (field) field.select();
    }
  }

  return html`
    <div class="panel">
      <h2>Waiting for your opponent</h2>

      <p>Send them this link, or read them the code.</p>

      <div class="share-row">
        <input
          id="invite-url"
          type="text"
          readonly
          value=${inviteUrl}
          aria-label="Invite link"
          onFocus=${(e) => e.target.select()}
        />
        <button type="button" onClick=${copy}>${copied ? 'Copied' : 'Copy link'}</button>
      </div>

      <p class="room-code" aria-label=${`Room code ${roomCode.split('').join(' ')}`}>
        ${roomCode}
      </p>

      <p aria-live="polite" class="muted">
        <small>
          ${note ||
          (cloudConfigured()
            ? 'The room is saved, so they can join whenever — you do not have to wait here.'
            : 'Connecting through public signalling — this can take a few seconds.')}
        </small>
      </p>

      <button type="button" class="secondary outline" onClick=${onCancel}>Cancel</button>
    </div>
  `;
}
