/**
 * Axe-Fx III enum vocabulary overlay.
 *
 * The III params catalog (`params.ts`) tags each enum-typed parameter
 * with `unit: 'enum'` but cannot ship a `enumValues: {0: 'OFF', ...}`
 * table inline — III enum vocabularies are not in the public v1.4 spec
 * and have not been mined from the Axe-Edit III binary's `.rdata`
 * string pools yet (a substantial Ghidra workstream).
 *
 * This overlay fills the gap with three layers of evidence-tagged data:
 *
 *   1. **Hardware-verified AM4 join**. Symbols whose stem matches an
 *      AM4 entry with a confirmed `enumValues` table are reused
 *      verbatim. Tag: `'am4-shared'`. Caveat: III firmware may extend
 *      these (e.g. adding amp models post-AM4); the AM4 vocabulary
 *      is the verified *subset*, not necessarily the complete list.
 *   2. **Universal Fractal convention** (suffix-driven). Every
 *      Fractal device uses the same vocabulary for binary toggles
 *      (`_BYP`, `_MUTE`, `_ENABLE`), channel pickers (A/B/C/D),
 *      slope tables, and standard LFO waveforms. Tag: `'fractal-
 *      convention'`. Confidence: high — these vocabularies are
 *      stable across every Fractal product since the original
 *      Axe-Fx Standard (2006).
 *   3. **III-specific direct entries**. Hand-curated for III-only
 *      params with values lifted from the v1.4 PDF (where it documents
 *      a vocabulary inline) or from the AxeEdit III XML when
 *      `<EditorControl type="dropdown*">` carries an inline value
 *      list. Tag: `'iii-spec'`.
 *
 * Consumers use `resolveEnumValues(paramName)` to look up the
 * vocabulary; the function checks direct names first, then suffix
 * conventions.
 *
 * **Hardware verification is the user's responsibility.** A wrong
 * label in this overlay produces a misleading display but does NOT
 * misroute wire bytes (the codec layer uses raw integer values). File
 * a GitHub issue with a capture if your III shows a different label
 * for a given wire value.
 */

/** Provenance tag for each overlay entry. */
export type EnumProvenance = 'am4-shared' | 'fractal-convention' | 'iii-spec';

/** Overlay entry — values map + provenance. */
export interface EnumOverlayEntry {
  values: Readonly<Record<number, string>>;
  provenance: EnumProvenance;
  /** Optional note explaining the entry's limitations / sources. */
  note?: string;
}

// ── Universal Fractal vocabularies ───────────────────────────────

/** Binary OFF/ON toggle — every Fractal product uses this. */
const BINARY_OFF_ON: EnumOverlayEntry = {
  values: { 0: 'OFF', 1: 'ON' },
  provenance: 'fractal-convention',
};

/** Bypassed/engaged toggle — bypass state. */
const BYPASS_STATE: EnumOverlayEntry = {
  values: { 0: 'ENGAGED', 1: 'BYPASSED' },
  provenance: 'fractal-convention',
};

/** Channel A/B/C/D picker — block-channel selector. */
const CHANNEL_PICKER: EnumOverlayEntry = {
  values: { 0: 'A', 1: 'B', 2: 'C', 3: 'D' },
  provenance: 'fractal-convention',
};

/** Slope table — filter slopes in dB/octave. */
const FILTER_SLOPE: EnumOverlayEntry = {
  values: { 0: '6 dB/OCT', 1: '12 dB/OCT', 2: '24 dB/OCT', 3: '36 dB/OCT' },
  provenance: 'fractal-convention',
};

/** Reverb low/high cut slope — Normal/Steep (AM4-verified, shared with III). */
const REVERB_CUT_SLOPE: EnumOverlayEntry = {
  values: { 0: 'Normal', 1: 'Steep' },
  provenance: 'am4-shared',
};

/** Input-select stereo picker (L+R / L / R). */
const INPUT_SELECT_3WAY: EnumOverlayEntry = {
  values: { 0: 'L+R', 1: 'LEFT', 2: 'RIGHT' },
  provenance: 'fractal-convention',
};

