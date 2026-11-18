import { Resampler } from './resampler.js';
import { StreamingSeparator } from './separator.js';

const KEEP_UP = 1.3; // a run must be done before the next is due, with 30 % to spare
const REST = 3; // when it can, the GPU rests twice as long as it works, so the laptop stays cool...
const MAX_STEP_SECONDS = 0.6; // ...but runs are never further apart than this, or the sound lags the player

/**
 * How often the model runs, in STFT frames, for a GPU that takes `runMs` per run. The step adds straight to the
 * delay, so it stays at most MAX_STEP_SECONDS (about 1.3 s behind in all on a 0.3 s GPU, busy half the time);
 * only a GPU too slow to keep up at that pace gets a longer step.
 */
export function stepFramesFor(runMs, model) {
  const run = runMs / 1000;
  const step = Math.max(run * KEEP_UP, Math.min(run * REST, MAX_STEP_SECONDS));
  return Math.min(96, Math.max(12, Math.ceil((step * model.sampleRate) / model.hop)));
}

/**
 * Seconds of processed sound to hold back before playback starts, for a GPU that takes `runMs` per run: room for a
 * later run to come back slower than the first without the sound running dry. Runs vary more on a slower GPU (an
 * RTX 4050 running hot: ~600 ms runs, some ~270 ms slower), so it is half a run, from 0.12 s to at most 0.5 s.
 */
export function startMarginFor(runMs) {
  return Math.min(0.5, Math.max(0.12, +((runMs / 1000) * 0.5).toFixed(2)));
}

/**
 * Times `count` runs of `run` back to back and returns the slowest, in ms. One timed run is too noisy to plan the
 * pace from: on an RTX 4050 a single warm-up run measured 463 ms while live runs then averaged ~660 ms.
 */
export async function slowestRunMs(run, count = 3) {
  let slowest = 0;
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    await run();
    slowest = Math.max(slowest, performance.now() - started);
  }
  return slowest;
}

/**
 * The AI vocal remover's processing chain: device-rate audio → 44.1 kHz → MDX-Net separation →
 * device rate. Everything stays on one timeline: output sample i belongs to input sample i, it just
 * arrives later.
 */
export class AiPipeline {
  constructor({ deviceRate, model, runModel, stepFrames = 24, contextFrames = 12, onOutput, onError }) {
    this.sampleRate = model.sampleRate;
    this.toModel = new Resampler(deviceRate, model.sampleRate);
    this.toDevice = new Resampler(model.sampleRate, deviceRate);
    this.separator = new StreamingSeparator({
      nFft: model.nFft,
      hop: model.hop,
      dimF: model.dimF,
      dimT: model.dimT,
      compensate: model.compensate,
      stepFrames,
      contextFrames,
      runModel,
      onError,
      onOutput: (left, right) => {
        const [l, r] = this.toDevice.process([left, right]);
        if (l.length) onOutput(l, r);
      },
    });
  }

  /** Seconds of look-ahead the model needs before a sample can leave (excluding run time). */
  get lookaheadSeconds() {
    const { contextFrames, hop, half } = this.separator;
    return (contextFrames * hop + half) / this.sampleRate;
  }

  push(left, right) {
    const [l, r] = this.toModel.process([left, right]);
    if (l.length) this.separator.push(l, r);
  }

  setStrength(value) {
    this.separator.setStrength(value);
  }

  idle() {
    return this.separator.idle();
  }
}
