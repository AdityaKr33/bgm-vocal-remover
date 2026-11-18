// User preferences, kept in this browser's localStorage.
import { FLAT } from './sound.js';

const KEY = 'bgm.settings';

export const DEFAULT_SETTINGS = Object.freeze({
  quality: 'ai', // live remover: 'ai' (MDX-Net model on the GPU) | 'fast' (signal processing)
  strength: 100, // live vocal remover slider, 0–100
  sound: FLAT, // the Sound panel: tone controls and width (sound.js)
});

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or blocked storage: settings just won't persist.
  }
}
