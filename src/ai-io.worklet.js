// Audio-thread side of the AI vocal remover: sends the captured sound to the page in small blocks and
// plays the processed sound back (PlaybackFifo decides when playback starts).
import { PlaybackFifo } from './playback-fifo.js';

const BLOCK = 1024;

class AiIoProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inL = new Float32Array(BLOCK);
    this.inR = new Float32Array(BLOCK);
    this.inPos = 0;
    this.captured = 0; // input samples taken so far; output sample i is input sample i, delivered later
    this.fifo = new PlaybackFifo(sampleRate * 30);
    this.fifo.margin = Math.round(sampleRate * 0.12);
    this.port.onmessage = ({ data }) => {
      if (data.type === 'audio') this.fifo.push(data.left, data.right);
      else if (data.type === 'margin') this.fifo.margin = Math.min(data.samples, sampleRate * 2);
    };
  }

  process(inputs, outputs) {
    const left = inputs[0][0];
    const right = inputs[0][1] ?? left;
    const out = outputs[0];
    const n = out[0].length;

    for (let i = 0; i < n; i++) {
      this.inL[this.inPos] = left ? left[i] : 0;
      this.inR[this.inPos] = right ? right[i] : 0;
      if (++this.inPos === BLOCK) {
        this.port.postMessage({ type: 'audio', left: this.inL, right: this.inR }, [this.inL.buffer, this.inR.buffer]);
        this.inL = new Float32Array(BLOCK);
        this.inR = new Float32Array(BLOCK);
        this.inPos = 0;
      }
    }
    this.captured += n;

    const event = this.fifo.pull(out[0], out[1]);
    if (event === 'start') this.port.postMessage({ type: 'playing', delay: this.captured - this.fifo.read }); // the real delay, in samples
    else if (event === 'underrun') this.port.postMessage({ type: 'underrun' });
    return true;
  }
}

registerProcessor('ai-io', AiIoProcessor);
