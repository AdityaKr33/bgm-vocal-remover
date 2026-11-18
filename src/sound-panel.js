// The player's Sound panel: the ready-made styles from sound.js as cards to tap through, and a slider per control
// to fine-tune. Every change goes straight to the live remover's engine, so the music changes while you listen.
import { paintRange } from './range.js';
import { CONTROLS, SPACE, STYLES, soundValues, styleFor } from './sound.js';

const ALL = [...CONTROLS, SPACE];

const make = (tag, props) => Object.assign(document.createElement(tag), props);

/** `dialog` holds the panel, `opener` opens it, `label` names the style on; `onChange(values)` hears every change. */
export function soundPanel({ dialog, opener, label, values, onChange }) {
  let current = soundValues(values);
  const cards = dialog.querySelector('.sound-styles');
  const sliders = dialog.querySelector('.sound-sliders');

  for (const style of STYLES) {
    const card = make('button', { type: 'button', className: 'sound-style' });
    card.dataset.style = style.id;
    card.append(make('b', { textContent: style.name }), make('span', { textContent: style.what }));
    card.addEventListener('click', () => set(style.values));
    cards.append(card);
  }

  const inputs = {};
  for (const control of ALL) {
    const input = make('input', { type: 'range', min: control.min, max: control.max, step: control === SPACE ? 5 : 1 });
    input.setAttribute('aria-label', control.label);
    const output = make('output');
    const row = make('label', { className: 'sound-control' });
    row.append(make('span', { className: 'name', textContent: control.label }), output, make('span', { className: 'what', textContent: control.what }), input);
    input.addEventListener('input', () => set({ ...current, [control.id]: Number(input.value) }));
    inputs[control.id] = { input, output };
    sliders.append(row);
  }

  dialog.querySelector('[data-reset]').addEventListener('click', () => set(STYLES[0].values));
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => event.target === dialog && dialog.close()); // a click on the backdrop
  opener.addEventListener('click', () => dialog.showModal());

  function set(next) {
    current = soundValues(next);
    show();
    onChange(current);
  }

  function show() {
    const on = styleFor(current);
    label.textContent = STYLES.find((style) => style.id === on)?.name ?? 'Custom';
    for (const card of cards.children) card.setAttribute('aria-pressed', String(card.dataset.style === on));
    for (const control of ALL) {
      const { input, output } = inputs[control.id];
      const value = current[control.id];
      if (document.activeElement !== input) input.value = value;
      output.textContent = control === SPACE ? `${value} %` : value > 0 ? `+${value} dB` : value < 0 ? `−${-value} dB` : '0 dB';
      paintRange(input);
    }
  }

  show();
}
