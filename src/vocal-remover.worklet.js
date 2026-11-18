// AudioWorklet wrapper around the vocal-remover engine. Runs on the browser's real-time audio thread.
import { VocalRemover } from './dsp-core.js';

class VocalRemoverProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = new VocalRemover(sampleRate);
    this.silent = new Float32Array(128);
    this.spare = new Float32Array(128);
    this.wasMono = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === 'params') this.engine.setParams(data.params);
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length;
    if (this.silent.length !== frames) {
      this.silent = new Float32Array(frames);
      this.spare = new Float32Array(frames);
    }
    const input = inputs[0];
    const left = input[0] ?? this.silent;
    const right = input[1] ?? left;
    this.engine.process(left, right, out[0], out[1] ?? this.spare);

    if (this.engine.isMono !== this.wasMono) {
      this.wasMono = this.engine.isMono;
      this.port.postMessage({ type: 'mono', mono: this.wasMono });
    }
    return true;
  }
}

registerProcessor('vocal-remover', VocalRemoverProcessor);
