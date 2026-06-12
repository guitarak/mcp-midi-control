/**
 * Validate the 67 proposed Axe-Fx II annotation-coverage entries against
 * two independent on-disk sources, anchoring on the SHIPPING paramId in
 * params.ts (never trusting the proposal's or any agent's restated paramId).
 *
 * Per proposed row (key -> parameterName, xmlLabel, optional knob upgrade):
 *   1. Read the shipping entry from params.ts: block, paramId, controlType,
 *      and any parameterName/xmlLabel already present.
 *   2. Ghidra check: find the proposed symbol by EXACT name across every
 *      SeekParamTablesII table; record which (effectFamily, paramId) it sits
 *      at. PASS only if that paramId == the shipping paramId.
 *   3. Label check: find the label-catalog entry whose parameterName == the
 *      proposed symbol; record its VERBATIM label + controlType. The catalog
 *      label (not the proposal prose) is the value the patch will use.
 *
 * Output: a per-row table with verdicts and the exact field values to apply.
 * Read-only. Writes nothing. Run: npx tsx scripts/_research/validate-ii-annotation-coverage.ts
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PARAMS_TS = path.join(ROOT, 'packages', 'fractal-midi', 'src', 'gen2', 'axe-fx-ii', 'params.ts');
const GHIDRA = path.join(ROOT, 'samples', 'captured', 'decoded', 'ghidra-axeedit2-paramtables.json');
const LABELS = path.join(ROOT, 'samples', 'captured', 'decoded', 'labels', 'axe-edit-catalog.json');

interface Proposal {
  key: string;
  parameterName: string;
  xmlLabel?: string; // omitted = leave xmlLabel off (cluster 7 caveat)
  upgradeToKnob?: boolean;
}

// The 67 proposals, transcribed from annotation-coverage-proposed.md.
const PROPOSALS: Proposal[] = [
  // Cluster 1: amp graphic-EQ bands (unknown -> knob)
  { key: 'amp.geq_band_1', parameterName: 'DISTORT_EQ1', upgradeToKnob: true },
  { key: 'amp.geq_band_2', parameterName: 'DISTORT_EQ2', upgradeToKnob: true },
  { key: 'amp.geq_band_3', parameterName: 'DISTORT_EQ3', upgradeToKnob: true },
  { key: 'amp.geq_band_4', parameterName: 'DISTORT_EQ4', upgradeToKnob: true },
  { key: 'amp.geq_band_5', parameterName: 'DISTORT_EQ5', upgradeToKnob: true },
  { key: 'amp.geq_band_6', parameterName: 'DISTORT_EQ6', upgradeToKnob: true },
  { key: 'amp.geq_band_7', parameterName: 'DISTORT_EQ7', upgradeToKnob: true },
  { key: 'amp.geq_band_8', parameterName: 'DISTORT_EQ8', upgradeToKnob: true },
  // Cluster 2: output scene main (unknown -> knob)
  { key: 'output.scene_1_main', parameterName: 'OUTPUT_MAIN1', upgradeToKnob: true },
  { key: 'output.scene_2_main', parameterName: 'OUTPUT_MAIN2', upgradeToKnob: true },
  { key: 'output.scene_3_main', parameterName: 'OUTPUT_MAIN3', upgradeToKnob: true },
  { key: 'output.scene_4_main', parameterName: 'OUTPUT_MAIN4', upgradeToKnob: true },
  { key: 'output.scene_5_main', parameterName: 'OUTPUT_MAIN5', upgradeToKnob: true },
  { key: 'output.scene_6_main', parameterName: 'OUTPUT_MAIN6', upgradeToKnob: true },
  { key: 'output.scene_7_main', parameterName: 'OUTPUT_MAIN7', upgradeToKnob: true },
  { key: 'output.scene_8_main', parameterName: 'OUTPUT_MAIN8', upgradeToKnob: true },
  // Cluster 3: amp type dropdowns (select, name + label only)
  { key: 'amp.tone_stack', parameterName: 'DISTORT_TONETYPE' },
  { key: 'amp.pwr_amp_tube', parameterName: 'DISTORT_TUBETYPE' },
  { key: 'amp.preamp_tubes', parameterName: 'DISTORT_PRETUBETYPE' },
  { key: 'amp.char_type', parameterName: 'DISTORT_HMTYPE' },
  { key: 'amp.cf_comp_type', parameterName: 'DISTORT_PRECOMPTYPE' },
  // Cluster 4: PEQ frequency-type (select)
  { key: 'parametriceq.freq_type_1', parameterName: 'PEQ_LFTYPE' },
  { key: 'parametriceq.freq_type_5', parameterName: 'PEQ_HFTYPE' },
  { key: 'parametriceq.freq_type_2', parameterName: 'PEQ_LMTYPE' },
  { key: 'parametriceq.freq_type_4', parameterName: 'PEQ_HMTYPE' },
  // Cluster 5: reverb spring number (unknown -> knob)
  { key: 'reverb.spring_number', parameterName: 'REVERB_NUMSPRINGS', upgradeToKnob: true },
  // Cluster 6: pitch voice cluster
  { key: 'pitch.voice_1_pan', parameterName: 'PITCH_PAN1' },
  { key: 'pitch.voice_2_pan', parameterName: 'PITCH_PAN2' },
  { key: 'pitch.voice_1_feedback', parameterName: 'PITCH_FEEDBACK1' },
  { key: 'pitch.voice_2_feedback', parameterName: 'PITCH_FEEDBACK2' },
  { key: 'pitch.voice_1_splice', parameterName: 'PITCH_SPLICE1' },
  { key: 'pitch.voice_2_splice', parameterName: 'PITCH_SPLICE2' },
  { key: 'pitch.amplitube_alpha', parameterName: 'PITCH_AMPALPHA' },
  { key: 'pitch.amplitube_shape', parameterName: 'PITCH_AMPSHAPE' },
  // Cluster 7: pitch voice delays (name only; label caveat)
  { key: 'pitch.voice_1_delay', parameterName: 'PITCH_DELAY1' },
  { key: 'pitch.voice_2_delay', parameterName: 'PITCH_DELAY2' },
  // Cluster 8: synth filters
  { key: 'synth.filter_1', parameterName: 'SYNTH_HICUT1' },
  { key: 'synth.filter_2', parameterName: 'SYNTH_HICUT2' },
  { key: 'synth.filter_3', parameterName: 'SYNTH_HICUT3' },
  // Cluster 9: amp knob singletons
  { key: 'amp.neg_feedback', parameterName: 'DISTORT_BETA' },
  { key: 'amp.cathode_resist', parameterName: 'DISTORT_CBRATIO' },
  { key: 'amp.preamp_low_cut', parameterName: 'DISTORT_HPFREQ' },
  { key: 'amp.high_cut_freq', parameterName: 'DISTORT_LPFREQ' },
  { key: 'amp.master_trim', parameterName: 'DISTORT_MVTRIM' },
  { key: 'amp.low_res', parameterName: 'DISTORT_SPKRLFGAIN' },
  { key: 'amp.b_time_const', parameterName: 'DISTORT_TIMECONST' },
  // Cluster 10: remaining effect-block knob singletons
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

interface ShippingEntry {
  block: string;
  paramId: number;
  controlType: string;
  hasParameterName: boolean;
  hasXmlLabel: boolean;
  rawLine: string;
}

function readShipping(): Map<string, ShippingEntry> {
  const src = readFileSync(PARAMS_TS, 'utf8');
  const lines = src.split(/\r?\n/);
  const map = new Map<string, ShippingEntry>();
  for (const p of PROPOSALS) {
    const needle = `"${p.key}":`;
    const line = lines.find((l) => l.includes(needle));
    if (!line) continue;
    const block = /block:\s*"([^"]+)"/.exec(line)?.[1] ?? '?';
    const paramId = Number(/paramId:\s*(\d+)/.exec(line)?.[1] ?? NaN);
    const controlType = /controlType:\s*"([^"]+)"/.exec(line)?.[1] ?? '?';
    map.set(p.key, {
      block,
      paramId,
      controlType,
      hasParameterName: /parameterName:/.test(line),
      hasXmlLabel: /xmlLabel:/.test(line),
      rawLine: line.trim(),
    });
  }
  return map;
}

interface GhidraHit { family: string; paramId: number; }

function readGhidra(): Map<string, GhidraHit> {
  const data = JSON.parse(readFileSync(GHIDRA, 'utf8')) as {
    tables: { effectFamily: string; params: { paramId: number; name: string }[] }[];
  };
  // symbol -> all (family, paramId) it appears at. Symbols are family-prefixed
  // and effectively unique, but record collisions if any.
  const map = new Map<string, GhidraHit>();
  const collisions = new Map<string, GhidraHit[]>();
  for (const t of data.tables) {
    for (const p of t.params) {
      const hit = { family: t.effectFamily, paramId: p.paramId };
      if (map.has(p.name)) {
        const arr = collisions.get(p.name) ?? [map.get(p.name)!];
        arr.push(hit);
        collisions.set(p.name, arr);
      } else {
        map.set(p.name, hit);
      }
    }
  }
  if (collisions.size > 0) {
    console.log('NOTE: symbols appearing in >1 table (first occurrence used):');
    for (const [name, hits] of collisions) {
      console.log(`  ${name}: ${hits.map((h) => `${h.family}#${h.paramId}`).join(', ')}`);
    }
    console.log('');
  }
  return map;
}

interface LabelHit { label: string; controlType: string; }

function readLabels(): Map<string, LabelHit> {
  const data = JSON.parse(readFileSync(LABELS, 'utf8')) as {
    entries: { label: string; parameterName: string; controlType: string }[];
  };
  // parameterName -> first label entry. Record distinct labels if a symbol
  // maps to more than one (variant pages can repeat).
  const map = new Map<string, LabelHit>();
  const multi = new Map<string, Set<string>>();
  for (const e of data.entries) {
    if (!e.parameterName) continue;
    if (!map.has(e.parameterName)) {
      map.set(e.parameterName, { label: e.label, controlType: e.controlType });
    }
    const set = multi.get(e.parameterName) ?? new Set<string>();
    set.add(e.label);
    multi.set(e.parameterName, set);
  }
  // Attach multi-label warnings via a side channel printed in main.
  (map as unknown as { _multi: Map<string, Set<string>> })._multi = multi;
  return map;
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function main(): void {
  const shipping = readShipping();
  const ghidra = readGhidra();
  const labels = readLabels();
  const multi = (labels as unknown as { _multi: Map<string, Set<string>> })._multi;

  let pass = 0;
  let ghidraFail = 0;
  let labelMissing = 0;
  const applyRows: { key: string; parameterName: string; xmlLabel?: string; knob: boolean }[] = [];

  console.log('row | key | shipPid | ghidra(fam#pid) | gOK | catalogLabel | controlType | verdict');
  console.log('----|-----|---------|-----------------|-----|--------------|-------------|--------');
  for (const p of PROPOSALS) {
    const sh = shipping.get(p.key);
    if (!sh) {
      console.log(`SKIP ${p.key}: not found in params.ts`);
      continue;
    }
    const g = ghidra.get(p.parameterName);
    const gOK = !!g && g.paramId === sh.paramId;
    const lab = labels.get(p.parameterName);
    const labels_seen = multi.get(p.parameterName);
    const multiNote = labels_seen && labels_seen.size > 1 ? ` [${labels_seen.size} labels]` : '';

    let verdict: string;
    if (!gOK) {
      verdict = g ? `GHIDRA-MISMATCH(${g.family}#${g.paramId})` : 'GHIDRA-MISSING';
      ghidraFail++;
    } else if (!lab) {
      verdict = 'LABEL-MISSING';
      labelMissing++;
    } else {
      verdict = 'PASS';
      pass++;
    }

    const labelStr = lab ? JSON.stringify(lab.label) + multiNote : '-';
    console.log(
      `${p.key} | pid${sh.paramId} | ${g ? g.family + '#' + g.paramId : '-'} | ${gOK ? 'Y' : 'N'} | ${labelStr} | ${lab?.controlType ?? '-'} | ${verdict} | (was ${sh.controlType}${sh.hasParameterName ? ' +pn' : ''}${sh.hasXmlLabel ? ' +xml' : ''})`,
    );

    if (verdict === 'PASS') {
      // Use the catalog's verbatim label, except cluster-7 delays where the
      // proposal intentionally withholds xmlLabel pending the "Delay 1/2" bind check.
      const withholdLabel = p.parameterName === 'PITCH_DELAY1' || p.parameterName === 'PITCH_DELAY2';
      applyRows.push({
        key: p.key,
        parameterName: p.parameterName,
        xmlLabel: withholdLabel ? undefined : lab!.label,
        knob: !!p.upgradeToKnob,
      });
    }
  }

  console.log('');
  console.log(`SUMMARY: ${pass} PASS, ${ghidraFail} ghidra-fail, ${labelMissing} label-missing, of ${PROPOSALS.length} proposed.`);
  console.log('');
  console.log('APPLY-READY ROWS (parameterName ghidra-anchored at shipping paramId; xmlLabel = catalog verbatim):');
  console.log(JSON.stringify(applyRows, null, 2));

  // Cluster-7 disambiguation: what label binds PITCH_DELAY1/2 vs PITCH_TIME1/2?
  console.log('');
  console.log('CLUSTER-7 LABEL BIND CHECK (Delay vs Time):');
  for (const sym of ['PITCH_DELAY1', 'PITCH_DELAY2', 'PITCH_TIME1', 'PITCH_TIME2']) {
    const l = labels.get(sym);
    const set = multi.get(sym);
    console.log(`  ${sym}: ${l ? JSON.stringify(l.label) : '(no label entry)'}${set && set.size > 1 ? ' all=' + JSON.stringify([...set]) : ''}`);
  }
}

main();
