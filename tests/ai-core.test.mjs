// FFT, resampler and streaming separator: the AI engine's pure-JS parts, tested with fake models.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FFT } from '../src/fft.js';
import { Resampler } from '../src/resampler.js';
import { StreamingSeparator } from '../src/separator.js';

let seed = 1;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 31 - 1;

/** Amplitude of one sine component (Hann-windowed single-bin DFT). */
function amplitude(signal, freq, rate, from, length) {
  let re = 0, im = 0, weight = 0;
  for (let i = 0; i < length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
    const phase = (2 * Math.PI * freq * (from + i)) / rate;
    re += signal[from + i] * w * Math.cos(phase);
    im -= signal[from + i] * w * Math.sin(phase);
    weight += w;
  }
  return (2 * Math.hypot(re, im)) / weight;
}

function tones(rate, seconds, parts) {
  const n = Math.round(rate * seconds);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (const { freq, left, right } of parts) {
    for (let i = 0; i < n; i++) {
      const s = Math.sin((2 * Math.PI * freq * i) / rate);
      L[i] += left * s;
      R[i] += right * s;
    }
  }
  return { L, R };
}

const join = (parts) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

test('FFT matches a direct DFT for power-of-two and MDX sizes', () => {
  for (const n of [8, 4096, 6144, 7680]) {
    const re = Float64Array.from({ length: n }, random);
    const im = Float64Array.from({ length: n }, random);
    const [xr, xi] = [Float64Array.from(re), Float64Array.from(im)];
    new FFT(n).transform(xr, xi);
    for (const k of [0, 1, 7, n >> 1, n - 3]) {
      let sr = 0, si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += re[t] * Math.cos(a) - im[t] * Math.sin(a);
        si += re[t] * Math.sin(a) + im[t] * Math.cos(a);
      }
      assert.ok(Math.hypot(xr[k] - sr, xi[k] - si) < 1e-8 * n, `n=${n} bin ${k}`);
    }
    const fft = new FFT(n);
    fft.transform(xr, xi, true);
    for (let t = 0; t < n; t++) assert.ok(Math.abs(xr[t] / n - re[t]) < 1e-10 && Math.abs(xi[t] / n - im[t]) < 1e-10, `n=${n} round trip`);
  }
});

test('resampler keeps level and pitch, and a 48k → 44.1k → 48k round trip is clean', () => {
  const input = tones(48000, 2, [{ freq: 1000, left: 0.5, right: 0.25 }, { freq: 9000, left: 0.2, right: 0.2 }]);
  const down = new Resampler(48000, 44100);
  const parts = { L: [], R: [] };
  for (let i = 0; i < input.L.length; i += 777) {
    const [l, r] = down.process([input.L.subarray(i, i + 777), input.R.subarray(i, i + 777)]);
    parts.L.push(l);
    parts.R.push(r);
  }
  const mid = { L: join(parts.L), R: join(parts.R) };
  assert.ok(Math.abs(amplitude(mid.L, 1000, 44100, 20000, 44100) - 0.5) < 0.005);
  assert.ok(Math.abs(amplitude(mid.R, 1000, 44100, 20000, 44100) - 0.25) < 0.003);

  const [backL] = new Resampler(44100, 48000).process([mid.L, mid.R]);
  let err = 0, sig = 0;
  for (let i = 4800; i < backL.length - 4800; i++) {
    err += (backL[i] - input.L[i]) ** 2;
    sig += input.L[i] ** 2;
  }
  const snr = 10 * Math.log10(sig / err);
  assert.ok(snr > 50, `round-trip SNR only ${snr.toFixed(1)} dB`);
});

test('the round trip around the model keeps the top octave: flat to 20 kHz, with no audible aliasing', () => {
  // cymbals and the air of a recording live up here; a short filter dulled 20 kHz by 2.8 dB and left junk at -37 dB
  const rate = 48000;
  for (const freq of [18000, 20000]) {
    const input = Float32Array.from({ length: rate * 2 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * freq * i) / rate));
    const down = new Resampler(48000, 44100);
    const up = new Resampler(44100, 48000);
    const parts = [];
    for (let i = 0; i < input.length; i += 1024) {
      const [mid] = down.process([input.subarray(i, i + 1024), input.subarray(i, i + 1024)]);
      if (mid.length) parts.push(up.process([mid, mid])[0]);
    }
    const back = join(parts);
    const from = 20000, to = Math.min(back.length, input.length) - 20000;
    let c = 0, q = 0;
    for (let i = from; i < to; i++) {
      c += back[i] * Math.cos((2 * Math.PI * freq * i) / rate);
      q += back[i] * Math.sin((2 * Math.PI * freq * i) / rate);
    }
    c *= 2 / (to - from);
    q *= 2 / (to - from);
    const levelDb = 20 * Math.log10(Math.hypot(c, q) / 0.5);
    let junk = 0, kept = 0;
    for (let i = from; i < to; i++) {
      const fit = c * Math.cos((2 * Math.PI * freq * i) / rate) + q * Math.sin((2 * Math.PI * freq * i) / rate);
      junk += (back[i] - fit) ** 2;
      kept += fit ** 2;
    }
    const junkDb = 10 * Math.log10(junk / kept);
    assert.ok(levelDb > -0.5, `${freq} Hz comes back ${levelDb.toFixed(1)} dB`);
    assert.ok(junkDb < -50, `${freq} Hz leaves junk at ${junkDb.toFixed(0)} dB`);
  }
});

