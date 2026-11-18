// The Sound panel's tone controls and ready-made styles (src/sound.js): every style stays inside the controls'
// ranges, boosts get headroom so they can't clip, and the engine's chain is wired as the controls promise.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTROLS, FLAT, SPACE, STYLES, headroomDb, soundChain, soundValues, styleFor } from '../src/sound.js';

test('there are plenty of styles to try, each named and explained in plain words', () => {
  assert.ok(STYLES.length >= 10, `only ${STYLES.length} styles`);
  assert.equal(STYLES[0].id, 'flat');
  assert.deepEqual(STYLES[0].values, FLAT);
  assert.equal(new Set(STYLES.map((s) => s.id)).size, STYLES.length);
  assert.equal(new Set(STYLES.map((s) => s.name)).size, STYLES.length);
  for (const style of STYLES) {
    assert.ok(style.what.length >= 12 && style.what.length <= 70, `${style.id}: "${style.what}"`);
    assert.deepEqual(Object.keys(style.values).sort(), Object.keys(FLAT).sort(), `${style.id} sets every control`);
    for (const control of [...CONTROLS, SPACE]) {
      const value = style.values[control.id];
      assert.ok(value >= control.min && value <= control.max, `${style.id}: ${control.id} ${value} is outside ${control.min}..${control.max}`);
    }
  }
  // no two styles sound the same
  assert.equal(new Set(STYLES.map((s) => JSON.stringify(s.values))).size, STYLES.length);
});

test('values are tidied: out-of-range numbers clamp, missing or broken ones fall back to flat', () => {
  assert.deepEqual(soundValues(undefined), FLAT);
  assert.deepEqual(soundValues({ bass: 40, treble: -99, space: 'wide', warmth: 3, extra: 5 }), { ...FLAT, bass: 12, treble: -12, warmth: 3 });
});

test('boosting gives the sound headroom, so a loud song can not clip; cutting needs none', () => {
  assert.equal(headroomDb(FLAT), 0);
  assert.equal(headroomDb({ ...FLAT, bass: -6, treble: -6 }), 0);
  assert.equal(headroomDb({ ...FLAT, bass: 8 }), -4);
  assert.ok(headroomDb({ ...FLAT, space: 200 }) < 0, 'a wider stereo image can peak higher too');
  for (const style of STYLES) assert.ok(headroomDb(style.values) <= 0);
});

test('the panel knows which style is on, or that the listener made their own', () => {
  for (const style of STYLES) assert.equal(styleFor(style.values), style.id);
  assert.equal(styleFor({ ...FLAT, bass: 1 }), 'custom');
});

/** A stand-in for the browser's AudioContext: nodes that remember their settings and connections. */
function fakeContext() {
  const param = (value) => ({ value, setTargetAtTime(v) { this.value = v; } });
  const node = (extra) => ({ links: [], connect(target, out = 0, input = 0) { this.links.push({ target, out, input }); return target; }, ...extra });
  return {
    currentTime: 0,
    createGain: () => node({ gain: param(1) }),
    createBiquadFilter: () => node({ type: 'peaking', frequency: param(350), Q: param(1), gain: param(0) }),
    createChannelSplitter: () => node({}),
    createChannelMerger: () => node({}),
    createDynamicsCompressor: () => node({ threshold: param(-24), knee: param(30), ratio: param(12), attack: param(0.003), release: param(0.25) }),
  };
}

test('the engine chain: one filter per tone control at its frequency, then stereo width, then a safety limiter', () => {
  const chain = soundChain(fakeContext());
  const filters = [];
  for (let at = chain.input.links[0].target; at.type; at = at.links[0].target) filters.push(at);
  assert.deepEqual(filters.map((f) => [f.type, f.frequency.value]), CONTROLS.map((c) => [c.type, c.frequency]));
  const bassBoost = STYLES.find((s) => s.id === 'bass-boost').values;
  chain.set(bassBoost);
  CONTROLS.forEach((c, i) => assert.equal(filters[i].gain.value, bassBoost[c.id]));
  assert.ok(Math.abs(chain.input.gain.value - 10 ** (headroomDb(bassBoost) / 20)) < 1e-9, 'headroom applied');
  assert.ok(chain.limiter.threshold.value <= -0.5 && chain.limiter.ratio.value >= 10, 'the limiter only catches peaks');
});

test('the limiter’s built-in makeup gain is undone, so Flat is exactly as recorded', () => {
  // Web Audio's compressor always adds makeup gain: 0.6 x how far its curve pulls full scale down (in Chrome, a
  // -1 dB / 20:1 limiter made every flat song 0.6 dB louder and let a +12 dB bass peak reach 1.011)
  const chain = soundChain(fakeContext());
  const { threshold, ratio } = chain.limiter;
  const makeupDb = -0.6 * (threshold.value - threshold.value / ratio.value);
  assert.ok(makeupDb > 0);
  assert.ok(Math.abs(chain.output.gain.value - 10 ** (-makeupDb / 20)) < 1e-9, `trim ${chain.output.gain.value}`);
});

test('Space spreads the music: 100 % leaves it as it is, 0 % is mono, 200 % is twice as wide', () => {
  const chain = soundChain(fakeContext());
  const { same, cross } = chain.width; // left out = same·left + cross·right (and mirrored for the right)
  chain.set({ ...FLAT, space: 100 });
  assert.deepEqual([same.gain.value, cross.gain.value], [1, 0]);
  chain.set({ ...FLAT, space: 0 });
  assert.deepEqual([same.gain.value, cross.gain.value], [0.5, 0.5]);
  chain.set({ ...FLAT, space: 200 });
  assert.deepEqual([same.gain.value, cross.gain.value], [1.5, -0.5]);
});
