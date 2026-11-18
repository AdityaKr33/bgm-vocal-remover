/**
 * Complex FFT for sizes 2^p·m with m ∈ {1, 3, 5, 15}: m interleaved radix-2 transforms plus one
 * mixing pass. That covers powers of two and the n_fft sizes the UVR MDX-Net models use
 * (6144 = 3·2^11, 7680 = 15·2^9).
 */
export class FFT {
  constructor(n) {
    let odd = n;
    while (odd % 2 === 0) odd /= 2;
    if (!Number.isInteger(n) || n < 2 || ![1, 3, 5, 15].includes(odd)) throw new Error(`Unsupported FFT size ${n}`);
    this.n = n;
    this.odd = odd;
    this.size = n / odd; // power of two
    this.radix2 = new Radix2(this.size);
    if (odd > 1) {
      this.cos = new Float64Array(n);
      this.sin = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        this.cos[k] = Math.cos((2 * Math.PI * k) / n);
        this.sin[k] = -Math.sin((2 * Math.PI * k) / n);
      }
      this.subRe = Array.from({ length: odd }, () => new Float64Array(this.size));
      this.subIm = Array.from({ length: odd }, () => new Float64Array(this.size));
    }
  }

  /** In-place transform of (re, im). `inverse` gives the unscaled inverse (divide by n yourself). */
  transform(re, im, inverse = false) {
    if (this.odd === 1) {
      this.radix2.transform(re, im, inverse);
      return;
    }
    const { n, odd, size, subRe, subIm, cos, sin } = this;
    // X[k] = Σ_j W^(j·k) · F_j[k mod size], where F_j is the FFT of every odd-th sample from j.
    for (let j = 0; j < odd; j++) {
      const sr = subRe[j];
      const si = subIm[j];
      for (let q = 0, i = j; q < size; q++, i += odd) {
        sr[q] = re[i];
        si[q] = im[i];
      }
      this.radix2.transform(sr, si, inverse);
    }
    const sign = inverse ? -1 : 1;
    const mask = size - 1;
    for (let k = 0; k < n; k++) {
      const kk = k & mask;
      let accRe = subRe[0][kk];
      let accIm = subIm[0][kk];
      for (let j = 1, t = k; j < odd; j++) {
        const wr = cos[t];
        const wi = sign * sin[t];
        const xr = subRe[j][kk];
        const xi = subIm[j][kk];
        accRe += xr * wr - xi * wi;
        accIm += xr * wi + xi * wr;
        t += k;
        if (t >= n) t -= n;
      }
      re[k] = accRe;
      im[k] = accIm;
    }
  }
}

/** Iterative radix-2 complex FFT, in place. */
class Radix2 {
  constructor(n) {
    if (n & (n - 1)) throw new Error('Radix-2 size must be a power of two');
    this.n = n;
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >>> b) & 1);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
  }

  transform(re, im, inverse) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    const sign = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cos[t];
          const wi = sign * sin[t];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}
