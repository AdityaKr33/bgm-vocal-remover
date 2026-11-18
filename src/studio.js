// The front page (index.html): the controls around the live vocal remover. It keeps the chosen quality,
// strength and Sound settings, starts and stops the capture, and fetches the AI model into this browser
// the first time AI is chosen. The work itself happens in the engine window (engine.html).
import { aiSupported, downloadModel, modelStatus } from './ai-model.js';
import { LiveRemover, unsupportedReason } from './live-remover.js';
import { paintRange } from './range.js';
import { loadSettings, saveSettings } from './settings.js';
import { soundPanel } from './sound-panel.js';
import { styleFor, STYLES } from './sound.js';

const settings = loadSettings();
let modelState = { status: 'unknown' }; // the AI model: already here, or to be copied into this browser
let notice = null; // the last error, shown until something else happens

const live = new LiveRemover({ onChange: render });
const el = (id) => document.getElementById(id);
const parts = {
  box: el('liveBox'),
  btn: el('liveBtn'),
  text: el('liveText'),
  modelRow: el('modelRow'),
  modelText: el('modelText'),
  modelBtn: el('modelBtn'),
  qualityAi: el('qualityAi'),
  qualityFast: el('qualityFast'),
  strength: el('strength'),
  strengthOut: el('strengthOut'),
  soundBtn: el('soundBtn'),
  soundName: el('soundName'),
};

/** What the engine should do now. The source is always another tab: this page plays no music of its own. */
function liveParams() {
  const ai = settings.quality === 'ai' && modelState.status === 'ready' && aiSupported();
  return { mode: ai ? 'ai' : 'dsp', strength: settings.strength / 100, sound: settings.sound };
}

function save(patch) {
  Object.assign(settings, patch);
  saveSettings(settings);
  live.setParams(liveParams());
  render();
}

function fail(error) {
  notice = error?.message ?? String(error);
  render();
}

/* ---------- the AI model ---------- */

async function refreshModel() {
  modelState = await modelStatus();
  render();
  if (modelState.status === 'downloading') setTimeout(refreshModel, 1000);
  else live.setParams(liveParams()); // ready now: a running remover switches to AI
}

/** No local server here, so the visitor's own browser fetches the model and keeps it. */
async function downloadIntoBrowser() {
  modelState = { status: 'downloading', source: 'browser', received: 0, total: 100 };
  render();
  try {
    await downloadModel({
      onProgress: (share) => {
        const percent = Math.floor(share * 100);
        if (percent === modelState.received) return; // redraw on whole percents only
        modelState = { ...modelState, received: percent };
        render();
      },
    });
  } catch (error) {
    modelState = { status: 'error', source: 'browser', error: error.message };
    return render();
  }
  refreshModel();
}

function modelText() {
  const { status, received = 0, total = 0, error } = modelState;
  if (status === 'downloading') return `Downloading the AI model… ${total ? Math.round((100 * received) / total) : 0}%`;
  if (status === 'missing') return 'AI mode needs a one-time 56 MB model download. It stays in this browser.';
  if (status === 'error') return `Download failed: ${error}`;
  return 'Checking for the AI model…';
}

/* ---------- what the status line says ---------- */

function liveText() {
  if (!LiveRemover.supported()) return unsupportedReason(navigator.userAgent);
  if (notice) return notice;
  if (live.waiting) return 'Your browser blocked the small sound window — click “Open window”.';
  if (!live.running) return 'Click Start and pick the tab playing your music. Keep “Also share tab audio” on. A small window then plays it without the vocals.';

  const status = live.status ?? {};
  const from = live.tabName ? `Listening to “${live.tabName}”. ` : '';
  if (status.engine === 'loading') return `${from}Loading the AI model… ${Math.round((status.progress ?? 0) * 100)}% — the fast remover plays meanwhile.`;
  if (status.engine === 'ai') return `${from}AI vocal remover running. The sound is about ${(status.latencyMs / 1000).toFixed(1)} s behind the music tab. Keep the small window open — minimised is fine.`;
  if (status.error) return `Using the fast remover because AI can’t run here: ${status.error}.`;
  if (settings.quality === 'ai' && aiSupported() && modelState.status !== 'ready') return 'Using the fast remover until the AI model is downloaded (see above).';
  if (live.mono) return 'This recording is mono, so the fast remover can’t separate its vocals — the AI remover can.';
  return `${from}Fast vocal remover running. Keep the small window open — minimised is fine.`;
}

/* ---------- drawing ---------- */

function render() {
  const supported = LiveRemover.supported();
  parts.box.classList.toggle('is-off', !supported);
  parts.btn.hidden = !supported;
  parts.btn.textContent = live.waiting ? 'Open window' : live.running ? 'Stop' : 'Start';
  parts.btn.classList.toggle('on', live.running);
  parts.text.textContent = liveText();

  parts.qualityAi.checked = settings.quality === 'ai';
  parts.qualityFast.checked = settings.quality !== 'ai';
  parts.qualityAi.disabled = !aiSupported(); // no WebGPU in this browser
  parts.box.classList.toggle('no-ai', !aiSupported());

  const wantsModel = supported && aiSupported() && settings.quality === 'ai' && modelState.status !== 'ready';
  parts.modelRow.hidden = !wantsModel;
  if (wantsModel) {
    parts.modelText.textContent = modelText();
    parts.modelBtn.hidden = modelState.status === 'downloading';
    parts.modelBtn.textContent = modelState.status === 'error' ? 'Try again' : 'Download';
  }

  parts.strength.value = String(settings.strength);
  parts.strengthOut.textContent = `${settings.strength}%`;
  paintRange(parts.strength);
  parts.soundName.textContent = STYLES.find((style) => style.id === styleFor(settings.sound))?.name ?? 'Custom';
}

/* ---------- wiring ---------- */

parts.btn.addEventListener('click', async () => {
  notice = null;
  try {
    if (live.waiting) await live.openWindow();
    else if (live.running) live.stop();
    else await live.start(liveParams(), { source: 'tab' }); // inside the click: the sharing prompt needs it
  } catch (error) {
    fail(error);
  }
});

for (const [input, quality] of [[parts.qualityAi, 'ai'], [parts.qualityFast, 'fast']]) {
  input.addEventListener('change', () => input.checked && save({ quality }));
}
parts.strength.addEventListener('input', () => save({ strength: Number(parts.strength.value) }));
parts.modelBtn.addEventListener('click', downloadIntoBrowser);

soundPanel({
  dialog: el('soundPanel'),
  opener: parts.soundBtn,
  label: el('soundNote'),
  values: settings.sound,
  onChange: (sound) => save({ sound }),
});

render();
window.bgmStarted?.(); // the page is up: src/crash.js stops waiting, and later errors are ours to show
refreshModel();
