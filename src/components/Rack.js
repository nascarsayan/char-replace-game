import { html } from '../../vendor/preact-standalone.module.js';
import { LETTERS, WILDCARDS_PER_PLAYER, cardsLeft, hasWildcard } from '../game.js';

/**
 * A player's 27 cards. Both racks are always on screen — knowing what the
 * opponent has left is part of the game.
 *
 * When `interactive` is set the letters are buttons for the player on turn;
 * otherwise the rack is a read-only summary.
 */
export function Rack({ player, label, interactive = false, onPlay }) {
  const wildcardLeft = hasWildcard(player);

  return html`
    <section class="rack" aria-label=${`${label}: cards remaining`}>
      <header class="rack-head">
        <h3>${player.name}</h3>
        <p class="rack-count">
          <strong>${cardsLeft(player)}</strong> of ${LETTERS.length + WILDCARDS_PER_PLAYER} cards
          left
        </p>
      </header>

      <ul class="cards" role="list">
        ${LETTERS.map((letter) => {
          const spent = player.spent.includes(letter);
          const needsWildcard = spent && wildcardLeft;
          const dead = spent && !wildcardLeft;
          const state = dead ? 'spent' : needsWildcard ? 'wildcard-only' : 'ready';
          // Player-neutral wording: this rack may belong to the opponent.
          const note = dead
            ? 'spent, no wildcard left'
            : needsWildcard
              ? 'spent, replayable with the wildcard'
              : 'available';

          if (!interactive) {
            return html`<li class="card" data-state=${state} aria-label=${`${letter}, ${note}`}>
              <span aria-hidden="true">${letter.toUpperCase()}</span>
            </li>`;
          }
          return html`<li>
            <button
              type="button"
              class="card"
              data-state=${state}
              disabled=${dead}
              aria-label=${`Play ${letter}, ${note}`}
              onClick=${() => onPlay(letter)}
            >
              <span aria-hidden="true">${letter.toUpperCase()}</span>
            </button>
          </li>`;
        })}
      </ul>

      <p class="wildcard-state" data-left=${wildcardLeft}>
        ${wildcardLeft ? '★ Wildcard available' : '☆ Wildcard used'}
      </p>
    </section>
  `;
}
