/**
 * The AI remover's playback buffer, used on the audio thread by ai-io.worklet.js.
 *
 * Processed audio arrives in bursts, one per model run. Playback starts `margin` samples after the
 * first burst arrives (enough to absorb a model run that comes a little late) rather than waiting for
 * a fixed amount of audio to pile up, which with bursts meant waiting for several of them. If a burst
 * comes later than the margin and the buffer runs dry, it waits the margin again.
 */
export class PlaybackFifo {
  constructor(capacity) {
    this.size = capacity;
    this.left = new Float32Array(capacity);
    this.right = new Float32Array(capacity);
    this.read = 0; // samples played
    this.write = 0; // samples received
    this.margin = 0; // samples to wait, once audio is here, before playing
    this.waited = 0;
    this.playing = false;
  }

  get available() {
    return this.write - this.read;
  }

  push(left, right = left) {
    for (let i = 0; i < left.length; i++) {
      const j = (this.write + i) % this.size;
      this.left[j] = left[i];
      this.right[j] = right[i];
    }
    this.write += left.length;
    if (this.available > this.size) this.read = this.write - this.size; // overflow: drop the oldest
  }

  /** Fills one block of output (silence while waiting). Returns 'start', 'underrun' or undefined. */
  pull(outL, outR) {
    const n = outL.length;
    let event;
    if (!this.playing && this.available >= n) {
      this.waited += n;
      if (this.waited >= this.margin) {
        this.playing = true;
        this.waited = 0;
        event = 'start';
      }
    }
    if (this.playing && this.available >= n) {
      for (let i = 0; i < n; i++) {
        const j = (this.read + i) % this.size;
        outL[i] = this.left[j];
        if (outR) outR[i] = this.right[j];
      }
      this.read += n;
      return event;
    }
    if (this.playing) {
      this.playing = false; // ran dry: the page widens the margin
      event = 'underrun';
    }
    outL.fill(0);
    outR?.fill(0);
    return event;
  }
}
