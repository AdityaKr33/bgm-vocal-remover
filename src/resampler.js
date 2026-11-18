/**
 * Streaming band-limited resampler (windowed-sinc kernel, interpolated from a table). It moves audio
 * between the device rate (usually 48 kHz) and the AI model's 44.1 kHz, in both directions.
 * Output sample k lines up with input time k·(fromRate / toRate): no time shift is added.
 */
export class Resampler {
  // 32 taps a side keep the round trip around the AI model flat to 20 kHz with aliasing near -75 dB (16 dulled
  // 20 kHz by 2.8 dB and left junk at -37 dB); it costs about 0.6 ms of delay and very little CPU
  constructor(fromRate, toRate, { channels = 2, halfTaps = 32, phases = 256 } = {}) {
    this.ratio = fromRate / toRate; // input samples per output sample
    this.passthrough = fromRate === toRate;
    this.channels = channels;
    this.half = halfTaps;
    this.taps = 2 * halfTaps;
    this.phases = phases;
    const cutoff = 0.97 * Math.min(1, toRate / fromRate); // as a fraction of the input Nyquist
    this.table = new Float64Array((phases + 1) * this.taps);
    for (let p = 0; p <= phases; p++) {
      for (let i = 0; i < this.taps; i++) {
        const x = i - halfTaps + 1 - p / phases; // distance from the output position, in input samples
        this.table[p * this.taps + i] = cutoff * sinc(cutoff * x) * blackman(x / halfTaps);
      }
    }
    this.coeffs = new Float64Array(this.taps);
    // Unconsumed input. It starts with half−1 zeros so that output 0 lines up with input 0.
    this.buffers = Array.from({ length: channels }, () => new Float64Array(4096));
    this.length = halfTaps - 1;
    this.pos = halfTaps - 1; // fractional read position, in buffer samples
  }

  /** Feeds one block per channel and returns the resampled block per channel (lengths vary). */
  process(input) {
    if (this.passthrough) return input;
    this.append(input);
    const { half, taps, phases, table, coeffs, ratio, channels, buffers } = this;
    let count = 0;
    for (let p = this.pos; Math.floor(p) + half < this.length; p += ratio) count++;
    const out = Array.from({ length: channels }, () => new Float32Array(count));
    let p = this.pos;
    for (let k = 0; k < count; k++, p += ratio) {
      const base = Math.floor(p);
      const phase = (p - base) * phases;
      const row = Math.floor(phase);
      const a = phase - row;
      const r0 = row * taps;
      const r1 = r0 + taps;
      for (let i = 0; i < taps; i++) coeffs[i] = table[r0 + i] + a * (table[r1 + i] - table[r0 + i]);
      const start = base - half + 1;
      for (let c = 0; c < channels; c++) {
        const buf = buffers[c];
        let acc = 0;
        for (let i = 0; i < taps; i++) acc += buf[start + i] * coeffs[i];
        out[c][k] = acc;
      }
    }
    this.pos = p;
    // Drop input that no future output needs.
    const drop = Math.floor(this.pos) - half + 1;
    if (drop > 0) {
      for (const buf of buffers) buf.copyWithin(0, drop, this.length);
      this.length -= drop;
      this.pos -= drop;
    }
    return out;
  }

  append(input) {
    const n = input[0].length;
    if (this.length + n > this.buffers[0].length) {
      const size = Math.max(this.length + n, this.buffers[0].length * 2);
      this.buffers = this.buffers.map((buf) => {
        const next = new Float64Array(size);
        next.set(buf.subarray(0, this.length));
        return next;
      });
    }
    for (let c = 0; c < this.channels; c++) this.buffers[c].set(input[c] ?? input[0], this.length);
    this.length += n;
  }
}

function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function blackman(u) {
  if (Math.abs(u) >= 1) return 0;
  return 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
}
