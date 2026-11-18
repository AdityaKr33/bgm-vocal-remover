// Companion window of the live vocal remover. It plays the captured tab sound through either the
// AI model (MDX-Net on the GPU) or the fast signal-processing remover, then through the listener's
// sound (tone controls, width and a safety limiter: sound.js), and reports its state back.
import { MODEL, aiSupported, loadModel } from './ai-model.js';
import { AiPipeline, slowestRunMs, startMarginFor, stepFramesFor } from './ai-pipeline.js';
import { sliderToDspParams } from './dsp-core.js';
import { soundChain } from './sound.js';

const IO = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' };
const MAX_MODEL_MS = 2500; // a GPU slower than this can't keep up with live playback
const statusText = document.getElementById('status');
const startButton = document.getElementById('start');

let context = null;
let source = null;
let graph = null; // { kind: 'ai' | 'dsp', node, pipeline? }
let sound = null; // the tone controls between the remover and the speakers
let wanted = { mode: 'dsp', strength: 1 };
let model = null;
let modelMs = 0;
let aiFailed = null; // why AI can't run in this window, if it can't
let loading = null;
let report = () => {};
const stats = { posted: 0, underruns: 0, marginSeconds: 0, delayMs: 0, stepFrames: 0 };
const modules = {};

window.bgmEngine = {
  async attach(stream, params, onReport) {
    report = (message) => {
      try {
        onReport?.(message);
      } catch {
        // the main window is gone
      }
    };
    context ??= new AudioContext({ latencyHint: 'playback' });
    context.onstatechange = render;
    if (!sound) {
      sound = soundChain(context);
      sound.output.connect(context.destination);
    }
    source = context.createMediaStreamSource(stream);
    stream.getAudioTracks()[0]?.addEventListener('ended', () => window.close());
    await context.resume().catch(() => {}); // may stay suspended until a click in this window
    await this.setParams(params);
    render();
  },

  /** { mode: 'ai' | 'dsp', strength: 0..1, sound } — cheap when only the strength or the sound changes. */
  async setParams(params = {}) {
    wanted = { ...wanted, ...params };
    sound?.set(wanted.sound);
    if (!source) return;
    if (wanted.mode === 'ai' && !aiFailed) await useAi();
    else await useDsp();
    applyStrength();
  },

  /** Diagnostics: what is running and how healthy it is. */
  debug: () => ({ graph: graph?.kind ?? null, contextState: context?.state, modelMs: Math.round(modelMs), aiFailed, ...stats }),
};

function addModule(path) {
  modules[path] ??= context.audioWorklet.addModule(path);
  return modules[path];
}

function swap(next) {
  if (graph) {
    source.disconnect(graph.node);
    graph.node.disconnect();
    graph.node.port.onmessage = null;
  }
  graph = next;
  source.connect(next.node).connect(sound.input);
  render();
}

function applyStrength() {
  if (graph?.kind === 'ai') graph.pipeline.setStrength(wanted.strength);
  else if (graph?.kind === 'dsp') graph.node.port.postMessage({ type: 'params', params: sliderToDspParams(wanted.strength * 100) });
}

async function useDsp() {
  if (graph?.kind !== 'dsp') {
    await addModule('src/vocal-remover.worklet.js');
    const node = new AudioWorkletNode(context, 'vocal-remover', IO);
    node.port.onmessage = ({ data }) => {
      if (data?.type === 'mono') report({ type: 'mono', mono: data.mono });
    };
    swap({ kind: 'dsp', node });
    applyStrength();
  }
  // Report even if the fast remover was already playing: after a failed AI load this tells the
  // main window why, instead of leaving it on "Loading the AI model…".
  report({ type: 'engine', engine: 'dsp', error: wanted.mode === 'ai' ? aiFailed : null });
}

async function useAi() {
  if (graph?.kind === 'ai') return;
  if (!graph) await useDsp(); // play the fast remover while the model loads
  loading ??= prepareAi().finally(() => {
    loading = null;
    render();
  });
  render();
  await loading;
}