/** Runs a separator over `input`, feeding it in blocks; returns the joined output. */
async function separate(input, { nFft = 6144, strength = 1, model = async (x) => Float32Array.from(x), stepFrames = 8 } = {}) {
  const out = { L: [], R: [] };
  let runs = 0;
  const separator = new StreamingSeparator({
    nFft,
    stepFrames,
    contextFrames: 12,
    runModel: (x) => model(x, ++runs),
    onOutput: (l, r) => {
      out.L.push(Float32Array.from(l));
      out.R.push(Float32Array.from(r));
    },
  });
  separator.setStrength(strength);
  for (let i = 0; i < input.L.length; i += 2048) {
    separator.push(input.L.subarray(i, i + 2048), input.R.subarray(i, i + 2048));
    await separator.idle();
  }
  return { L: join(out.L), R: join(out.R), runs };
}

const MIX = tones(44100, 5, [
  { freq: 300, left: 0.3, right: 0.1 },
  { freq: 1000, left: 0.2, right: 0.2 },
  { freq: 2500, left: 0.05, right: 0.25 },
]);

function maxError(a, b, length) {
  let worst = 0;
  for (let i = 0; i < length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}

test('separator passes audio through untouched (no model) when strength is 0', async () => {
  const out = await separate(MIX, { strength: 0 });
  assert.equal(out.runs, 0);
  assert.ok(out.L.length > 3 * 44100, `only ${out.L.length} samples out`);
  assert.ok(maxError(out.L, MIX.L, out.L.length) < 1e-5 && maxError(out.R, MIX.R, out.R.length) < 1e-5);
});

test('separator feeds the model the right window and rebuilds its output exactly (6144 and 7680)', async () => {
  for (const nFft of [6144, 7680]) {
    const out = await separate(MIX, { nFft }); // identity model: "everything is music"
    assert.ok(out.runs > 10);
    // Skip the first 0.2 s: the tones switch on abruptly there, and that click has energy in the
    // three lowest bins, which (like UVR) are zeroed before the model.
    const from = 8192;
    const err = Math.max(
      maxError(out.L.subarray(from), MIX.L.subarray(from), out.L.length - from),
      maxError(out.R.subarray(from), MIX.R.subarray(from), out.R.length - from),
    );
    assert.ok(err < 1e-3, `nFft ${nFft}: error ${err}`);
  }
});

test('separator removes what the model says is not music', async () => {
  // A fake model that calls everything around 1 kHz "vocals" (bins 132–147 at 6144 / 44.1 kHz).
  const killBand = async (x) => {
    const y = Float32Array.from(x);
    for (let c = 0; c < 4; c++) y.fill(0, (c * 3072 + 132) * 256, (c * 3072 + 148) * 256);
    return y;
  };
  const out = await separate(MIX, { model: killBand });
  const db = (freq, ch) => 20 * Math.log10(amplitude(MIX[ch], freq, 44100, 44100, 88200) / amplitude(out[ch], freq, 44100, 44100, 88200));
  assert.ok(db(1000, 'L') > 30 && db(1000, 'R') > 30, `1 kHz only ${db(1000, 'L').toFixed(1)} dB lower`);
  for (const freq of [300, 2500]) assert.ok(Math.abs(db(freq, 'L')) < 0.2 && Math.abs(db(freq, 'R')) < 0.2, `${freq} Hz changed`);
});

test('separator cross-fades between model runs instead of clicking', async () => {
  const flicker = async (x, run) => (run % 2 ? x.map((v) => v * 0.25) : Float32Array.from(x)); // output jumps every run
  const sine = tones(44100, 4, [{ freq: 300, left: 0.3, right: 0.3 }]);
  const out = await separate(sine, { model: flicker });
  const steepest = (s, n) => {
    let worst = 0;
    for (let i = 1; i < n; i++) worst = Math.max(worst, Math.abs(s[i] - s[i - 1]));
    return worst;
  };
  assert.ok(steepest(out.L, out.L.length) < 1.5 * steepest(sine.L, sine.L.length));
});

test('separator bookkeeping runs far faster than real time', async () => {
  const long = tones(44100, 20, [{ freq: 440, left: 0.3, right: 0.3 }]);
  const started = performance.now();
  await separate(long, { stepFrames: 24, model: async (x) => x });
  const speed = 20 / ((performance.now() - started) / 1000);
  assert.ok(speed > 5, `only ${speed.toFixed(1)}× real time`); // JS work only; the model runs on the GPU
});

test('AI pipeline at 48 kHz keeps the timeline through both resamplers (identity model)', async () => {
  const { AiPipeline } = await import('../src/ai-pipeline.js');
  const { MODEL } = await import('../src/ai-model.js');
  const input = tones(48000, 4, [{ freq: 440, left: 0.3, right: 0.1 }, { freq: 3000, left: 0.1, right: 0.3 }]);
  const out = { L: [], R: [] };
  const pipeline = new AiPipeline({
    deviceRate: 48000,
    model: { ...MODEL, compensate: 1 },
    stepFrames: 16,
    runModel: async (x) => x,
    onOutput: (l, r) => {
      out.L.push(Float32Array.from(l));
      out.R.push(Float32Array.from(r));
    },
  });
  pipeline.setStrength(1);
  for (let i = 0; i < input.L.length; i += 2048) {
    pipeline.push(input.L.subarray(i, i + 2048), input.R.subarray(i, i + 2048));
    await pipeline.idle();
  }
  const L = join(out.L);
  assert.ok(L.length > 2.5 * 48000, `only ${L.length} samples out`);
  let err = 0, sig = 0;
  for (let i = 24000; i < L.length - 2000; i++) {
    err += (L[i] - input.L[i]) ** 2;
    sig += input.L[i] ** 2;
  }
  const snr = 10 * Math.log10(sig / err);
  assert.ok(snr > 45, `SNR only ${snr.toFixed(1)} dB`);
});

test('running the model less often (cooler GPU) gives the same result with a third of the runs', async () => {
  // engine.js spaces runs RUN_SPACING (3) times one run's length apart: about 39 frames for a 0.3 s run, where it was
  // about 13 frames at 1.3 times; 96 frames is the most it ever uses
  const killBand = async (x) => {
    const y = Float32Array.from(x);
    for (let c = 0; c < 4; c++) y.fill(0, (c * 3072 + 132) * 256, (c * 3072 + 148) * 256);
    return y;
  };
  const before = await separate(MIX, { model: killBand, stepFrames: 13 });
  for (const stepFrames of [39, 96]) {
    const after = await separate(MIX, { model: killBand, stepFrames });
    assert.ok(after.runs * 2.5 < before.runs, `${stepFrames} frames: ${after.runs} runs against ${before.runs}`);
    const from = 8192;
    const length = Math.min(before.L.length, after.L.length) - from;
    assert.ok(length > 2 * 44100, `${stepFrames} frames: only ${length} samples to compare`);
    const err = Math.max(
      maxError(after.L.subarray(from), before.L.subarray(from), length),
      maxError(after.R.subarray(from), before.R.subarray(from), length),
    );
    assert.ok(err < 1e-3, `${stepFrames} frames: output differs by ${err}`);
  }
});

test('the model runs often enough to keep the delay short, whatever the GPU, and rests when it can', async () => {
  const { stepFramesFor } = await import('../src/ai-pipeline.js');
  const { MODEL } = await import('../src/ai-model.js');
  const seconds = (frames) => (frames * MODEL.hop) / MODEL.sampleRate;
  for (const runMs of [150, 300, 450, 600, 900, 1500]) {
    const step = seconds(stepFramesFor(runMs, MODEL));
    assert.ok(step >= (runMs / 1000) * 1.3 - 0.001, `${runMs} ms runs: a step of ${step.toFixed(2)} s can't keep up`);
    // the step (and with it the delay) stays short unless the GPU itself is too slow for that
    if (runMs <= 450) assert.ok(step <= 0.62, `${runMs} ms runs: a step of ${step.toFixed(2)} s makes the sound lag`);
  }
  // a fast GPU rests between runs: busy at most about half the time
  assert.ok(0.3 / seconds(stepFramesFor(300, MODEL)) <= 0.55);
});

test('playback starts with enough head start to ride out a slow model run, more on a slower GPU', async () => {
  const { startMarginFor } = await import('../src/ai-pipeline.js');
  assert.equal(startMarginFor(150), 0.12); // a fast GPU keeps the short delay
  assert.ok(startMarginFor(300) >= 0.12 && startMarginFor(300) <= 0.2);
  // measured on an RTX 4050 running hot: runs of ~600 ms came back up to ~270 ms slower than the first
  assert.ok(startMarginFor(600) >= 0.28, `only ${startMarginFor(600)} s for 600 ms runs`);
  assert.equal(startMarginFor(3000), 0.5); // never more than half a second on top of the delay
});

test('the pace is planned from the slowest of several warm-up runs, not one lucky fast one', async () => {
  const { slowestRunMs } = await import('../src/ai-pipeline.js');
  const delays = [15, 60, 25];
  let call = 0;
  const run = () => new Promise((resolve) => setTimeout(resolve, delays[call++]));
  const ms = await slowestRunMs(run, 3);
  assert.equal(call, 3);
  assert.ok(ms >= 55 && ms < 120, `${ms} ms`);
});
