/**
 * Real-time vocal remover for stereo music ("centre-channel suppression").
 *
 * Lead vocals are mixed dead-centre: the same level and phase in both speakers, while most
 * instruments are spread left/right. The audio is cut into overlapping FFT frames, and in every
 * frequency bin we measure how "centred" the sound is (equal level, coherent, in phase). Only that
 * centre component is subtracted — never more than the quieter channel holds — so side-panned
 * instruments survive. The bass/kick region and the top octave are protected, and so are drum hits:
 * the kick and snare sit in the centre too, but a hit is sudden and spread across many frequencies,
 * while a sung note is a few steady harmonics (harmonic–percussive separation with median filters).
 *
 * Plain JS without browser APIs: the same class runs in the AudioWorklet and in the Node tests.
 */

import { FFT } from './fft.js';

export const FFT_SIZE = 4096;

const STATS_SMOOTHING = 0.7; // memory of the per-bin cross-spectrum statistics (~70 ms)
const MASK_ATTACK = 0.6; // how fast removal kicks in when a vocal appears
const MASK_RELEASE = 0.25; // how fast it lets go (slower = less "warbling")
const STRENGTH_GLIDE = 0.5; // click-free fades when strength changes or the mono guard trips
const BASS_KEEP_HZ = 120; // below this nothing is removed (bass guitar, kick drum)
const BASS_FADE_HZ = 200; // full removal from here up
const AIR_FADE_START_HZ = 9000; // above this removal eases off to 40 % (cymbals, air)
const AIR_FADE_END_HZ = 16000;
const DRUM_HISTORY = 7; // frames (~150 ms) of a bin's past: a steady sound's level
const DRUM_SPREAD = 8; // bins either side (~±90 Hz): a broadband sound's level
const DRUM_STRIDE = 4; // that level changes slowly across bins: measure every 4th bin, interpolate between
const DRUM_FADE_START_HZ = 3500; // drum hits are kept up to here, then less and less…
const DRUM_FADE_END_HZ = 6000; // …so the voice's "s" and "t" sounds up here are still removed
const MONO_ON = 1e-3; // side/mid energy below -30 dB → recording is mono
const MONO_OFF = 3e-3; // ...back above about -25 dB → stereo again
const WARMUP_FRAMES = 4; // frames of fresh audio before the mono test is trusted

/**
 * Turns the popup's "Vocal removal" slider (0–100 %) into engine settings.
 *
 *   strength  0..1  share of the detected centre (vocal) signal that gets subtracted
 *   reach     0..1  how far from dead-centre a sound may sit and still count as "vocal"
 *                   0 → only perfectly centred sound: safest for instruments, more vocal left over
 *                   1 → also slightly off-centre sound: removes more vocal, but centre-ish
 *                       instruments (snare, piano, lead guitar) get thinner
 */
export function sliderToDspParams(percent) {
  const p = Math.min(100, Math.max(0, Number(percent) || 0)) / 100;
  // TODO(human): decide how the slider should feel. Right now it only scales `strength` and keeps
  // `reach` fixed at 0.5 — e.g. widen `reach` near the top of the slider for stubborn vocals.
  return { strength: p, reach: 0.5 };
}

