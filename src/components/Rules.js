import { html } from '../../vendor/preact-standalone.module.js';
import {
  CARDS_PER_PLAYER,
  LETTERS,
  PASS_LEAD_TO_WIN,
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
  `Do not know a word? Pass. A bot plays one for you, using a letter one of you still holds — never a wildcard — and that letter is struck off BOTH racks. You get ${SKIPS_PER_PLAYER} passes.`,
  `Passing hands a point to your opponent. Go ${PASS_LEAD_TO_WIN} clear passes behind and you lose, however many words are left.`,
  'The board says how many words you can play without your wildcard. At zero, the wildcard is the only way on — the hint button will show you a move, and warns when it costs the wildcard.',
  'You also lose if no word at all is left to you, wildcard included.',
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
