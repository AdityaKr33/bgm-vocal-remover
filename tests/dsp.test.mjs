import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VocalRemover } from '../src/dsp-core.js';

const SR = 48000;

/** Sum of sine partials; gainL/gainR place each one in the stereo field. */
function mix(seconds, partials) {
  const length = Math.round(seconds * SR);
  const L = new Float32Array(length);
  const R = new Float32Array(length);
  for (const { freq, amp, gainL, gainR } of partials) {
    const step = (2 * Math.PI * freq) / SR;
    for (let i = 0; i < length; i++) {
      const s = amp * Math.sin(step * i);
      L[i] += s * gainL;
      R[i] += s * gainR;
    }
  }
  return { L, R };
}

/** Feeds the engine in 128-sample blocks, like an AudioWorklet does. */
function run(engine, { L, R }, block = 128) {
  const out = { L: new Float32Array(L.length), R: new Float32Array(R.length) };
  for (let i = 0; i < L.length; i += block) {
    const end = Math.min(i + block, L.length);
    engine.process(L.subarray(i, end), R.subarray(i, end), out.L.subarray(i, end), out.R.subarray(i, end));
  }
  return out;
}

/** Amplitude of one sine component (Hann-windowed single-bin DFT over the third second). */
function amplitude(signal, freq, from = 2 * SR, length = SR) {
  let re = 0, im = 0, weight = 0;
  for (let i = 0; i < length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
    const phase = (2 * Math.PI * freq * (from + i)) / SR;
    re += signal[from + i] * w * Math.cos(phase);
    im -= signal[from + i] * w * Math.sin(phase);
    weight += w;
  }
  return (2 * Math.hypot(re, im)) / weight;
}

const lossDb = (input, output, freq) => 20 * Math.log10(amplitude(input, freq) / amplitude(output, freq));
const partials = (freqs, amp, gainL, gainR) => freqs.map((freq, i) => ({ freq, amp: amp / (i + 1), gainL, gainR }));

/** A snare (body tone plus noise below ~3 kHz) twice a second, dead centre like most drums. */
function snareHits(seconds) {
  const hits = new Float32Array(Math.round(seconds * SR));
  let seed = 11;
  const noise = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 31 - 1;
  for (let at = 0.25; at < seconds; at += 0.5) {
    const start = Math.round(at * SR);
    let low = 0;
    for (let i = 0; i < 0.2 * SR && start + i < hits.length; i++) {
      low += 0.35 * (noise() - low);
      hits[start + i] = (0.9 * low + 0.25 * Math.sin((2 * Math.PI * 190 * i) / SR)) * Math.exp(-i / SR / 0.06);
    }
  }
  return hits;
}

/** Energy in the first 60 ms of the hits between 1 and 3 s (`delay`: samples the signal lags by). */
function hitEnergy(signal, delay = 0) {
  let energy = 0;
  for (let at = 1.25; at < 2.8; at += 0.5) {
    const start = Math.round(at * SR) + delay;
    for (let i = 0; i < 0.06 * SR; i++) energy += signal[start + i] ** 2;
  }
  return energy;
}

const VOCAL = partials([300, 600, 900, 1200, 1500], 0.12, 1, 1); // dead centre
const GUITAR = partials([450, 750, 1050, 1350], 0.1, 1, 0); // hard left
const KEYS = partials([375, 825, 1275, 1725], 0.1, 0.309, 0.951); // 60 % right (equal-power pan)
const BASS = partials([55, 110], 0.2, 1, 1); // centre, but below the vocal band

test('is transparent when strength is 0', () => {
  const engine = new VocalRemover(SR);
  engine.setParams({ strength: 0 });
  let seed = 7;
  const noise = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 31 - 1;
  const input = { L: Float32Array.from({ length: SR }, noise), R: Float32Array.from({ length: SR }, noise) };
  const output = run(engine, input);
  const d = engine.latency;
  let worst = 0;
  for (let i = d; i < SR; i++) {
    worst = Math.max(worst, Math.abs(output.L[i] - input.L[i - d]), Math.abs(output.R[i] - input.R[i - d]));
  }
  assert.ok(worst < 1e-5, `reconstruction error ${worst}`);
});

