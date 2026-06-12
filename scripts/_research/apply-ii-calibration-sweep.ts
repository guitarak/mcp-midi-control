/**
 * Apply hardware-verified display ranges from PROBE-II-CAL-SWEEP to params.ts.
 *
 * Source: live sweep on the Axe-Fx II XL+ (effectId 106 AMP 1), 5 wire points
 * each, device-rendered labels read back via fn 0x02 GET. Self-restoring sweep,
 * nothing saved to flash. Raw data: samples/captured/decoded/ii-opaque-amp-sweep.json.
 *
 * Only params whose 5-point fit is unambiguous are applied here:
 *   geq_band_1..8  linear -12..+12 dB  (0->-12, 16383->-6, 32767->0, 49151->+6, 65534->+12)
 *   low_res        linear 0..10        (0->0.00, 32767->5.00, 65534->10.00)
 *   b_time_const   log10  1..100 ms    (0->1.00, 16383->3.16, 32767->10.00, 49151->31.62, 65534->100.0)
 *   cathode_resist linear 0..100 %     (0->0.0, 32767->50.0, 65534->100.0)
 *
 * Idempotent-guarded: refuses a line that already carries displayMin.
 * Run: npx tsx scripts/_research/apply-ii-calibration-sweep.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PARAMS_TS = path.resolve(
  import.meta.dirname, '..', '..',
  'packages', 'fractal-midi', 'src', 'gen2', 'axe-fx-ii', 'params.ts',
);

interface Cal { key: string; fields: string; }

const CALS: Cal[] = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    key: `amp.geq_band_${n}`,
    fields: 'displayMin: -12, displayMax: 12',
  })),
  { key: 'amp.low_res', fields: 'displayMin: 0, displayMax: 10' },
  { key: 'amp.b_time_const', fields: 'displayMin: 1, displayMax: 100, displayScale: "log10"' },
  { key: 'amp.cathode_resist', fields: 'displayMin: 0, displayMax: 100' },
  // Second wave: master_trim + neg_feedback (trim/feedback sweep).
  { key: 'amp.neg_feedback', fields: 'displayMin: 0, displayMax: 10' },
  { key: 'amp.master_trim', fields: 'displayMin: 0.1, displayMax: 10, displayScale: "log10"' },
  // Third wave: output scene mains (-20..+20 dB, all 8 share scale) + pitch voice pan/feedback.
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    key: `output.scene_${n}_main`,
    fields: 'displayMin: -20, displayMax: 20',
  })),
  { key: 'pitch.voice_1_pan', fields: 'displayMin: -100, displayMax: 100' },
  { key: 'pitch.voice_2_pan', fields: 'displayMin: -100, displayMax: 100' },
  { key: 'pitch.voice_1_feedback', fields: 'displayMin: 0, displayMax: 100' },
  { key: 'pitch.voice_2_feedback', fields: 'displayMin: 0, displayMax: 100' },
  // Fourth wave: remaining pitch knobs (delay/splice ms, amplitube_alpha %).
  { key: 'pitch.voice_1_delay', fields: 'displayMin: 0, displayMax: 2000' },
  { key: 'pitch.voice_2_delay', fields: 'displayMin: 0, displayMax: 2000' },
  { key: 'pitch.voice_1_splice', fields: 'displayMin: 1, displayMax: 2000' },
  { key: 'pitch.voice_2_splice', fields: 'displayMin: 1, displayMax: 2000' },
  { key: 'pitch.amplitube_alpha', fields: 'displayMin: 0, displayMax: 100' },
  // Fifth wave: CAB opaque knobs (effectId 108). Source: live 5-point sweep
  // 2026-05-30, samples/captured/decoded/ii-opaque-cab-sweep.json. All 18 fits
  // unambiguous (linear endpoints + midpoint; the 4 log knobs show a constant
  // inter-point ratio with the midpoint at the geometric mean).
  { key: 'cab.level_l', fields: 'displayMin: -80, displayMax: 0' },
  { key: 'cab.level_r', fields: 'displayMin: -80, displayMax: 0' },
  { key: 'cab.drive', fields: 'displayMin: 0, displayMax: 10' },
  { key: 'cab.saturation', fields: 'displayMin: 0, displayMax: 10' },
  { key: 'cab.room_level', fields: 'displayMin: 0, displayMax: 100' },
  { key: 'cab.room_size', fields: 'displayMin: 1, displayMax: 10' },
  { key: 'cab.mic_spacing', fields: 'displayMin: 0, displayMax: 100' },
  { key: 'cab.speaker_size', fields: 'displayMin: 0.25, displayMax: 4, displayScale: "log10"' },
  { key: 'cab.proximity', fields: 'displayMin: 0, displayMax: 10' },
  { key: 'cab.air', fields: 'displayMin: 0, displayMax: 100' },
  { key: 'cab.motor_drive', fields: 'displayMin: 0, displayMax: 10' },
  { key: 'cab.air_freq', fields: 'displayMin: 2000, displayMax: 20000, displayScale: "log10"' },
  { key: 'cab.delay_l', fields: 'displayMin: 0, displayMax: 1' },
  { key: 'cab.delay_r', fields: 'displayMin: 0, displayMax: 1' },
  { key: 'cab.proximity_r', fields: 'displayMin: 0, displayMax: 10' },
  { key: 'cab.prox_freq', fields: 'displayMin: 20, displayMax: 200, displayScale: "log10"' },
  { key: 'cab.dephase', fields: 'displayMin: 0, displayMax: 10' },
  { key: 'cab.motor_time_constant', fields: 'displayMin: 20, displayMax: 2000, displayScale: "log10"' },
];

const lines = readFileSync(PARAMS_TS, 'utf8').split(/\r?\n/);
const failures: string[] = [];

for (const c of CALS) {
  const idx = lines.findIndex((l) => l.includes(`"${c.key}":`));
  if (idx < 0) { failures.push(`${c.key}: not found`); continue; }
}
if (failures.length) {
  console.error(`REFUSING TO WRITE. ${failures.length} issue(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

let applied = 0;
let skipped = 0;
for (const c of CALS) {
  const idx = lines.findIndex((l) => l.includes(`"${c.key}":`));
  if (/displayMin:/.test(lines[idx])) { skipped++; continue; } // already calibrated
  const replaced = lines[idx].replace(/\s*\}\s*,\s*$/, `, ${c.fields} },`);
  if (replaced === lines[idx]) { console.error(`FAIL: brace insert missed on ${c.key}`); process.exit(1); }
  lines[idx] = replaced;
  applied++;
}

writeFileSync(PARAMS_TS, lines.join('\n'), 'utf8');
console.log(`Applied ${applied} new calibration rows to params.ts (skipped ${skipped} already-calibrated).`);
