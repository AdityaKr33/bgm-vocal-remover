// How the vocal-free music sounds: five tone controls named by what they do to a song, the stereo width ("Space"),
// and ready-made styles to try, so anyone can shape it without knowing what a dB or a frequency is. The live
// remover's engine (engine.js) puts soundChain() between the remover and the speakers; the player's Sound panel
// (sound-panel.js) edits the values, which are saved with the settings.

/** The tone controls, in order from low to high: each one a filter at the frequency it acts on. */
export const CONTROLS = Object.freeze([
  { id: 'bass', label: 'Bass', what: 'Kick drum and bass guitar: the low thump', type: 'lowshelf', frequency: 90, min: -12, max: 12 },
  { id: 'warmth', label: 'Warmth', what: 'The body of guitars, piano and pads', type: 'peaking', frequency: 300, q: 0.8, min: -8, max: 8 },
  { id: 'instruments', label: 'Instruments', what: 'Melody instruments step forward or back', type: 'peaking', frequency: 1200, q: 0.8, min: -8, max: 8 },
  { id: 'clarity', label: 'Clarity', what: 'The crisp attack of strings, snare and keys', type: 'peaking', frequency: 3500, q: 0.9, min: -8, max: 8 },
  { id: 'treble', label: 'Treble', what: 'Cymbals, hi-hats and sparkle', type: 'highshelf', frequency: 9000, min: -12, max: 12 },
]);

/** The stereo width, in %: 100 as recorded, 0 mono, 200 twice as wide. */
export const SPACE = Object.freeze({ id: 'space', label: 'Space', what: 'How wide the music spreads between left and right', min: 0, max: 200 });

export const FLAT = Object.freeze({ bass: 0, warmth: 0, instruments: 0, clarity: 0, treble: 0, space: 100 });

const style = (id, name, what, bass, warmth, instruments, clarity, treble, space) =>
  Object.freeze({ id, name, what, values: Object.freeze({ bass, warmth, instruments, clarity, treble, space }) });

/** Ready-made styles to try, flat first. */
export const STYLES = Object.freeze([
  style('flat', 'Flat', 'The song exactly as it was recorded', 0, 0, 0, 0, 0, 100),
  style('deep-focus', 'Deep focus', 'Warm and soft, easy on the ears for long study sessions', 2, 3, -1, -3, -4, 100),
  style('bass-boost', 'Bass boost', 'More thump from the kick drum and bass', 7, 2, 0, 0, 1, 100),
  style('lofi', 'Lo-fi', 'Dusty and mellow, like an old record', 3, 4, -2, -5, -9, 80),
  style('bright', 'Bright & airy', 'Crisp cymbals and a light, open top end', -1, -1, 0, 3, 6, 120),
  style('punchy', 'Punchy', 'Tight drums that hit hard', 5, -2, 0, 4, 2, 100),
  style('acoustic', 'Acoustic', 'Natural guitars and piano, close and clear', 0, 2, 3, 2, 1, 100),
  style('electronic', 'Electronic', 'Deep bass and sparkly highs for beats', 6, -1, -2, 2, 5, 120),
  style('cinematic', 'Cinematic', 'Big, deep and wide, like a film score', 5, 1, -1, 1, 3, 140),
  style('wide', 'Wide stage', 'The music spreads all around you', 0, 0, 0, 1, 2, 160),
  style('late-night', 'Late night', 'Gentle and quiet: less boom, less hiss', -3, 1, 0, -2, -3, 90),
  style('laptop', 'Laptop speakers', 'More body from small speakers, without the boom', -2, 4, 2, 2, 0, 110),
]);

const SMOOTH = 0.03; // s: a control eases to its new value this fast, so moving a slider never clicks

/** Every control set, inside its range: out-of-range numbers clamp, missing or broken ones are flat. */
export function soundValues(values) {
  const tidy = {};
  for (const control of [...CONTROLS, SPACE]) {
    const value = values?.[control.id];
    tidy[control.id] = Number.isFinite(value) ? Math.min(control.max, Math.max(control.min, value)) : FLAT[control.id];
  }
  return tidy;
}

/**
 * How far to turn the sound down before the controls, in dB, so a boost can't push a loud song past full scale:
 * half the biggest boost, plus up to 3 dB for widening (a wider image peaks higher). Cuts need none. The limiter
 * at the end catches whatever peaks are left.
 */
export function headroomDb(values) {
  const v = soundValues(values);
  const boost = Math.max(0, ...CONTROLS.map((control) => v[control.id]));
  const widen = Math.max(0, v.space - 100) / 100;
  const total = boost / 2 + widen * 3;
  return total ? -total : 0;
}

/** The style these values are, or 'custom'. */
export function styleFor(values) {
  const v = soundValues(values);
  return STYLES.find((s) => Object.keys(FLAT).every((key) => s.values[key] === v[key]))?.id ?? 'custom';
}

/**
 * The chain the engine plays through: headroom, one filter per tone control, the stereo width (left out = same ·
 * left + cross · right, and mirrored), then a limiter that only catches peaks and a trim that cancels its makeup
 * gain. Returns { input, output, limiter, width, set }.
 */
export function soundChain(context) {
  const input = context.createGain();
  let last = input;
  const filters = CONTROLS.map((control) => {
    const filter = context.createBiquadFilter();
    filter.type = control.type;
    filter.frequency.value = control.frequency;
    if (control.q) filter.Q.value = control.q;
    last = last.connect(filter);
    return filter;
  });

  const split = context.createChannelSplitter(2);
  const merge = context.createChannelMerger(2);
  last.connect(split);
  const [same, cross, crossRight, sameRight] = [0, 1, 2, 3].map(() => context.createGain());
  split.connect(same, 0).connect(merge, 0, 0); // left → left
  split.connect(cross, 1).connect(merge, 0, 0); // right → left
  split.connect(crossRight, 0).connect(merge, 0, 1); // left → right
  split.connect(sameRight, 1).connect(merge, 0, 1); // right → right

  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -2;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.25;
  merge.connect(limiter);
  // Web Audio's compressor always adds makeup gain (0.6 x how far its curve pulls full scale down); the trim takes
  // it back off, so Flat is exactly as recorded and the limiter's ceiling stays under full scale
  const makeupDb = -0.6 * (limiter.threshold.value - limiter.threshold.value / limiter.ratio.value);
  const trim = context.createGain();
  trim.gain.value = 10 ** (-makeupDb / 20);
  limiter.connect(trim);

  const apply = (values, smooth) => {
    const v = soundValues(values);
    const to = (param, value) => (smooth ? param.setTargetAtTime(value, context.currentTime, SMOOTH) : (param.value = value));
    CONTROLS.forEach((control, i) => to(filters[i].gain, v[control.id]));
    to(input.gain, 10 ** (headroomDb(v) / 20));
    const width = v.space / 100;
    for (const gain of [same, sameRight]) to(gain.gain, (1 + width) / 2);
    for (const gain of [cross, crossRight]) to(gain.gain, (1 - width) / 2);
  };
  apply(FLAT, false);
  return { input, output: trim, limiter, width: { same, cross }, set: (values) => apply(values, true) };
}
