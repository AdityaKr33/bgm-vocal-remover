// The live remover hears a tab through the browser's tab sharing. Which tabs the prompt offers is the
// whole difference between the in-app player and "any tab", so the options are pinned here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureOptions, unsupportedReason } from '../src/live-remover.js';

test('with the in-app player, the prompt offers only this tab', () => {
  const options = captureOptions('app');
  assert.equal(options.preferCurrentTab, true);
  assert.equal(options.selfBrowserSurface, 'include');
  assert.equal(options.surfaceSwitching, 'exclude');
});

test('"any tab" offers every other tab, and lets the listener switch tabs while it runs', () => {
  const options = captureOptions('tab');
  assert.equal(options.preferCurrentTab, false, 'the full tab picker, not just this tab');
  assert.equal(options.selfBrowserSurface, 'exclude', 'this tab plays nothing then');
  assert.equal(options.surfaceSwitching, 'include');
  assert.equal(options.video.displaySurface, 'browser', 'tabs come first in the picker');
});

test('either way the shared tab is muted and its sound is not treated like a voice call', () => {
  for (const source of ['app', 'tab']) {
    const { audio, systemAudio, monitorTypeSurfaces } = captureOptions(source);
    assert.deepEqual(audio, { suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    assert.equal(systemAudio, 'exclude', 'only the tab, never the whole computer’s sound');
    assert.equal(monitorTypeSurfaces, 'exclude');
  }
});

test('where the live remover can’t run, the listener is told why in plain words, and what still works', () => {
  const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15';
  const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1';
  const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
  assert.match(unsupportedReason(SAFARI), /^Safari can’t share a tab’s sound.*Chrome or Edge.*Official instrumentals work here/);
  assert.match(unsupportedReason(FIREFOX), /^Firefox can’t share a tab’s sound/);
  assert.match(unsupportedReason(IPHONE), /needs a computer/);
  assert.match(unsupportedReason(CHROME), /Chrome or Edge on a computer/, 'a Chromium browser without tab sharing');
});
