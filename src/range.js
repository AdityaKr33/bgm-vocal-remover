// Paints a range slider's gold fill up to its value (the --share the stylesheet draws with), and the turns of its
// record-shaped thumb. Used by the player and its Sound panel.

export function paintRange(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const share = Math.min(1, Math.max(0, (Number(input.value) - min) / (max - min)));
  input.style.setProperty('--share', share.toFixed(4));
  input.style.setProperty('--turn', (share * 2).toFixed(3)); // two full turns across the track
}
