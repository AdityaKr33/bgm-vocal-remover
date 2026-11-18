// Live vocal remover for songs that have no official instrumental.
//
// Protected audio can't be read out of a page directly. Instead it uses the
// browser's tab sharing: getDisplayMedia() captures a tab's sound and mutes it locally
// (suppressLocalAudioPlayback). That is this tab, where the in-app player plays, or ("any tab")
// another tab the listener picks: YouTube Music, SoundCloud, a radio stream, any music site at all,
// with no account anywhere. A small companion window runs the vocal-remover AudioWorklet and
// plays the result. It must be a separate window: sound played by this tab would be captured
// again (a feedback loop) and muted along with everything else.

const ENGINE_URL = 'engine.html';
const ENGINE_NAME = 'bgm-engine';
const ENGINE_FEATURES = 'popup,width=380,height=300';

/**
 * What the sharing prompt offers. 'app': only this tab. 'tab': any other tab (not this one, which
 * plays nothing then), and the listener can switch to another tab while it runs. Either way the
 * shared tab is muted, and its sound reaches the remover untouched by the browser's voice processing.
 */
export function captureOptions(source) {
  const own = source === 'app';
  return {
    video: { displaySurface: 'browser', frameRate: { max: 1 } },
    audio: { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    preferCurrentTab: own,
    selfBrowserSurface: own ? 'include' : 'exclude',
    surfaceSwitching: own ? 'exclude' : 'include',
    systemAudio: 'exclude',
    monitorTypeSurfaces: 'exclude',
  };
}

/**
 * Why the live remover can't run in this browser, in plain words, with what still works. It needs a tab's sound
 * shared with it, which only Chromium browsers (Chrome, Edge, Brave) on a computer can do; Safari and Firefox share
 * a screen's picture but not a tab's sound. Everything else in BGM Mode, official instrumentals included, works there.
 */
export function unsupportedReason(userAgent) {
  if (/Mobi|Android|iPhone|iPad/i.test(userAgent)) return 'The live remover needs a computer: phones and tablets can’t share a tab’s sound.';
  if (/Firefox\//.test(userAgent)) return 'Firefox can’t share a tab’s sound, which the live remover needs: use Chrome or Edge for it. Official instrumentals work here.';
  if (/Safari\//.test(userAgent) && !/Chrom(?:e|ium)\/|Edg\//.test(userAgent)) return 'Safari can’t share a tab’s sound, which the live remover needs: use Chrome or Edge for it. Official instrumentals work here.';
  return 'The live remover needs Chrome or Edge on a computer.';
}

export class LiveRemover {
  /** Chromium browsers (Chrome, Edge, Brave) on a computer. */
  static supported() {
    return Boolean(navigator.mediaDevices?.getDisplayMedia && window.AudioWorkletNode && navigator.userAgentData && !navigator.userAgentData.mobile);
  }

  constructor({ onChange }) {
    this.onChange = onChange;
    this.stream = null; // the whole capture (audio + a 1 fps video track we ignore)
    this.window = null;
    this.engine = null;
    this.params = null;
    this.source = null; // 'app' (this tab) or 'tab' (another tab), while running
    this.tabName = null; // the shared tab's title, when the browser reports one
    this.mono = false;
    this.waiting = false; // capture is on but the pop-up was blocked
  }

  get running() {
    return Boolean(this.stream);
  }

  /** Call straight from a click: the sharing prompt and the pop-up both need the click's user activation. */
  async start(params, { source = 'app' } = {}) {
    if (this.stream) return;
    this.params = params;
    const capture = navigator.mediaDevices.getDisplayMedia(captureOptions(source));
    this.window = window.open(ENGINE_URL, ENGINE_NAME, ENGINE_FEATURES);

    let stream;
    try {
      stream = await capture;
    } catch (error) {
      this.closeWindow();
      throw new Error(error?.name === 'NotAllowedError' ? 'Tab sharing was cancelled — the live remover needs it to hear the music.' : `Couldn’t capture the tab’s sound: ${error.message}`);
    }
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      this.closeWindow();
      throw new Error('No sound was shared — keep “Also share tab audio” switched on and try again.');
    }
    for (const track of stream.getTracks()) track.addEventListener('ended', () => this.stop());
    this.stream = stream;
    this.source = source;
    const label = stream.getVideoTracks()[0]?.label ?? '';
    this.tabName = source === 'tab' && label && !label.includes('://') ? label : null; // a title, not an internal id
    this.watchdog = setInterval(() => {
      if (this.window?.closed) this.stop(); // closing the small window turns the remover off
    }, 1000);

    if (this.window) {
      await this.connect();
    } else {
      this.waiting = true;
      this.onChange();
    }
  }

  /** Second click, needed only when the browser blocked the pop-up during start(). */
  async openWindow() {
    this.window = window.open(ENGINE_URL, ENGINE_NAME, ENGINE_FEATURES);
    if (!this.window) throw new Error('Allow pop-ups for this site — the live remover plays through a small window.');
    this.waiting = false;
    await this.connect();
  }

  async connect() {
    const win = this.window;
    for (let i = 0; i < 200 && !win.closed && !win.bgmEngine; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    if (win.closed || !win.bgmEngine) {
      this.stop();
      throw new Error('The live remover window didn’t open properly — try again.');
    }
    this.engine = win.bgmEngine;
    await this.engine.attach(new MediaStream(this.stream.getAudioTracks()), this.params, (message) => {
      if (message?.type === 'mono') this.mono = message.mono;
      else if (message?.type === 'engine') this.status = message; // { engine: 'ai' | 'dsp' | 'loading', … }
      this.onChange();
    });
    this.onChange();
  }

  setParams(params) {
    this.params = params;
    try {
      this.engine?.setParams(params)?.catch?.(() => {});
    } catch {
      // the window is closing; the watchdog cleans up
    }
  }

  stop() {
    if (!this.stream && !this.window) return;
    clearInterval(this.watchdog);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.engine = null;
    this.status = null;
    this.source = null;
    this.tabName = null;
    this.mono = false;
    this.waiting = false;
    this.closeWindow();
    this.onChange();
  }

  closeWindow() {
    if (this.window && !this.window.closed) this.window.close();
    this.window = null;
  }
}
