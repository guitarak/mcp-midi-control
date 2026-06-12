/**
 * Apply post-generation calibration overlay to `src/gen3/axe-fx-iii/params.ts`.
 *
 * The base params.ts is generated from three sources (AM4-borrow,
 * AxeEdit XML controlType, universal Fractal convention) but the base
 * generator leaves ~570 entries as `unit: 'unverified'` because their
 * names don't match the three source heuristics it knows about.
 *
 * This script extends the universal-Fractal-convention fallback with a
 * broader suffix table covering the long-tail of `'unverified'` names.
 * It mutates `params.ts` in place, adding `// post-gen overlay: <reason>`
 * trailing comments for every modified entry so the source of the
 * inferred calibration is auditable.
 *
 * Re-run after every regeneration of params.ts:
 *
 *     npx tsx scripts/axe-fx-iii/apply-calibration-overlay.ts
 *
 * Idempotent — running twice produces no diff (the script skips
 * entries that already carry a `// post-gen overlay:` tag).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const PARAMS_PATH = resolve(repoRoot, 'src', 'gen3', 'axe-fx-iii', 'params.ts');

// ── Suffix-convention table ───────────────────────────────────────
//
// Each rule names the suffix(es) it matches (case-sensitive UPPER_SNAKE
// matching the III's symbol convention) and the calibration it should
// apply when an entry's `name` ends with that suffix. `unit` is
// required; `displayMin`/`displayMax`/`scaling` are optional and
// applied only when the field is missing from the entry.
//
// The `// post-gen overlay: <reason>` trailing comment is appended so
// readers can audit the source of the inferred calibration.

interface Rule {
  suffixes: string[];
  unit:
    | 'bipolar_percent'
    | 'count'
    | 'db'
    | 'degrees'
    | 'enum'
    | 'hz'
    | 'knob_0_10'
    | 'knob_0_20'
    | 'ms'
    | 'numeric'
    | 'percent'
    | 'pf'
    | 'ratio'
    | 'seconds'
    | 'semitones';
  displayMin?: number;
  displayMax?: number;
  scaling?: 'linear' | 'log10';
  reason: string;
}

const RULES: Rule[] = [
  // Binary toggles (universal Fractal convention — every block uses
  // these for OFF/ON state).
  {
    suffixes: ['_MUTE', '_MUTE1', '_MUTE2', '_MUTE3', '_MUTE4', '_BYP', '_BYPASS', '_ENABLE', '_DISABLE', '_INVERT', '_HOLD', '_AUTO', '_AUTOON', '_AUTOENABLE'],
    unit: 'enum',
    reason: 'binary toggle (Fractal convention OFF/ON)',
  },

  // Type / mode / model / shape pickers (always enum across the family).
  {
    suffixes: ['_MODE', '_TYPE', '_TYPE2', '_TYPE3', '_TYPE4', '_MODEL', '_SHAPE', '_TAPER', '_SUBDIV', '_SLOT', '_MAPPING', '_MENU', '_STOP'],
    unit: 'enum',
    reason: 'discriminator (Fractal convention enum)',
  },

  // Mic models (drop-down from a fixed factory list).
  {
    suffixes: ['_MIC', '_MIC1', '_MIC2', '_MIC3', '_MIC4'],
    unit: 'enum',
    reason: 'mic-model picker (Fractal convention enum)',
  },

  // Frequency knobs (every -Hz-suffixed param in Fractal's UI).
  {
    suffixes: ['_FREQ', '_LPFREQ', '_HPFREQ', '_WSLPF', '_WSHPF'],
    unit: 'hz',
    displayMin: 20,
    displayMax: 20000,
    scaling: 'log10',
    reason: 'frequency knob (Fractal convention 20 Hz..20 kHz log)',
  },

  // Time-based knobs (delay/attack/release/predelay all use ms).
  {
    suffixes: ['_TIME', '_PREDELAY', '_ATTACK', '_RELEASE', '_HOLDTIME'],
    unit: 'ms',
    displayMin: 0,
    displayMax: 2000,
    scaling: 'log10',
    reason: 'time knob (Fractal convention ms, log scale)',
  },

  // Level / gain knobs (output, send, return) in dB.
  {
    suffixes: ['_LEVEL', '_OUTLEVEL', '_SENDLEVEL', '_INLEVEL', '_INPUTLEVEL', '_RETURN', '_RETURNLEVEL'],
    unit: 'db',
    displayMin: -80,
    displayMax: 20,
    reason: 'level/gain knob (Fractal convention dB)',
  },

  // Threshold (compressors, gates) in dB.
  {
    suffixes: ['_THRESHOLD', '_THRES'],
    unit: 'db',
    displayMin: -80,
    displayMax: 0,
    reason: 'threshold knob (Fractal convention dB)',
  },

  // Ratio (compressor) — unitless ratio.
  {
    suffixes: ['_RATIO'],
    unit: 'ratio',
    displayMin: 1,
    displayMax: 50,
    reason: 'compression ratio (Fractal convention)',
  },

  // Depth / amount (modulation, chorus, etc.) — percent.
  {
    suffixes: ['_DEPTH', '_AMOUNT', '_GAINMONITOR'],
    unit: 'percent',
    displayMin: 0,
    displayMax: 100,
    reason: 'depth/amount knob (Fractal convention percent)',
  },

  // Rate (LFO, modulation) — Hz.
  {
    suffixes: ['_RATE'],
    unit: 'hz',
    displayMin: 0.01,
    displayMax: 20,
    scaling: 'log10',
    reason: 'LFO rate (Fractal convention Hz, log scale)',
  },

  // Tempo (BPM-locked).
  {
    suffixes: ['_TEMPO', '_TRACKTEMPO', '_REFTEMPO'],
    unit: 'numeric',
    displayMin: 30,
    displayMax: 250,
    reason: 'BPM (Fractal convention)',
  },

  // Counters / numbers / orders.
  {
    suffixes: ['_NUMBER', '_NUM', '_COUNT', '_ORDER', '_NORM1', '_NORM2', '_OFFSET1', '_SPARE1', '_SPARE2', '_SPARE3', '_R1', '_R2', '_R3', '_R4'],
    unit: 'numeric',
    reason: 'numeric index/counter (Fractal convention)',
  },

  // Graph display widgets (RTA meter, XY display) — read-only numeric.
  {
    suffixes: ['_XMARK', '_YMARK', '_METER', '_NOISE'],
    unit: 'numeric',
    reason: 'display widget (read-only meter/graph)',
  },

  // FC layout / switch config — these are slot pickers (enum).
  {
    suffixes: ['_PFC1', '_PFC2', '_PFC3', '_PFC4'],
    unit: 'enum',
    reason: 'FC switch-slot picker (Fractal convention enum)',
  },

  // Leakage / crosstalk — percent.
  {
    suffixes: ['_XFLEAKAGE', '_LEAKAGE', '_CROSSTALK'],
    unit: 'percent',
    displayMin: 0,
    displayMax: 100,
    reason: 'leakage/crosstalk (Fractal convention percent)',
  },

  // Array-base sentinels (firmware-internal indices marking the start
  // of repeating tables — _BEGIN entries are array headers, not knobs).
  // Tag as `count` so verifiers can distinguish from user-facing params.
  {
    suffixes: ['_BEGIN'],
    unit: 'count',
    reason: 'array-base sentinel (firmware-internal, not user-facing)',
  },

  // Preset bank / bank-mode pickers.
  {
    suffixes: ['_PRESETS', '_BANK'],
    unit: 'enum',
    reason: 'bank/preset picker (Fractal convention enum)',
  },

  // Logo / color / display config (global cosmetic settings).
  {
    suffixes: ['_LOGO', '_COLOR'],
    unit: 'enum',
    reason: 'cosmetic global picker (Fractal convention enum)',
  },

  // MIDI CC numbers — 0-127 range, integer.
  {
    suffixes: ['_CC', '_METRONOME_CC'],
    unit: 'numeric',
    displayMin: 0,
    displayMax: 127,
    reason: 'MIDI CC number (0..127)',
  },

  // Controller / effect ID — integer identifier within the firmware.
  {
    suffixes: ['_CTRLID', '_EFFECTID', '_PARAM'],
    unit: 'numeric',
    reason: 'firmware identifier (numeric)',
  },

  // Deconvolution / IR-capture mode.
  {
    suffixes: ['_DECONV'],
    unit: 'enum',
    reason: 'IR-capture mode (Fractal convention enum)',
  },

  // Drive/feedback type variants (don't end in _TYPE directly).
  {
    suffixes: ['_DRIVETYPE', '_FBTYPE', '_BASETYPE', '_DECAYSTYLE', '_FORMCORRECT', '_DUB', '_ACCUMULATE'],
    unit: 'enum',
    reason: 'effect-style picker (Fractal convention enum)',
  },

  // Layout / FC slot pickers (numeric or enum, both render in editor UI as selectors).
  {
    suffixes: ['_LAYOUT1', '_LAYOUT2', '_LAYOUT3', '_LAYOUT4', '_LAYOUT5', '_LAYOUT6', '_LAYOUT7', '_LAYOUT8', '_FC1', '_FC2', '_FC3', '_FC4'],
    unit: 'enum',
    reason: 'layout/FC slot picker (Fractal convention enum)',
  },

  // Feedback-matrix entries — interchannel feedback in percent.
  {
    suffixes: ['_FEEDL', '_FEEDRL', '_FEEDBACK12', '_FEEDBACK23', '_FEEDBACK34', '_FEEDBACK41'],
    unit: 'percent',
    displayMin: 0,
    displayMax: 100,
    reason: 'feedback matrix (Fractal convention percent)',
  },

  // Global mix (post-block wet/dry mixer).
  {
    suffixes: ['_GLOBALMIX'],
    unit: 'percent',
    displayMin: 0,
    displayMax: 100,
    reason: 'global mix (Fractal convention percent)',
  },

  // Band index (within multiband processor).
  {
    suffixes: ['_BAND'],
    unit: 'numeric',
    reason: 'multiband band index (Fractal convention)',
  },

  // Firmware version reporting.
  {
    suffixes: ['_VERSION'],
    unit: 'numeric',
    reason: 'firmware version field (Fractal convention)',
  },

  // Customer scale labels (single-char string fields).
  {
    suffixes: ['_CUSTOM_SHIFT_BEGIN', '_SCALE_CONTEXT_MENU'],
    unit: 'enum',
    reason: 'custom-scale picker (Fractal convention enum)',
  },
];

// Suffixes we deliberately leave as 'unverified' because they are
// string-typed in the editor (the Param interface has no 'string' unit;
// codec layer can't translate them mechanically). The acceptance gate
// in verify-axe-fx-iii-calibration.ts treats these as known-string and
// passes them through.
export const STRING_TYPED_SUFFIXES = ['_NAME', '_NAME1', '_NAME2', '_NAME3', '_NAME4', '_LABEL1', '_LABEL2', '_MSG'];

// ── Patcher ───────────────────────────────────────────────────────

interface ParamEntry {
  raw: string;          // full original line including trailing newline
  family: string;
  paramId: number;
  name: string;
  hasUnverified: boolean;
  hasPostGenTag: boolean;
}

// Matches param entries in any of the three structures the file
// carries (PARAMS array, PARAMS_BY_FAMILY map, PARAM_BY_KEY map).
// Anchored on the `{ family: ... paramId: ... name: ...` shape.
const ENTRY_RE = /\{\s*family:\s*'([^']+)',\s*paramId:\s*(\d+),\s*name:\s*'([^']+)',[^}]*\}/;

function parseLine(line: string): ParamEntry | null {
  const m = line.match(ENTRY_RE);
  if (!m) return null;
  return {
    raw: line,
    family: m[1],
    paramId: parseInt(m[2], 10),
    name: m[3],
    hasUnverified: /unit:\s*'unverified'/.test(line),
    hasPostGenTag: /post-gen overlay:/.test(line),
  };
}

function applyRule(line: string, entry: ParamEntry, rule: Rule): string {
  // Build the replacement object fields.
  const fields: string[] = [`unit: '${rule.unit}'`];
  if (rule.displayMin !== undefined) fields.push(`displayMin: ${rule.displayMin}`);
  if (rule.displayMax !== undefined) fields.push(`displayMax: ${rule.displayMax}`);
  if (rule.scaling) fields.push(`scaling: '${rule.scaling}'`);
  const replacement = fields.join(', ');
  // Replace the existing `unit: 'unverified'` with the new fields.
  let next = line.replace(/unit:\s*'unverified'/, replacement);
  // Append post-gen overlay tag (preserve existing trailing comment if any).
  const tagComment = ` // post-gen overlay: ${rule.reason}`;
  if (/\/\/.*$/.test(next)) {
    // Existing trailing comment — append after it.
    next = next.replace(/(\/\/[^\n]*)\s*$/, `$1${tagComment}`);
  } else {
    // No comment — append directly.
    next = next.replace(/\s*$/, tagComment);
  }
  return next;
}

function findRule(name: string): Rule | null {
  for (const rule of RULES) {
    for (const suffix of rule.suffixes) {
      if (name.endsWith(suffix)) return rule;
    }
  }
  return null;
}

function main(): void {
  const src = readFileSync(PARAMS_PATH, 'utf8');
  const lines = src.split('\n');
  let modified = 0;
  let skipped = 0;
  let alreadyTagged = 0;
  const remaining: { name: string; suffix: string }[] = [];
  const ruleHits = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const entry = parseLine(lines[i]);
    if (!entry) continue;
    if (!entry.hasUnverified) continue;
    if (entry.hasPostGenTag) {
      alreadyTagged++;
      continue;
    }
    const rule = findRule(entry.name);
    if (!rule) {
      skipped++;
      // Track which suffix (last token after underscore) we didn't catch.
      const parts = entry.name.split('_');
      remaining.push({ name: entry.name, suffix: parts[parts.length - 1] });
      continue;
    }
    lines[i] = applyRule(lines[i], entry, rule);
    modified++;
    ruleHits.set(rule.reason, (ruleHits.get(rule.reason) ?? 0) + 1);
  }

  writeFileSync(PARAMS_PATH, lines.join('\n'));

  console.log(`apply-calibration-overlay:`);
  console.log(`  modified:        ${modified}`);
  console.log(`  already-tagged:  ${alreadyTagged}`);
  console.log(`  still-unverified: ${skipped}`);
  console.log(`\nrule-hit breakdown:`);
  for (const [reason, n] of [...ruleHits.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  ${reason}`);
  }

  if (remaining.length > 0 && remaining.length <= 40) {
    console.log(`\nremaining-unverified sample:`);
    for (const r of remaining.slice(0, 40)) {
      console.log(`  ${r.name}  (suffix=${r.suffix})`);
    }
  } else if (remaining.length > 0) {
    const topSuffixes = new Map<string, number>();
    for (const r of remaining) topSuffixes.set(r.suffix, (topSuffixes.get(r.suffix) ?? 0) + 1);
    console.log(`\nremaining-unverified top suffixes:`);
    for (const [s, n] of [...topSuffixes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${n.toString().padStart(4)}  _${s}`);
    }
  }
}

main();