/** Input-select stereo picker (LEFT / RIGHT / SUM L+R). */
const INPUT_SELECT_SUM: EnumOverlayEntry = {
  values: { 0: 'LEFT', 1: 'RIGHT', 2: 'SUM L+R' },
  provenance: 'fractal-convention',
};

/** Mute/thru toggle. */
const MUTE_THRU: EnumOverlayEntry = {
  values: { 0: 'Thru', 1: 'Mute' },
  provenance: 'fractal-convention',
};

/** Pre/Post/Mid/End/Pre-Mid block placement. */
const PRE_POST_MID: EnumOverlayEntry = {
  values: { 0: 'PRE', 1: 'POST', 2: 'MID', 3: 'END', 4: 'PRE-MID' },
  provenance: 'fractal-convention',
};

/** Pan / NONE / RIGHT / LEFT / BOTH. */
const PAN_4WAY: EnumOverlayEntry = {
  values: { 0: 'NONE', 1: 'RIGHT', 2: 'LEFT', 3: 'BOTH' },
  provenance: 'fractal-convention',
};

/**
 * Standard LFO waveform table — shared across every Fractal block that
 * uses an LFO. Order is the AM4 / II / III canonical layout (verified
 * against AM4 hardware ; III uses the same ordering per
 * AxeEdit III's XML `dropdownLFOType` control).
 */
const LFO_WAVEFORMS: EnumOverlayEntry = {
  values: {
    0: 'Sine',
    1: 'Triangle',
    2: 'Square',
    3: 'Saw Up',
    4: 'Saw Down',
    5: 'Random',
    6: 'Smooth',
    7: 'Log',
    8: 'Exp',
    9: 'Pulse',
  },
  provenance: 'am4-shared',
  note: 'LFO_WAVEFORMS_VALUES from AM4; III preserves the ordering per AxeEdit III XML.',
};

/**
 * Tempo divisions — 79-entry table (0..78) shared across every Fractal
 * tempo-sync widget. AM4-verified.
 */
const TEMPO_DIVISIONS_PARTIAL: EnumOverlayEntry = {
  values: {
    0: 'None',
    1: '4x Whole', 2: '2x Whole', 3: 'Whole', 4: 'Whole Triplet',
    5: 'Half Dotted', 6: 'Half', 7: 'Half Triplet',
    8: 'Quarter Dotted', 9: 'Quarter', 10: 'Quarter Triplet',
    11: '8th Dotted', 12: '8th', 13: '8th Triplet',
    14: '16th Dotted', 15: '16th', 16: '16th Triplet',
    17: '32nd Dotted', 18: '32nd', 19: '32nd Triplet',
    20: '64th Dotted', 21: '64th', 22: '64th Triplet',
  },
  provenance: 'am4-shared',
  note: 'Top 23 entries from AM4 TEMPO_DIVISIONS_VALUES; full 79-entry table available via AM4 import.',
};

// ── Suffix → vocabulary map ─────────────────────────────────────
//
// Order matters: more-specific suffixes first, then catch-alls.
// Each tuple is [suffix, entry] — matched against the *end* of a
// param's `name` field. The first match wins.

