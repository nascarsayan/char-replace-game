import { html, useState } from '../../vendor/preact-standalone.module.js';

const dayMs = 24 * 60 * 60 * 1000;

function lastSeenLabel(user) {
  if (!user.lastSeen) return 'never played';
  const days = Math.floor((Date.now() - user.lastSeen) / dayMs);
  if (days <= 0) return 'active today';
  if (days === 1) return 'active yesterday';
  return `last active ${days} days ago`;
}

/**
 * Lists saved users as large pick buttons, with a two-step delete for clearing
 * out stale entries. Anyone who knows the password can delete anyone — there are
 * no per-user permissions by design.
 */
export function UserPicker({ users, pickLabel, onPick, onDelete, skipName }) {
  const [pendingDelete, setPendingDelete] = useState(null);
  const shown = users.filter((u) => u.name.toLowerCase() !== (skipName || '').toLowerCase());

  if (shown.length === 0) {
    return html`<p class="muted">No saved players yet.</p>`;
  }

  return html`
    <ul class="user-list" role="list">
      ${shown.map((user) => {
        const confirming = pendingDelete === user.name;
        return html`<li class="user-row">
          <button
            type="button"
            class="big user-pick"
            onClick=${() => onPick(user.name)}
            aria-label=${`${pickLabel} ${user.name}`}
          >
            <span class="user-name">${user.name}</span>
            <span class="user-meta"
              >${user.wins}W / ${user.losses}L · ${lastSeenLabel(user)}</span
            >
          </button>

          ${confirming
            ? html`<span class="confirm" role="group" aria-label=${`Delete ${user.name}?`}>
                <button
                  type="button"
                  class="danger"
                  onClick=${() => {
                    onDelete(user.name);
                    setPendingDelete(null);
                  }}
                >
                  Delete
                </button>
                <button type="button" class="secondary" onClick=${() => setPendingDelete(null)}>
                  Keep
                </button>
              </span>`
            : html`<button
                type="button"
                class="secondary outline"
                onClick=${() => setPendingDelete(user.name)}
                aria-label=${`Remove ${user.name}`}
              >
                Remove
              </button>`}
        </li>`;
      })}
    </ul>
  `;
}