async function prepareAi() {
  try {
    if (!aiSupported()) throw new Error('this browser has no WebGPU');
    if (!model) {
      let shown = -1; // report whole percents only
      const progress = (p) => {
        const percent = Math.floor(p * 100);
        if (percent !== shown) report({ type: 'engine', engine: 'loading', progress: (shown = percent) / 100 });
      };
      progress(0);
      model = await loadModel({ onProgress: (p) => progress(0.9 * p) }); // the last 10 % is GPU warm-up
      const input = new Float32Array(4 * MODEL.dimF * MODEL.dimT);
      await model.run(input); // the first run compiles the GPU shaders
      modelMs = await slowestRunMs(() => model.run(input)); // the pace is planned from the slowest of a few runs
      if (modelMs > MAX_MODEL_MS) throw new Error('this GPU is too slow for live AI separation');
    }
    if (wanted.mode === 'ai') await startAi();
  } catch (error) {
    aiFailed = error.message;
    await useDsp();
  }
}

async function startAi() {
  await addModule('src/ai-io.worklet.js');
  // How often the model runs: often enough that the sound stays close behind the player, with the GPU resting
  // between runs when it is fast enough to (stepFramesFor in ai-pipeline.js).
  const stepFrames = stepFramesFor(modelMs, MODEL);
  const node = new AudioWorkletNode(context, 'ai-io', IO);
  const pipeline = new AiPipeline({
    deviceRate: context.sampleRate,
    model: MODEL,
    stepFrames,
    runModel: (input) => model.run(input),
    onOutput: (left, right) => {
      stats.posted += left.length;
      node.port.postMessage({ type: 'audio', left, right });
    },
    onError: (error) => {
      aiFailed = `the GPU stopped (${error.message})`;
      useDsp();
    },
  });
  // Playback starts this long after the first processed audio arrives (slack for a late model run, more on a
  // slower GPU); it widens a little whenever the sound runs dry.
  let margin = startMarginFor(modelMs);
  // An estimate until the audio thread measures the real delay when playback starts.
  let latencyMs = Math.round((pipeline.lookaheadSeconds + (stepFrames * MODEL.hop) / MODEL.sampleRate + modelMs / 1000 + margin) * 1000);
  const sendMargin = () => node.port.postMessage({ type: 'margin', samples: Math.round(margin * context.sampleRate) });
  sendMargin();
  const announce = () => {
    stats.marginSeconds = margin;
    stats.delayMs = latencyMs;
    report({ type: 'engine', engine: 'ai', latencyMs, modelMs: Math.round(modelMs) });
  };
  node.port.onmessage = ({ data }) => {
    if (data.type === 'audio') pipeline.push(data.left, data.right);
    else if (data.type === 'playing') {
      latencyMs = Math.round((data.delay / context.sampleRate) * 1000);
      announce();
    } else if (data.type === 'underrun') {
      stats.underruns++;
      margin = Math.min(1, +(margin + 0.1).toFixed(2));
      sendMargin();
    }
  };
  stats.stepFrames = stepFrames;
  swap({ kind: 'ai', node, pipeline });
  applyStrength();
  sendMargin();
  announce();
}

function render() {
  const running = context?.state === 'running';
  startButton.hidden = !context || running;
  statusText.textContent = !context
    ? 'Connecting to BGM Mode…'
    : !running
      ? 'Click “Start sound” so this window is allowed to play audio.'
      : graph?.kind === 'ai'
        ? 'AI vocal remover running. Keep this window open — minimising it is fine.'
        : loading
          ? 'Loading the AI model… the fast remover plays meanwhile.'
          : wanted.mode === 'ai' && aiFailed
            ? `Fast vocal remover running — AI can’t run here: ${aiFailed}.`
            : 'Fast vocal remover running. Keep this window open — minimising it is fine.';
}

startButton.addEventListener('click', async () => {
  await context?.resume();
  render();
});
document.getElementById('stop').addEventListener('click', () => window.close());
render();
