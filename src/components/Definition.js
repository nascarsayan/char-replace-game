import { html, useEffect, useState } from '../../vendor/preact-standalone.module.js';
import { define, loadDefinitions, onDefinitionsReady } from '../definitions.js';

/** Re-renders once the definition file has loaded. */
export function useDefinitions() {
  const [, bump] = useState(0);
  useEffect(() => {
    loadDefinitions();
    return onDefinitionsReady(() => bump((n) => n + 1));
  }, []);
}

/** The gloss for the word currently on the board. */
export function Definition({ word }) {
  const gloss = define(word);
  return html`
    <p class="definition" aria-live="polite">
      <strong>${word.toUpperCase()}</strong>
      ${gloss === undefined
        ? html`<span class="muted"> — looking it up…</span>`
        : gloss
          ? html`<span> — ${gloss}</span>`
          : html`<span class="muted"> — no definition bundled for this one</span>`}
    </p>
  `;
}

/** Compact inline gloss, used in the move list. */
export function InlineDefinition({ word }) {
  const gloss = define(word);
  if (!gloss) return null;
  return html`<span class="move-gloss">${gloss}</span>`;
}