export class VocalRemover {
  constructor(sampleRate, { fftSize = FFT_SIZE } = {}) {
    const n = fftSize;
    const hop = n / 4; // 75 % overlap
    const bins = n / 2 + 1;
    this.n = n;
    this.hop = hop;
    this.fft = new FFT(n);

    // Periodic Hann window for analysis and synthesis; the squared windows overlap-add to a constant.
    this.window = new Float64Array(n);
    for (let i = 0; i < n; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    let overlap = 0;
    for (let i = 0; i < n; i += hop) overlap += this.window[i] ** 2;
    this.gain = 1 / (overlap * n); // undoes that constant and the unscaled inverse FFT

    const buffer = (length) => new Float64Array(length);
    this.inL = buffer(n);
    this.inR = buffer(n);
    this.accL = buffer(n);
    this.accR = buffer(n);
    this.readyL = buffer(hop);
    this.readyR = buffer(hop);
    this.pos = 0;
    this.re = buffer(n);
    this.im = buffer(n);
    this.yr = buffer(n);
    this.yi = buffer(n);
    this.Lr = buffer(bins);
    this.Li = buffer(bins);
    this.Rr = buffer(bins);
    this.Ri = buffer(bins);
    this.pll = buffer(bins);
    this.prr = buffer(bins);
    this.plrRe = buffer(bins);
    this.plrIm = buffer(bins);
    this.centre = buffer(bins);
    this.mask = buffer(bins);
    this.mid = buffer(bins); // |L + R| this frame
    this.drum = buffer(bins); // 0..1: how much of the bin is a drum hit, kept instead of removed
    this.drumBins = Math.ceil((DRUM_FADE_END_HZ * n) / sampleRate); // drum hits are only looked for below this bin
    this.past = buffer(DRUM_HISTORY * this.drumBins); // the last frames' |L + R|, slot = frame mod DRUM_HISTORY
    this.slot = 0;
    this.sorted = buffer(2 * DRUM_SPREAD + 1);
    this.spread = buffer(Math.ceil(this.drumBins / DRUM_STRIDE) + 1); // broadband level at every DRUM_STRIDE-th bin

    // Frequency weighting: no removal in the bass, full in the vocal range, eased off in the air band.
    this.band = buffer(bins);
    this.drumBand = buffer(this.drumBins);
    for (let k = 0; k < bins; k++) {
      const hz = (k * sampleRate) / n;
      this.band[k] = smoothstep(BASS_KEEP_HZ, BASS_FADE_HZ, hz) * (1 - 0.6 * smoothstep(AIR_FADE_START_HZ, AIR_FADE_END_HZ, hz));
      if (k < this.drumBins) this.drumBand[k] = 1 - smoothstep(DRUM_FADE_START_HZ, DRUM_FADE_END_HZ, hz);
    }

    this.strength = 0; // current (gliding) value
    this.targetStrength = 1;
    this.setParams({ reach: 0.5 });

    this.frameMid = 0;
    this.frameSide = 0;
    this.monoMid = 0;
    this.monoSide = 0;
    this.freshFrames = 0;
    this.isMono = false;
    this.silence = 1e-9 * n * n; // spectral energy of roughly -80 dBFS
  }

  /** Delay between input and output, in samples. */
  get latency() {
    return this.n;
  }

  /** strength 0..1: share of the centre signal removed. reach 0..1: how far off-centre still counts as vocal. */
  setParams({ strength, reach } = {}) {
    if (Number.isFinite(strength)) this.targetStrength = clamp01(strength);
    if (Number.isFinite(reach)) {
      this.lo = 0.85 - 0.6 * clamp01(reach);
      this.hi = Math.min(1, this.lo + 0.3);
    }
  }

  /** Streams any number of samples; the output is delayed by `latency` samples. */
  process(inL, inR, outL, outR) {
    const start = this.n - this.hop;
    for (let i = 0; i < inL.length; i++) {
      this.inL[start + this.pos] = inL[i];
      this.inR[start + this.pos] = inR[i];
      outL[i] = this.readyL[this.pos];
      outR[i] = this.readyR[this.pos];
      if (++this.pos === this.hop) {
        this.pos = 0;
        this.frame();
      }
    }
  }

  frame() {
    const { n, hop, window: w, re, im, yr, yi } = this;
    for (let i = 0; i < n; i++) {
      re[i] = this.inL[i] * w[i]; // both channels in one complex FFT: z = left + i·right
      im[i] = this.inR[i] * w[i];
    }
    this.fft.transform(re, im, false);
    this.analyse();
    this.findDrums();
    this.updateMonoGuard();
    const goal = this.isMono || this.freshFrames < WARMUP_FRAMES ? 0 : this.targetStrength;
    this.strength += STRENGTH_GLIDE * (goal - this.strength);
    this.resynthesise();
    this.fft.transform(yr, yi, true);

    for (let i = 0; i < n; i++) {
      const g = w[i] * this.gain;
      this.accL[i] += yr[i] * g;
      this.accR[i] += yi[i] * g;
    }
    this.readyL.set(this.accL.subarray(0, hop));
    this.readyR.set(this.accR.subarray(0, hop));
    this.accL.copyWithin(0, hop).fill(0, n - hop);
    this.accR.copyWithin(0, hop).fill(0, n - hop);
    this.inL.copyWithin(0, hop);
    this.inR.copyWithin(0, hop);
  }

  /** Unpacks the two channel spectra and scores every bin for "centre-ness" (0..1). */
  analyse() {
    const { n, re, im, Lr, Li, Rr, Ri, pll, prr, plrRe, plrIm, centre } = this;
    const a = STATS_SMOOTHING;
    const b = 1 - a;
    let mid = 0;
    let side = 0;
    for (let k = 0; k <= n / 2; k++) {
      const nk = (n - k) & (n - 1);
      const zr = re[k], zi = im[k], cr = re[nk], ci = -im[nk]; // Z[k] and conj(Z[n-k])
      const lr = 0.5 * (zr + cr), li = 0.5 * (zi + ci); // L = (Z[k] + conj Z[n-k]) / 2
      const rr = 0.5 * (zi - ci), ri = -0.5 * (zr - cr); // R = (Z[k] - conj Z[n-k]) / 2i
      Lr[k] = lr;
      Li[k] = li;
      Rr[k] = rr;
      Ri[k] = ri;

      pll[k] = a * pll[k] + b * (lr * lr + li * li);
      prr[k] = a * prr[k] + b * (rr * rr + ri * ri);
      plrRe[k] = a * plrRe[k] + b * (lr * rr + li * ri); // L · conj(R)
      plrIm[k] = a * plrIm[k] + b * (li * rr - lr * ri);

      const total = pll[k] + prr[k];
      let c = 0;
      if (total > 1e-20) {
        const cross = Math.hypot(plrRe[k], plrIm[k]);
        const balance = 1 - Math.abs(pll[k] - prr[k]) / total; // 1 = same level in both speakers
        const coherence = cross / (Math.sqrt(pll[k] * prr[k]) + 1e-30); // 1 = same waveform
        const inPhase = cross > 0 ? Math.max(0, plrRe[k] / cross) : 0; // 1 = no phase offset
        c = balance * coherence * inPhase;
      }
      centre[k] = c;

      const sr = lr - rr, si = li - ri, mr = lr + rr, mi = li + ri;
      side += sr * sr + si * si;
      mid += mr * mr + mi * mi;
      this.mid[k] = Math.hypot(mr, mi);
    }
    this.frameMid = mid;
    this.frameSide = side;
  }

  /**
   * Scores each bin for "drum hit" (0..1). A bin is a hit when it stands out from its own recent past
   * (median over time: what is steady) the way a broadband sound does (median across frequency: what
   * is spread out), and isn't a sharp harmonic peak — so a sung note's first frames still count as voice.
   */
  findDrums() {
    const { mid, past, drum, drumBand, drumBins, sorted, spread: levels } = this;
    past.set(mid.subarray(0, drumBins), this.slot * drumBins);
    this.slot = (this.slot + 1) % DRUM_HISTORY;
    for (let i = 0; i < levels.length; i++) {
      const from = Math.max(0, i * DRUM_STRIDE - DRUM_SPREAD);
      const count = Math.min(drumBins, i * DRUM_STRIDE + DRUM_SPREAD + 1) - from;
      for (let j = 0; j < count; j++) sorted[j] = mid[from + j];
      levels[i] = median(sorted, count);
    }
    for (let k = 0; k < drumBins; k++) {
      for (let t = 0; t < DRUM_HISTORY; t++) sorted[t] = past[t * drumBins + k];
      const steady = median(sorted, DRUM_HISTORY);
      const at = k / DRUM_STRIDE;
      const below = Math.floor(at);
      const spread = levels[below] + (at - below) * (levels[Math.min(below + 1, levels.length - 1)] - levels[below]);
      const hit = (spread * spread) / (spread * spread + steady * steady + 1e-30);
      drum[k] = drumBand[k] * hit * smoothstep(0.2, 0.5, spread / (mid[k] + 1e-30));
    }
  }

  /** Mono songs are "all centre": removing it would gut them, so detect them and step aside. */
  updateMonoGuard() {
    const mid = this.frameMid;
    const side = this.frameSide;
    if (mid + side < this.silence) {
      // Gap between songs: forget the previous one.
      this.monoMid = 0;
      this.monoSide = 0;
      this.freshFrames = 0;
      return;
    }
    this.monoMid = 0.9 * this.monoMid + 0.1 * mid;
    this.monoSide = 0.9 * this.monoSide + 0.1 * side;
    if (++this.freshFrames < WARMUP_FRAMES) return;
    const ratio = this.monoSide / (this.monoMid + 1e-30);
    if (!this.isMono && ratio < MONO_ON) this.isMono = true;
    else if (this.isMono && ratio > MONO_OFF) this.isMono = false;
  }

  /** Subtracts the centre component per bin and packs both channels back into Y = L + i·R. */
  resynthesise() {
    const { n, Lr, Li, Rr, Ri, centre, mask, band, yr, yi, lo, hi, strength } = this;
    const half = n / 2;
    for (let k = 0; k <= half; k++) {
      // Light smoothing across neighbouring bins steadies the decision.
      const c = k === 0 || k === half ? centre[k] : 0.25 * centre[k - 1] + 0.5 * centre[k] + 0.25 * centre[k + 1];
      const target = smoothstep(lo, hi, c) * band[k] * strength;
      const smoothed = (mask[k] += (target > mask[k] ? MASK_ATTACK : MASK_RELEASE) * (target - mask[k]));
      const m = k < this.drumBins ? smoothed * (1 - this.drum[k]) : smoothed; // a drum hit passes at once

      let olr = Lr[k], oli = Li[k], orr = Rr[k], ori = Ri[k];
      if (m > 1e-4) {
        const sumR = olr + orr, sumI = oli + ori;
        const sumMag = Math.hypot(sumR, sumI);
        if (sumMag > 1e-20) {
          // The centre part can't be louder than the quieter channel; it carries the mid signal's phase.
          const amount = (m * Math.min(Math.hypot(olr, oli), Math.hypot(orr, ori))) / sumMag;
          const cr = amount * sumR, ci = amount * sumI;
          olr -= cr;
          oli -= ci;
          orr -= cr;
          ori -= ci;
        }
      }

      yr[k] = olr - ori;
      yi[k] = oli + orr;
      if (k > 0 && k < half) {
        yr[n - k] = olr + ori; // Hermitian mirror keeps both output channels real
        yi[n - k] = orr - oli;
      }
    }
  }
}

/** Median of the first `count` values (sorts them in place; count is small). */
function median(values, count) {
  for (let i = 1; i < count; i++) {
    const v = values[i];
    let j = i - 1;
    for (; j >= 0 && values[j] > v; j--) values[j + 1] = values[j];
    values[j + 1] = v;
  }
  const middle = count >> 1;
  return count % 2 ? values[middle] : 0.5 * (values[middle - 1] + values[middle]);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
