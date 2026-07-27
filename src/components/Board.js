import { html, useEffect, useRef, useState } from '../../vendor/preact-standalone.module.js';
import { LETTERS, WORD_LEN, canSkip, inspectMove, legalMoves, skipsLeft } from '../game.js';
import { seatMarker, seatShape } from '../seats.js';
import { Definition, InlineDefinition, useDefinitions } from './Definition.js';
import { Rack } from './Rack.js';
import { Share } from './Share.js';

const EMPTY_SCRATCH = { slot: null, pendingWildcard: null, message: '' };

function describeMove(game, move) {
  const who = game.players[move.by].name;
  const letter = move.letter.toUpperCase();
  const played = `slot ${move.pos + 1} → ${letter}`;
  if (move.kind === 'skip') {
    // Worth spelling out: the bot chose this, and it cost both players a card.
    return `${who} skipped · bot played ${played} · both racks lose ${letter}`;
  }
  return `${who} · ${played}${move.kind === 'wildcard' ? ' ★ wildcard' : ''}`;
}

/**
 * `youAre` is the seat this browser plays (0, 1, or null when both sides share
 * the screen). `locked` blocks input while it is the other player's move, which
 * only applies to a live game.
 */
export function Board({
  game,
  shareUrl,
  youAre = null,
  youLabel,
  locked = false,
  status,
  onMove,
  onSkip,
  onResign,
  onRematch,
  onExit,
}) {
  useDefinitions();
  // Per-turn scratch state lives in a ref with a state mirror for rendering.
  // Keyboard entry is faster than a render pass — typing "1" then "b" would
  // otherwise read a stale `slot` from the closure and drop the letter.
  const [scratch, setScratch] = useState(EMPTY_SCRATCH);
  const scratchRef = useRef(scratch);
  const [confirmResign, setConfirmResign] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);

  function update(patch) {
    scratchRef.current = { ...scratchRef.current, ...patch };
    setScratch(scratchRef.current);
  }

  function selectSlot(i) {
    update({ slot: i, pendingWildcard: null, message: '' });
  }

  const { slot, pendingWildcard, message } = scratch;
  const over = Boolean(game.outcome);
  const current = game.players[game.turn];

  // Every completed move clears the scratch state.
  useEffect(() => {
    update(EMPTY_SCRATCH);
    setConfirmSkip(false);
  }, [game.history.length, over]);

  function attempt(letter) {
    if (over || locked) return;
    const pending = scratchRef.current;
    if (pending.slot === null) {
      update({ message: `Pick a slot first — click a tile or press 1–${WORD_LEN}.` });
      return;
    }
    const verdict = inspectMove(game, pending.slot, letter);
    if (!verdict.ok) {
      update({ pendingWildcard: null, message: verdict.reason });
      return;
    }
    // A wildcard is a one-off resource, so never burn it on a stray click.
    if (verdict.kind === 'wildcard' && pending.pendingWildcard !== letter) {
      update({
        pendingWildcard: letter,
        message: `"${verdict.word.toUpperCase()}" works, but ${letter.toUpperCase()} is already spent — that costs your wildcard.`,
      });
      return;
    }
    onMove(pending.slot, letter);
  }

  // Re-registered every render so `game` and `attempt` stay current; the scratch
  // ref above is what makes rapid keystrokes safe.
  useEffect(() => {
    function onKey(event) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (over || locked) return;
      const target = event.target;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.key === 'Escape') {
        update(EMPTY_SCRATCH);
        return;
      }
      const digit = Number(event.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= WORD_LEN) {
        event.preventDefault();
        selectSlot(digit - 1);
        return;
      }
      // Arrow keys walk the slots, as a radiogroup is expected to.
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const step = event.key === 'ArrowLeft' ? -1 : 1;
        const from = scratchRef.current.slot;
        selectSlot(from === null ? 0 : (from + step + WORD_LEN) % WORD_LEN);
        return;
      }
      const letter = event.key.toLowerCase();
      if (LETTERS.includes(letter) && event.key.length === 1) {
        event.preventDefault();
        attempt(letter);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Sentences are assembled here rather than inline: htm collapses the
  // whitespace between adjacent ${} expressions, which glues words together.
  const yourTurn = youAre !== null && game.turn === youAre;
  const turnLine = over
    ? `${game.players[game.outcome.loser].name} has no moves left — ${game.players[game.outcome.winner].name} wins.`
    : youAre === null
      ? `${current.name}'s turn.`
      : yourTurn
        ? 'Your turn.'
        : `Waiting for ${current.name}…`;

  // Skips always belong to the player on turn — it is their turn being given up.
  const skipSeat = game.turn;
  const skipTarget = game.players[skipSeat];
  const skipsRemaining = skipsLeft(skipTarget);
  const skipAvailable = canSkip(game);
  const noMovesLeft = !over && !locked && legalMoves(game).length === 0;

  const plies = game.history.length;
  const outcomeLine = over
    ? [
        game.players[game.outcome.loser].name,
        game.outcome.reason === 'resigned' ? 'resigned' : 'ran out of legal moves',
        `after ${plies} ${plies === 1 ? 'move' : 'moves'}.`,
      ].join(' ')
    : '';

  return html`
    <div class="board">
      ${youAre === null
        ? null
        : html`<p class="identity" data-seat=${youAre}>
            <span class="seat-marker" data-shape=${seatShape(youAre)} aria-hidden="true"
              >${seatMarker(youAre)}</span
            >
            ${youLabel || `You are ${game.players[youAre].name}`}
          </p>`}
      ${status ? html`<p class="net-status" role="status">${status}</p>` : null}

      <p class="turn" role="status" data-your-turn=${yourTurn}>${turnLine}</p>

      <!--
        A radiogroup, not a [role="group"]: picking a slot is a single choice out
        of four, and Pico reserves [role="group"] for joined button groups whose
        layout rules (flex: 1, collapsed radii) fight a tile row.
      -->
      <div class="word" role="radiogroup" aria-label="Current word — pick a slot to change">
        ${game.word.split('').map(
          (ch, i) => html`
            <button
              type="button"
              class="tile"
              role="radio"
              aria-checked=${slot === i}
              aria-label=${`Slot ${i + 1}, letter ${ch}`}
              tabindex=${slot === i || (slot === null && i === 0) ? 0 : -1}
              disabled=${over || locked}
              onClick=${() =>
                // Deliberately not a toggle: re-clicking the chosen slot after a
                // rejected letter should keep it selected, not silently clear it.
                selectSlot(i)}
            >
              <span aria-hidden="true">${ch.toUpperCase()}</span>
              <small aria-hidden="true">${i + 1}</small>
            </button>
          `,
        )}
      </div>

      <${Definition} word=${game.word} />

      <p class="hint" role="alert" data-kind=${pendingWildcard ? 'wildcard' : 'info'}>
        ${message ||
        (over
          ? ''
          : locked
            ? `It is ${current.name}'s move.`
            : noMovesLeft
              ? 'No legal move left — give up the turn, or lose.'
            : slot === null
              ? 'Choose the slot you want to replace.'
              : `Now pick a letter for slot ${slot + 1}.`)}
      </p>

      ${pendingWildcard
        ? html`<div class="confirm-wildcard" role="group" aria-label="Confirm wildcard">
            <button type="button" class="big" onClick=${() => attempt(pendingWildcard)}>
              Spend wildcard on ${pendingWildcard.toUpperCase()}
            </button>
            <button
              type="button"
              class="secondary"
              onClick=${() => update({ pendingWildcard: null, message: '' })}
            >
              Cancel
            </button>
          </div>`
        : null}

      ${over
        ? html`<div class="outcome">
            <h2>${game.players[game.outcome.winner].name} wins</h2>
            <p>${outcomeLine}</p>
            <button type="button" class="big" onClick=${onRematch}>Rematch</button>
            <button type="button" class="secondary" onClick=${onExit}>Back to lobby</button>
          </div>`
        : null}

      <!-- Nothing to hand over until you have actually moved. -->
      ${shareUrl && (youAre === null || locked || over)
        ? html`<${Share} url=${shareUrl} waitingFor=${current.name} over=${over} />`
        : null}

      <!--
        Racks stay in seat order rather than moving the player on turn to the
        front: a rack that jumps sides every move is hard to read, and in a live
        game "your side" must stay put.
      -->
      <div class="racks">
        ${game.players.map(
          (player, seat) => html`
            <${Rack}
              player=${player}
              seat=${seat}
              isYou=${youAre === seat}
              onTurn=${!over && game.turn === seat}
              label=${`${player.name}${game.turn === seat && !over ? ' (on turn)' : ''}`}
              interactive=${!over && !locked && game.turn === seat}
              onPlay=${attempt}
            />
          `,
        )}
      </div>

      <section class="history" aria-label="Move history">
        <h3>Moves</h3>
        ${game.history.length === 0
          ? html`<p class="muted">
              Opening word: <strong>${game.startWord.toUpperCase()}</strong>
            </p>`
          : html`<ol class="move-list" reversed>
              ${[...game.history].reverse().map(
                (move) => html`<li>
                  <strong>${move.to.toUpperCase()}</strong>
                  <span class="muted">${describeMove(game, move)}</span>
                  <${InlineDefinition} word=${move.to} />
                </li>`,
              )}
            </ol>`}
      </section>

      ${over || locked
        ? null
        : html`<div class="board-actions">
            ${confirmSkip
              ? html`<span class="confirm" role="group" aria-label="Confirm giving up the turn">
                  <button
                    type="button"
                    class="danger"
                    onClick=${() => {
                      setConfirmSkip(false);
                      onSkip();
                    }}
                  >
                    ${`Give up the turn — costs ${skipTarget.name} and ${game.players[1 - skipSeat].name} the letter`}
                  </button>
                  <button type="button" class="secondary" onClick=${() => setConfirmSkip(false)}>
                    Keep thinking
                  </button>
                </span>`
              : html`<button
                  type="button"
                  class="secondary"
                  disabled=${!skipAvailable}
                  onClick=${() => setConfirmSkip(true)}
                >
                  ${skipsRemaining > 0
                    ? `Give up turn (${skipsRemaining} left)`
                    : 'No skips left'}
                </button>`}
            ${confirmResign
              ? html`<span class="confirm" role="group" aria-label="Confirm resignation">
                  <button
                    type="button"
                    class="danger"
                    onClick=${() => {
                      setConfirmResign(false);
                      onResign(youAre === null ? game.turn : youAre);
                    }}
                  >
                    ${game.players[youAre === null ? game.turn : youAre].name} resigns
                  </button>
                  <button
                    type="button"
                    class="secondary"
                    onClick=${() => setConfirmResign(false)}
                  >
                    Keep playing
                  </button>
                </span>`
              : html`<button
                  type="button"
                  class="secondary outline"
                  onClick=${() => setConfirmResign(true)}
                >
                  Resign
                </button>`}
            <button type="button" class="secondary outline" onClick=${onExit}>Leave</button>
          </div>`}
    </div>
  `;
}