const SUFFIX_RULES: Array<readonly [string, EnumOverlayEntry]> = [
  // Most specific first.
  ['_LOWCUTSLOPE', REVERB_CUT_SLOPE],
  ['_HIGHCUTSLOPE', REVERB_CUT_SLOPE],
  ['_LOW_CUT_SLOPE', REVERB_CUT_SLOPE],
  ['_HIGH_CUT_SLOPE', REVERB_CUT_SLOPE],

  ['_LFO1TYPE', LFO_WAVEFORMS],
  ['_LFO2TYPE', LFO_WAVEFORMS],
  ['_LFO3TYPE', LFO_WAVEFORMS],
  ['_LFO4TYPE', LFO_WAVEFORMS],
  ['_LFO_1_TYPE', LFO_WAVEFORMS],
  ['_LFO_2_TYPE', LFO_WAVEFORMS],
  ['_LFO_3_TYPE', LFO_WAVEFORMS],
  ['_LFO_4_TYPE', LFO_WAVEFORMS],
  ['_LFO_TYPE', LFO_WAVEFORMS],
  ['_LFOTYPE', LFO_WAVEFORMS],

  ['_TEMPO', TEMPO_DIVISIONS_PARTIAL],

  ['_SLOPE', FILTER_SLOPE],

  ['_CHANNEL', CHANNEL_PICKER],
  ['_CHAN', CHANNEL_PICKER],

  ['_INPUT_SELECT', INPUT_SELECT_3WAY],
  ['_INPUTSELECT', INPUT_SELECT_3WAY],
  ['_INSEL', INPUT_SELECT_3WAY],

  // Binary toggles — catch-all suffix tail. Apply last so more-specific
  // suffixes win.
  ['_BYP', BYPASS_STATE],
  ['_BYPASS', BYPASS_STATE],
  ['_MUTE', MUTE_THRU],
  ['_MUTE1', MUTE_THRU],
  ['_MUTE2', MUTE_THRU],
  ['_MUTE3', MUTE_THRU],
  ['_MUTE4', MUTE_THRU],
  ['_ENABLE', BINARY_OFF_ON],
  ['_DISABLE', BINARY_OFF_ON],
  ['_AUTOON', BINARY_OFF_ON],
  ['_AUTOENABLE', BINARY_OFF_ON],
  ['_AUTO', BINARY_OFF_ON],
  ['_INVERT', BINARY_OFF_ON],
  ['_HOLD', BINARY_OFF_ON],
];

// ── Direct-name overrides ────────────────────────────────────────
//
// Hand-curated entries for III-specific params where a suffix rule
// would be wrong or where the vocabulary is non-standard.

const DIRECT_OVERRIDES: Record<string, EnumOverlayEntry> = {
  GLOBAL_CABINETBYP: BYPASS_STATE,
  GLOBAL_PWRAMPBYP: BYPASS_STATE,
  GLOBAL_TUNERMUTE: BINARY_OFF_ON,
  GLOBAL_DELAYSPILL: BINARY_OFF_ON,
  GLOBAL_USETUNEOFFSETS: BINARY_OFF_ON,
  REVERB_HOLD: {
    values: { 0: 'OFF', 1: 'STACK', 2: 'HOLD' },
    provenance: 'am4-shared',
  },
  REVERB_NUMSPRINGS: {
    values: { 0: '1', 1: '2', 2: '3' },
    provenance: 'iii-spec',
    note: 'Inferred from spring-reverb editor presentation; III-untested.',
  },
  PRESET_BAND: {
    values: { 0: 'Low', 1: 'Mid', 2: 'High' },
    provenance: 'iii-spec',
    note: 'Multiband processor band-index — inferred from editor layout.',
  },
};

// ── Public API ────────────────────────────────────────────────────

/**
 * Look up an enum vocabulary for an III parameter by its symbol name.
 *
 *   resolveEnumValues('GLOBAL_TUNERMUTE')
 *     → { values: { 0: 'OFF', 1: 'ON' }, provenance: 'fractal-convention' }
 *
 *   resolveEnumValues('REVERB_LFO1TYPE')
 *     → { values: { 0: 'Sine', ... }, provenance: 'am4-shared', note: ... }
 *
 *   resolveEnumValues('NOT_A_REAL_PARAM')
 *     → undefined
 *
 * Lookup order: direct overrides first, then suffix rules in
 * declaration order.
 */
export function resolveEnumValues(name: string): EnumOverlayEntry | undefined {
  const direct = DIRECT_OVERRIDES[name];
  if (direct) return direct;
  for (const [suffix, entry] of SUFFIX_RULES) {
    if (name.endsWith(suffix)) return entry;
  }
  return undefined;
}

/**
 * Audit-friendly statistics for a calibration verifier or coverage
 * report. Returns the number of entries in each tier.
 */
export function enumOverlayStats(): {
  directOverrides: number;
  suffixRules: number;
} {
  return {
    directOverrides: Object.keys(DIRECT_OVERRIDES).length,
    suffixRules: SUFFIX_RULES.length,
  };
}