test('removes a centred vocal but keeps panned instruments and the bass', () => {
  const input = mix(3, [...VOCAL, ...GUITAR, ...KEYS, ...BASS]);
  const engine = new VocalRemover(SR);
  engine.setParams({ strength: 1, reach: 0.5 });
  const output = run(engine, input);
  for (const { freq } of VOCAL) {
    for (const ch of ['L', 'R']) {
      const loss = lossDb(input[ch], output[ch], freq);
      assert.ok(loss > 20, `vocal ${freq} Hz (${ch}) only ${loss.toFixed(1)} dB quieter`);
    }
  }
  for (const { freq } of GUITAR) {
    const loss = lossDb(input.L, output.L, freq);
    assert.ok(Math.abs(loss) < 1.5, `guitar ${freq} Hz changed by ${loss.toFixed(2)} dB`);
  }
  for (const { freq } of KEYS) {
    for (const ch of ['L', 'R']) {
      const loss = lossDb(input[ch], output[ch], freq);
      assert.ok(Math.abs(loss) < 1.5, `keys ${freq} Hz (${ch}) changed by ${loss.toFixed(2)} dB`);
    }
  }
  for (const { freq } of BASS) {
    const loss = lossDb(input.L, output.L, freq);
    assert.ok(Math.abs(loss) < 0.5, `bass ${freq} Hz changed by ${loss.toFixed(2)} dB`);
  }
});

test('keeps centred drum hits while still removing a centred voice', () => {
  const hits = snareHits(3);
  const voice = mix(3, VOCAL);
  const guitar = mix(3, GUITAR); // hard left, so the song is stereo
  const remover = () => {
    const engine = new VocalRemover(SR);
    engine.setParams({ strength: 1, reach: 0.5 });
    return engine;
  };

  const drumsOnly = remover();
  const out = run(drumsOnly, { L: guitar.L.map((v, i) => v + hits[i]), R: hits });
  const kept = 10 * Math.log10(hitEnergy(out.R, drumsOnly.latency) / hitEnergy(hits));
  assert.ok(kept > -6, `the snare lost ${(-kept).toFixed(1)} dB`);

  const both = run(remover(), { L: voice.L.map((v, i) => v + guitar.L[i] + hits[i]), R: voice.R.map((v, i) => v + hits[i]) });
  for (const { freq } of VOCAL) {
    const loss = lossDb(voice.R, both.R, freq);
    assert.ok(loss > 25, `with drums playing, vocal ${freq} Hz only ${loss.toFixed(1)} dB quieter`);
  }
});

test('leaves mono recordings untouched instead of hollowing them out', () => {
  const mono = [...VOCAL, ...GUITAR].map((p) => ({ ...p, gainL: 1, gainR: 1 }));
  const input = mix(3, mono);
  const engine = new VocalRemover(SR);
  engine.setParams({ strength: 1 });
  const output = run(engine, input);
  assert.equal(engine.isMono, true);
  for (const { freq } of mono) {
    const loss = lossDb(input.L, output.L, freq);
    assert.ok(Math.abs(loss) < 0.5, `${freq} Hz changed by ${loss.toFixed(2)} dB`);
  }
});

test('runs far faster than real time', () => {
  const input = mix(10, [...VOCAL, ...GUITAR]);
  // The fastest of three runs: the test runner runs files in parallel, and a busy CPU only slows a run down.
  let fastest = Infinity;
  for (let i = 0; i < 3; i++) {
    const engine = new VocalRemover(SR);
    const started = performance.now();
    run(engine, input);
    fastest = Math.min(fastest, performance.now() - started);
  }
  // Alone it runs about 26× real time. 10× still leaves a slow laptop's audio thread plenty of headroom
  // (each 21 ms frame must finish well inside 21 ms), and fails if the remover ever gets twice as slow.
  const speed = 10 / (fastest / 1000);
  assert.ok(speed > 10, `only ${speed.toFixed(1)}× real time`);
});
