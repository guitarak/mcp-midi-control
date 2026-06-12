/**
 * Apply the validated Axe-Fx II annotation-coverage entries to params.ts.
 *
 * Gate: re-runs the exact validation from validate-ii-annotation-coverage.ts
 * (ghidra symbol must sit at the shipping paramId; label must resolve). Only
 * PASS rows are applied. If ANY proposed row fails validation, the script
 * refuses to write anything.
 *
 * Each applied row, on its existing params.ts line:
 *   - inserts `parameterName` (always) and `xmlLabel` (catalog verbatim;
 *     withheld for PITCH_DELAY1/2 whose "Delay 1/2" label is shared with
 *     PITCH_TIME1/2) immediately before the closing ` },`;
 *   - for the 17 continuous controls shipping `controlType: "unknown"`,
 *     upgrades to `"knob"` (never "slider").
 *
 * Idempotent-guarded: refuses to touch a line that already has parameterName.
 * Run: npx tsx scripts/_research/apply-ii-annotation-coverage.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PARAMS_TS = path.join(ROOT, 'packages', 'fractal-midi', 'src', 'gen2', 'axe-fx-ii', 'params.ts');
const GHIDRA = path.join(ROOT, 'samples', 'captured', 'decoded', 'ghidra-axeedit2-paramtables.json');
const LABELS = path.join(ROOT, 'samples', 'captured', 'decoded', 'labels', 'axe-edit-catalog.json');

interface Proposal { key: string; parameterName: string; upgradeToKnob?: boolean; }

const PROPOSALS: Proposal[] = [
  { key: 'amp.geq_band_1', parameterName: 'DISTORT_EQ1', upgradeToKnob: true },
  { key: 'amp.geq_band_2', parameterName: 'DISTORT_EQ2', upgradeToKnob: true },
  { key: 'amp.geq_band_3', parameterName: 'DISTORT_EQ3', upgradeToKnob: true },
  { key: 'amp.geq_band_4', parameterName: 'DISTORT_EQ4', upgradeToKnob: true },
  { key: 'amp.geq_band_5', parameterName: 'DISTORT_EQ5', upgradeToKnob: true },
  { key: 'amp.geq_band_6', parameterName: 'DISTORT_EQ6', upgradeToKnob: true },
  { key: 'amp.geq_band_7', parameterName: 'DISTORT_EQ7', upgradeToKnob: true },
  { key: 'amp.geq_band_8', parameterName: 'DISTORT_EQ8', upgradeToKnob: true },
  { key: 'output.scene_1_main', parameterName: 'OUTPUT_MAIN1', upgradeToKnob: true },
  { key: 'output.scene_2_main', parameterName: 'OUTPUT_MAIN2', upgradeToKnob: true },
  { key: 'output.scene_3_main', parameterName: 'OUTPUT_MAIN3', upgradeToKnob: true },
  { key: 'output.scene_4_main', parameterName: 'OUTPUT_MAIN4', upgradeToKnob: true },
  { key: 'output.scene_5_main', parameterName: 'OUTPUT_MAIN5', upgradeToKnob: true },
  { key: 'output.scene_6_main', parameterName: 'OUTPUT_MAIN6', upgradeToKnob: true },
  { key: 'output.scene_7_main', parameterName: 'OUTPUT_MAIN7', upgradeToKnob: true },
  { key: 'output.scene_8_main', parameterName: 'OUTPUT_MAIN8', upgradeToKnob: true },
  { key: 'amp.tone_stack', parameterName: 'DISTORT_TONETYPE' },
  { key: 'amp.pwr_amp_tube', parameterName: 'DISTORT_TUBETYPE' },
  { key: 'amp.preamp_tubes', parameterName: 'DISTORT_PRETUBETYPE' },
  { key: 'amp.char_type', parameterName: 'DISTORT_HMTYPE' },
  { key: 'amp.cf_comp_type', parameterName: 'DISTORT_PRECOMPTYPE' },
  { key: 'parametriceq.freq_type_1', parameterName: 'PEQ_LFTYPE' },
  { key: 'parametriceq.freq_type_5', parameterName: 'PEQ_HFTYPE' },
  { key: 'parametriceq.freq_type_2', parameterName: 'PEQ_LMTYPE' },
  { key: 'parametriceq.freq_type_4', parameterName: 'PEQ_HMTYPE' },
  { key: 'reverb.spring_number', parameterName: 'REVERB_NUMSPRINGS', upgradeToKnob: true },
  { key: 'pitch.voice_1_pan', parameterName: 'PITCH_PAN1' },
  { key: 'pitch.voice_2_pan', parameterName: 'PITCH_PAN2' },
  { key: 'pitch.voice_1_feedback', parameterName: 'PITCH_FEEDBACK1' },
  { key: 'pitch.voice_2_feedback', parameterName: 'PITCH_FEEDBACK2' },
  { key: 'pitch.voice_1_splice', parameterName: 'PITCH_SPLICE1' },
  { key: 'pitch.voice_2_splice', parameterName: 'PITCH_SPLICE2' },
  { key: 'pitch.amplitube_alpha', parameterName: 'PITCH_AMPALPHA' },
  { key: 'pitch.amplitube_shape', parameterName: 'PITCH_AMPSHAPE' },
  { key: 'pitch.voice_1_delay', parameterName: 'PITCH_DELAY1' },
  { key: 'pitch.voice_2_delay', parameterName: 'PITCH_DELAY2' },
  { key: 'synth.filter_1', parameterName: 'SYNTH_HICUT1' },
  { key: 'synth.filter_2', parameterName: 'SYNTH_HICUT2' },
  { key: 'synth.filter_3', parameterName: 'SYNTH_HICUT3' },
  { key: 'amp.neg_feedback', parameterName: 'DISTORT_BETA' },
  { key: 'amp.cathode_resist', parameterName: 'DISTORT_CBRATIO' },
  { key: 'amp.preamp_low_cut', parameterName: 'DISTORT_HPFREQ' },
  { key: 'amp.high_cut_freq', parameterName: 'DISTORT_LPFREQ' },
  { key: 'amp.master_trim', parameterName: 'DISTORT_MVTRIM' },
  { key: 'amp.low_res', parameterName: 'DISTORT_SPKRLFGAIN' },
  { key: 'amp.b_time_const', parameterName: 'DISTORT_TIMECONST' },
  { key: 'cab.air_freq', parameterName: 'CABINET_DIRECTFREQ' },
  { key: 'cab.motor_time_constant', parameterName: 'CABINET_TIMECONST' },
  { key: 'chorus.high_cut', parameterName: 'CHORUS_HICUT' },
  { key: 'compressor.treshold', parameterName: 'COMP_THRESH' },
  { key: 'delay.duck_attn', parameterName: 'DELAY_ATTEN' },
  { key: 'delay.lfo1_depth_range', parameterName: 'DELAY_MAXDEPTH' },
  { key: 'delay.duck_thres', parameterName: 'DELAY_THRESH' },
  { key: 'drive.gain', parameterName: 'FUZZ_DRIVE' },
  { key: 'drive.volume', parameterName: 'FUZZ_LEVEL' },
  { key: 'flanger.high_cut', parameterName: 'FLANGER_HICUT' },
  { key: 'flanger.lfo_highcut', parameterName: 'FLANGER_LFOFILTER' },
  { key: 'flanger.dry_delay_shift', parameterName: 'FLANGER_MANUAL' },
  { key: 'looper.thres_level', parameterName: 'LOOPER_THRESHLEV' },
  { key: 'multidelay.master_freq', parameterName: 'MULTITAP_MSTRFREQ' },
  { key: 'multidelay.ducker_thres', parameterName: 'MULTITAP_THRESH' },
  { key: 'phaser.freq_span', parameterName: 'PHASER_FSPAN' },
  { key: 'phaser.freq_start', parameterName: 'PHASER_FSTART' },
  { key: 'ringmod.f_multiplier', parameterName: 'RINGMOD_FINE' },
  { key: 'wah.freq_min', parameterName: 'WAH_FSTART' },
  { key: 'wah.freq_max', parameterName: 'WAH_FSTOP' },
  { key: 'wah.low_cut_freq', parameterName: 'WAH_HPF' },
];

const WITHHOLD_LABEL = new Set(['PITCH_DELAY1', 'PITCH_DELAY2']);

function loadGhidra(): Map<string, number> {
  const data = JSON.parse(readFileSync(GHIDRA, 'utf8')) as {
    tables: { params: { paramId: number; name: string }[] }[];
  };
  const m = new Map<string, number>();
  for (const t of data.tables) for (const p of t.params) if (!m.has(p.name)) m.set(p.name, p.paramId);
  return m;
}
function loadLabels(): Map<string, string> {
  const data = JSON.parse(readFileSync(LABELS, 'utf8')) as {
    entries: { label: string; parameterName: string }[];
  };
  const m = new Map<string, string>();
  for (const e of data.entries) if (e.parameterName && !m.has(e.parameterName)) m.set(e.parameterName, e.label);
  return m;
}

function main(): void {
  const ghidra = loadGhidra();
  const labels = loadLabels();
  let src = readFileSync(PARAMS_TS, 'utf8');
  const lines = src.split(/\r?\n/);

  // Validate every row first; refuse to write on any failure.
  const failures: string[] = [];
  for (const p of PROPOSALS) {
    const idx = lines.findIndex((l) => l.includes(`"${p.key}":`));
    if (idx < 0) { failures.push(`${p.key}: not in params.ts`); continue; }
    const line = lines[idx];
    const shipPid = Number(/paramId:\s*(\d+)/.exec(line)?.[1] ?? NaN);
    const g = ghidra.get(p.parameterName);
    if (g !== shipPid) { failures.push(`${p.key}: ghidra ${p.parameterName}=${g} != shipPid ${shipPid}`); continue; }
    if (!WITHHOLD_LABEL.has(p.parameterName) && !labels.has(p.parameterName)) {
      failures.push(`${p.key}: no label-catalog entry for ${p.parameterName}`); continue;
    }
    if (/parameterName:/.test(line)) { failures.push(`${p.key}: already has parameterName (not idempotent-safe)`); continue; }
    if (p.upgradeToKnob && !/controlType:\s*"unknown"/.test(line)) {
      failures.push(`${p.key}: knob upgrade expected controlType "unknown", line has different`); continue;
    }
  }
  if (failures.length > 0) {
    console.error(`REFUSING TO WRITE. ${failures.length} validation failures:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }

  // Apply.
  let applied = 0;
  for (const p of PROPOSALS) {
    const idx = lines.findIndex((l) => l.includes(`"${p.key}":`));
    let line = lines[idx];
    if (p.upgradeToKnob) line = line.replace('controlType: "unknown"', 'controlType: "knob"');
    let insert = `, parameterName: ${JSON.stringify(p.parameterName)}`;
    if (!WITHHOLD_LABEL.has(p.parameterName)) {
      insert += `, xmlLabel: ${JSON.stringify(labels.get(p.parameterName)!)}`;
    }
    const replaced = line.replace(/\s*\}\s*,\s*$/, `${insert} },`);
    if (replaced === line) { console.error(`FAIL: closing-brace insert missed on ${p.key}`); process.exit(1); }
    lines[idx] = replaced;
    applied++;
  }

  src = lines.join('\n');
  writeFileSync(PARAMS_TS, src, 'utf8');
  console.log(`Applied ${applied} annotation rows to params.ts.`);
}

main();
