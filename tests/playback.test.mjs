// The AI remover's playback buffer: processed audio arrives in bursts (one per model run), and
// playback should start a short margin after the first burst instead of after several bursts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PlaybackFifo } from '../src/playback-fifo.js';

const RATE = 48000;
const BLOCK = 128; // one audio-thread callback

/** Runs the buffer for `seconds`, pushing a burst at each given time; returns the events seen. */
function simulate({ bursts, burstSeconds, marginSeconds, seconds }) {
  const fifo = new PlaybackFifo(RATE * 30);
  fifo.margin = Math.round(marginSeconds * RATE);
  const burstLength = Math.round(burstSeconds * RATE);
  const events = [];
  const played = [];
  let next = 0; // the stream sample the next burst starts with
  const pending = [...bursts].sort((a, b) => a - b);
  for (let t = 0; t < seconds * RATE; t += BLOCK) {
    while (pending.length && pending[0] * RATE <= t) {
      pending.shift();
      const left = Float32Array.from({ length: burstLength }, (_, i) => next + i);
      fifo.push(left, left);
      next += burstLength;
    }
    const outL = new Float32Array(BLOCK);
    const outR = new Float32Array(BLOCK);
    const event = fifo.pull(outL, outR);
    if (event) events.push({ event, at: t / RATE });
    if (fifo.playing || event === 'start') played.push(...outL);
  }
  return { events, played };
}

test('playback starts a margin after the first burst, not after several bursts', () => {
  const bursts = [1.24, 1.68, 2.12, 2.56];
  const { events } = simulate({ bursts, burstSeconds: 0.44, marginSeconds: 0.12, seconds: 3 });
  assert.equal(events[0].event, 'start');
  assert.ok(Math.abs(events[0].at - (1.24 + 0.12)) < 0.01, `started at ${events[0].at.toFixed(3)} s`);
});

test('bursts that keep pace never run dry, and samples come out in order', () => {
  const bursts = Array.from({ length: 12 }, (_, i) => 1 + i * 0.44 + (i % 3) * 0.03); // up to 60 ms late
  const { events, played } = simulate({ bursts, burstSeconds: 0.44, marginSeconds: 0.12, seconds: 5 });
  assert.deepEqual(events.map((e) => e.event), ['start']);
  for (let i = 0; i < played.length; i++) assert.equal(played[i], i);
});

test('a burst later than the margin causes one underrun, then playback waits the margin again', () => {
  const bursts = [1, 1.44, 2.1, 2.54]; // the third comes 0.22 s late
  const { events } = simulate({ bursts, burstSeconds: 0.44, marginSeconds: 0.12, seconds: 3 }); // ends before the last burst runs out
  assert.deepEqual(events.map((e) => e.event), ['start', 'underrun', 'start']);
  assert.ok(Math.abs(events[2].at - (2.1 + 0.12)) < 0.01, `restarted at ${events[2].at.toFixed(3)} s`);
});
