import { html } from '../../vendor/preact-standalone.module.js';
import {
  CARDS_PER_PLAYER,
  LETTERS,
  SKIPS_PER_PLAYER,
  WILDCARDS_PER_PLAYER,
  WORD_LEN,
} from '../game.js';
import { WORDS } from '../words.js';

// htm trims the whitespace where a text node meets a ${} expression, so any
// sentence that interpolates a number is built as one string rather than split
// across lines — otherwise it renders as "You hold26 letter cards".
const RULES = [
  `The board starts on a random ${WORD_LEN}-letter word. Players alternate turns.`,
  `A turn is one substitution: pick a slot, put a different letter in it, and the result must be a ${WORD_LEN}-letter dictionary word.`,
  'No word may appear twice in the same game.',
  `The letter you place is a card, and it is spent. You hold ${LETTERS.length} letter cards plus ${WILDCARDS_PER_PLAYER} wildcard — ${CARDS_PER_PLAYER} in total.`,
  'The wildcard lets you replay one letter you have already spent. The result still has to be a real word. You get one, ever.',
  `Stuck? Give up the turn. A bot plays the next available word for you, and the letter it uses is struck off BOTH racks. You get ${SKIPS_PER_PLAYER} of these.`,
  'You lose when you have no legal move and no skips left.',
];

export function Rules({ open = false }) {
  return html`
    <details class="rules" open=${open}>
      <summary>How to play</summary>
      <ol>
        ${RULES.map((rule) => html`<li>${rule}</li>`)}
      </ol>
      <p>
        <small>
          ${`Dictionary: ${WORDS.length.toLocaleString()} four-letter SOWPODS words, bundled with the page. Definitions are shown as you play, so the obscure ones teach you something.`}
        </small>
      </p>
    </details>
  `;
}
