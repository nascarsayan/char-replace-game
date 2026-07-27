import { html, useEffect, useState } from '../../vendor/preact-standalone.module.js';

/**
 * The baton. After a move it is the other player's turn, so this is the moment
 * to hand the position over — one link, sent however you like.
 */
export function Share({ url, waitingFor, over }) {
  const [copied, setCopied] = useState(false);

  // Reset the confirmation whenever the position changes.
  useEffect(() => {
    setCopied(false);
  }, [url]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access can be blocked; selecting the text is the fallback.
      const field = document.getElementById('share-url');
      if (field) field.select();
      setCopied(false);
    }
  }

  return html`
    <section class="share" aria-label="Share this game">
      <h3>
        ${over ? 'Final position' : `${waitingFor} is up — send them this link`}
      </h3>
      <div class="share-row">
        <input
          id="share-url"
          type="text"
          readonly
          value=${url}
          aria-label="Link to this position"
          onFocus=${(e) => e.target.select()}
        />
        <button type="button" onClick=${copy}>${copied ? 'Copied' : 'Copy link'}</button>
      </div>
      <p role="status">
        <small>
          ${copied
            ? 'Copied. Paste it to your opponent — opening it lets them play their turn.'
            : 'Whoever opens this link plays the side that is on turn.'}
        </small>
      </p>
    </section>
  `;
}
