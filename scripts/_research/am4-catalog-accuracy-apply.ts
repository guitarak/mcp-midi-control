/**
 * am4-catalog-accuracy-apply.ts
 *
 * One-shot codemod for the 2026-06-09 AM4 catalog accuracy pass. Applies, to
 * packages/fractal-midi/src/am4/params.ts and cacheParams.ts:
 *
 *   1. Regeneration of the amp-bank rows (pidLow 0x3a section 10, pidLow 0x3e
 *      section 11) that the corrected zero-resync cache walk contradicts:
 *      kind (enum vs float), displayMin/displayMax, enumValues, scaling.
 *   2. The 72 family-4/5 log10 flips (am4-taper-contradictions.json),
 *      hardware-anchored by HW-131 (II reverb Low Cut geometric-mean reading).
 *   3. Display-only unit-label fixes (amp.proximity / amp.tremfreq dB->Hz,
 *      rotary time constants count->seconds, reverb.low_decay multiplier
 *      suffix via displayUnit).
 *
 * Withheld rows (hardware conflict, degenerate cache record, or cache scale
 * with no existing Unit) are listed in SKIP_FLAGGED below and documented in
 * docs/_private/AM4-CATALOG-ACCURACY-PASS-2026-06-09.md.
 *
 * Run once: npx tsx scripts/_research/am4-catalog-accuracy-apply.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

const WALK = 'samples/captured/local-caches-2026-06-09/effectDefinitions_15_2p0.walk.json';
const CONTRA = 'samples/captured/local-caches-2026-06-09/am4-taper-contradictions.json';
const PARAMS = 'packages/fractal-midi/src/am4/params.ts';
const CACHE = 'packages/fractal-midi/src/am4/cacheParams.ts';

interface WalkRec {
  kind: 'float' | 'enum';
  section: number;
  id: number;
  tc: number;
  min: number;
  max: number;
  def: number; // display scale
  step: number;
  count?: number;
  values?: string[];
}

const walk = JSON.parse(readFileSync(WALK, 'utf8')) as { records: WalkRec[] };
const bySection = new Map<number, Map<number, WalkRec>>();
for (const r of walk.records) {
  if (r.id >= 0xff00) continue;
  if (!bySection.has(r.section)) bySection.set(r.section, new Map());
  bySection.get(r.section)!.set(r.id, r);
}

const clean = (n: number): number => Number(n.toPrecision(6));
const isLog10 = (r: WalkRec): boolean => {
  const fam = (r.tc >> 4) & 0x0f;
  return r.kind === 'float' && (fam === 4 || fam === 5) && r.min * r.def > 0;
};

// ---------------------------------------------------------------------------
// Decision table
// ---------------------------------------------------------------------------

/** Rows withheld from the cache regeneration, each with its reason (mirrored
 * in the findings doc). NOT touched by this codemod. */
const SKIP_FLAGGED: Record<string, string> = {
  'amp.low_reso': 'cache scale 0.41667 has no existing Unit; encode-scale fix needs new unit machinery',
  'amp.hi_reso': 'cache scale 0.41667 has no existing Unit',
  'amp.spkr_drive': 'cache scale 2 has no existing Unit',
  'amp.definition': 'cache scale 31.623 has no existing Unit (known since the old parse; count was a deliberate stopgap)',
  'amp.cab_master_level': 'HARDWARE CONFLICT: 2026-04-30 screenshot shows wire 0.110 -> display 1.1 (scale 10); cache says scale 100. Hardware outranks cache.',
  'amp.cab_vu': 'cache record degenerate (min=max=0, monitor); no info',
  'amp.cab_level_1': 'cache record degenerate; shipped range kept',
  'amp.cab_level_2': 'cache record degenerate; shipped range kept',
  'amp.cab_order': 'cache record degenerate; shipped range kept',
  'amp.cab_gain_monitor': 'cache record degenerate; shipped range kept',
  'amp.cab_zoom': 'hardware-confirmed 2026-06-05 (display-only zoom enum); cache float-vs-enum diff is cosmetic',
  'amp.cab_dynacab_z_1': 'cache scale 24 has no existing Unit',
  'amp.cab_dynacab_z_2': 'cache scale 24 has no existing Unit',
};

/** Keys deleted outright (stale duplicate registrations). */
const REMOVE_KEYS = new Set(['amp.cathode_follower_compression']);

/** Unit overrides where the generic scale-keeps-unit rule is not what we
 * want (label fixes + bipolar reclassifications). */
const UNIT_OVERRIDE: Record<string, string> = {
  'amp.proximity': 'hz', // tc unit nibble 2; same scale 1 as db, display-only
  'amp.tremfreq': 'hz',
  'amp.cab1_distance': 'bipolar_percent',
  'amp.triode1ratio': 'bipolar_percent',
  'amp.floor_reflections': 'bipolar_percent',
};

const UNIT_SCALE: Record<string, number> = {
  knob_0_10: 10, knob_0_20: 20, db: 1, hz: 1, seconds: 1, percent: 100,
  bipolar_percent: 100, count: 1, semitones: 1, ratio: 1, ms: 1000,
  degrees: 57.29577951308232, pf: 1000000, rotary_mic_spacing: 31.83098793029785,
  amp_geq_band: 12,
};
const scaleClose = (a: number, b: number): boolean => Math.abs(a - b) <= 0.001 * Math.max(1, Math.abs(b));

function inferUnit(r: WalkRec, shippedUnit: string): string | undefined {
  const sc = r.def;
  // keep the shipped unit when its encode scale already matches the cache
  if (UNIT_SCALE[shippedUnit] !== undefined && scaleClose(UNIT_SCALE[shippedUnit], sc)) return shippedUnit;
  if (scaleClose(sc, 10)) return 'knob_0_10';
  if (scaleClose(sc, 20)) return 'knob_0_20';
  if (scaleClose(sc, 100)) return r.min < 0 ? 'bipolar_percent' : 'percent';
  if (scaleClose(sc, 1000)) return 'ms';
  if (scaleClose(sc, 1000000)) return 'pf';
  if (scaleClose(sc, 12)) return 'amp_geq_band';
  if (scaleClose(sc, 1)) {
    switch (r.tc & 0x0f) {
      case 1: return 'db';
      case 2: return 'hz';
      case 3: return 'seconds';
      default: return 'count';
    }
  }
  return undefined; // no existing Unit fits -> must be flagged
}

interface SetOp {
  kind: 'set';
  unit?: string;
  displayMin?: number;
  displayMax?: number;
  addScaling?: boolean; // add/keep scaling: 'log10'
  displayUnit?: string;
  enumValues?: Record<number, string> | null; // null = drop enumValues
}
interface FlipOp { kind: 'flip' }
interface RemoveOp { kind: 'remove' }
type Op = SetOp | FlipOp | RemoveOp;

const ops = new Map<string, Op>();

// --- 1. cache-walk regeneration for the two amp banks --------------------
// Keyed by catalog key -> (section, pidHigh) resolved from the live catalog.
import('../../packages/fractal-midi/src/am4/params.js').then(async ({ KNOWN_PARAMS }) => {
  const { CACHE_PARAMS } = await import('../../packages/fractal-midi/src/am4/cacheParams.js');

  interface P { block: string; name: string; pidLow: number; pidHigh: number; unit: string; displayMin: number; displayMax: number; scaling?: string; enumValues?: Record<number, string> }
  const flagged: string[] = [];
  for (const [key, pRaw] of Object.entries(KNOWN_PARAMS)) {
    const p = pRaw as unknown as P;
    const section = p.pidLow === 0x3a ? 10 : p.pidLow === 0x3e ? 11 : undefined;
    if (!section) continue;
    if (REMOVE_KEYS.has(key)) { ops.set(key, { kind: 'remove' }); continue; }
    const r = bySection.get(section)!.get(p.pidHigh);
    if (!r) continue;
    if (SKIP_FLAGGED[key]) { flagged.push(key); continue; }

    if (r.kind === 'enum') {
      const vals = r.values!;
      const shippedVals = p.enumValues ?? {};
      const same =
        p.unit === 'enum' &&
        Object.keys(shippedVals).length === vals.length &&
        vals.every((v, i) => (shippedVals[i] ?? '').trim().toUpperCase() === v.trim().toUpperCase()) &&
        p.displayMin === 0 && p.displayMax === vals.length - 1;
      if (same) continue;
      const enumValues: Record<number, string> = {};
      vals.forEach((v, i) => { enumValues[i] = v; });
      ops.set(key, { kind: 'set', unit: 'enum', displayMin: 0, displayMax: vals.length - 1, enumValues });
    } else {
      const lo = clean(r.min * r.def);
      const hi = clean(r.max * r.def);
      const log = isLog10(r);
      const unit = UNIT_OVERRIDE[key] ?? inferUnit(r, p.unit);
      if (!unit) { flagged.push(`${key} (unexpected unresolved scale ${r.def})`); continue; }
      const unitSame = unit === p.unit;
      const rangeSame = p.displayMin === lo && p.displayMax === hi;
      const scalingSame = ((p.scaling ?? 'linear') === 'log10') === log;
      const kindSame = p.unit !== 'enum';
      if (unitSame && rangeSame && scalingSame && kindSame) continue;
      ops.set(key, {
        kind: 'set',
        unit,
        displayMin: lo,
        displayMax: hi,
        addScaling: log,
        enumValues: p.unit === 'enum' ? null : undefined,
      });
    }
  }

  // --- 2. the 72 log10 flips (dedupe against set-ops) ---------------------
  const contra = JSON.parse(readFileSync(CONTRA, 'utf8')) as Array<{ key: string }>;
  let flips = 0;
  for (const c of contra) {
    const existing = ops.get(c.key);
    if (existing) {
      if (existing.kind === 'set') existing.addScaling = true;
      continue;
    }
    ops.set(c.key, { kind: 'flip' });
    flips++;
  }

  // --- 3. unit-label fixes outside the two banks --------------------------
  // rotary time constants: count -> seconds (same encode scale 1) + log10
  // (they are 2 of the 72; upgrade their flip to a set with the unit fix).
  for (const k of ['rotary.low_time_constant', 'rotary.high_time_constant']) {
    ops.set(k, { kind: 'set', unit: 'seconds', displayMin: 0.1, displayMax: 10, addScaling: true });
  }
  // reverb.low_decay: a decay-time MULTIPLIER, not seconds. Encode scale 1
  // either way; keep unit 'seconds' for its 2-decimal display precision and
  // override the suffix (the documented cosmetic mechanism).
  ops.set('reverb.low_decay', { kind: 'set', displayUnit: 'x' });

  // ---------------------------------------------------------------------
  // Text surgery
  // ---------------------------------------------------------------------
  interface Entry { start: number; end: number; lines: string[]; singleLine: boolean }

  function findEntry(lines: string[], key: string): Entry | undefined {
    const re = new RegExp(`^  '${key.replace(/\./g, '\\.')}':\\s*\\{`);
    const start = lines.findIndex((l) => re.test(l));
    if (start < 0) return undefined;
    if (/},\s*$/.test(lines[start])) return { start, end: start, lines: [lines[start]], singleLine: true };
    let end = start;
    while (end < lines.length - 1 && !/^  },\s*$/.test(lines[end])) end++;
    return { start, end, lines: lines.slice(start, end + 1), singleLine: false };
  }

  const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  function fmtEnum(values: Record<number, string>): string[] {
    const items = Object.entries(values).map(([i, v]) => `${i}: '${esc(v)}'`);
    const oneLine = `    enumValues: { ${items.join(', ')} },`;
    if (oneLine.length <= 110) return [oneLine];
    const out: string[] = ['    enumValues: {'];
    let cur = '      ';
    for (const it of items) {
      if (cur.length + it.length + 2 > 100) { out.push(cur.trimEnd()); cur = '      '; }
      cur += `${it}, `;
    }
    out.push(cur.trimEnd().replace(/,$/, ','));
    out.push('    },');
    return out;
  }

  const fmtNum = (n: number): string => `${n}`;

  function rewriteEntry(e: Entry, key: string, op: SetOp, file: 'params' | 'cache'): string[] {
    // Parse fields we must preserve from the existing text.
    const text = e.lines.join('\n');
    const get = (re: RegExp): string | undefined => text.match(re)?.[1];
    const block = get(/block: '([^']+)'/)!;
    const name = get(/name: '([^']+)'/)!;
    const pidLow = get(/pidLow: (0x[0-9a-fA-F]+)/)!;
    const pidHigh = get(/pidHigh: (0x[0-9a-fA-F]+)/)!;
    const displayLabel = get(/displayLabel: (?:'([^']*)'|"([^"]*)")/) ?? text.match(/displayLabel: "([^"]*)"/)?.[1];
    const oldUnit = get(/unit: '([^']+)'/)!;
    const oldMin = get(/displayMin: (-?[\d.eE+]+)/)!;
    const oldMax = get(/displayMax: (-?[\d.eE+]+)/)!;
    const oldScaling = /scaling: 'log10'/.test(text);
    const oldDisplayUnit = get(/displayUnit: '([^']*)'/);
    const oldEnumRef = get(/enumValues: ([A-Z][A-Z0-9_]*)/); // imported table reference
    const oldEnumInline = text.match(/enumValues: (\{[\s\S]*?\})/)?.[1];

    // Preserved inline comments (full comment lines inside the entry), minus
    // stale TODO-capture asks that the cache roster now answers.
    const comments = e.singleLine ? [] : e.lines
      .slice(1, e.lines.length - 1)
      .filter((l) => /^\s*\/\//.test(l))
      .filter((l) => !/TODO: capture enum/i.test(l));

    const unit = op.unit ?? oldUnit;
    const min = op.displayMin !== undefined ? fmtNum(op.displayMin) : oldMin;
    const max = op.displayMax !== undefined ? fmtNum(op.displayMax) : oldMax;
    const scaling = op.addScaling ?? oldScaling;
    const displayUnit = op.displayUnit ?? oldDisplayUnit;

    const out: string[] = [];
    out.push(`  '${key}': {`);
    out.push(`    block: '${block}', name: '${name}',`);
    if (displayLabel !== undefined) out.push(`    displayLabel: '${esc(displayLabel)}',`);
    out.push(`    pidLow: ${pidLow}, pidHigh: ${pidHigh},`);
    out.push(...comments.map((c) => `    ${c.trim()}`));
    out.push(`    unit: '${unit}', displayMin: ${min}, displayMax: ${max},`);
    if (scaling) out.push(`    scaling: 'log10',`);
    if (displayUnit !== undefined) out.push(`    displayUnit: '${esc(displayUnit)}',`);
    if (op.enumValues) {
      out.push(...fmtEnum(op.enumValues));
    } else if (op.enumValues !== null) {
      // preserve any pre-existing enum (reference or inline) when untouched
      if (oldEnumRef) out.push(`    enumValues: ${oldEnumRef},`);
      else if (oldEnumInline && unit === 'enum') out.push(`    enumValues: ${oldEnumInline.replace(/\s+/g, ' ')},`);
    }
    out.push('  },');
    void file;
    return out;
  }

  function flipEntry(e: Entry): string[] {
    if (e.singleLine) {
      return [e.lines[0].replace(/(,?)\s*\},\s*$/, `, scaling: 'log10' },`)];
    }
    if (e.lines.some((l) => /scaling: 'log10'/.test(l))) return e.lines;
    const out = [...e.lines];
    // insert after the last line that mentions displayMax
    let at = out.length - 2;
    for (let i = out.length - 1; i >= 0; i--) {
      if (/displayMax:/.test(out[i])) { at = i; break; }
    }
    out.splice(at + 1, 0, `    scaling: 'log10',`);
    return out;
  }

  const summary = { set: 0, flip: 0, remove: 0, perFile: { params: 0, cache: 0 } };
  const missing: string[] = [];

  for (const file of [PARAMS, CACHE] as const) {
    let lines = readFileSync(file, 'utf8').split('\n');
    const tag = file === PARAMS ? 'params' : 'cache';
    for (const [key, op] of ops) {
      const e = findEntry(lines, key);
      if (!e) continue;
      let replacement: string[];
      if (op.kind === 'remove') {
        // also remove immediately-preceding comment lines that belong to it
        let from = e.start;
        while (from > 0 && /^\s*\/\//.test(lines[from - 1])) from--;
        lines = [...lines.slice(0, from), ...lines.slice(e.end + 1)];
        summary.remove++;
        summary.perFile[tag]++;
        continue;
      } else if (op.kind === 'flip') {
        replacement = flipEntry(e);
        summary.flip++;
      } else {
        replacement = rewriteEntry(e, key, op, tag);
        summary.set++;
      }
      lines = [...lines.slice(0, e.start), ...replacement, ...lines.slice(e.end + 1)];
      summary.perFile[tag]++;
    }
    writeFileSync(file, lines.join('\n'));
  }

  // ops that matched nothing anywhere
  for (const [key] of ops) {
    const inP = findEntry(readFileSync(PARAMS, 'utf8').split('\n'), key);
    const inC = findEntry(readFileSync(CACHE, 'utf8').split('\n'), key);
    if (!inP && !inC) missing.push(key);
  }

  console.log(`ops: ${ops.size} keys (${[...ops.values()].filter((o) => o.kind === 'set').length} set, ${flips} pure-flip, ${[...ops.values()].filter((o) => o.kind === 'remove').length} remove)`);
  console.log(`applied: set=${summary.set} flip=${summary.flip} remove=${summary.remove} (params.ts=${summary.perFile.params}, cacheParams.ts=${summary.perFile.cache})`);
  console.log(`flagged-skipped: ${Object.keys(SKIP_FLAGGED).length} (${flagged.length} encountered)`);
  if (missing.length) console.log(`MISSING (no entry found): ${missing.join(', ')}`);

  writeFileSync('samples/captured/local-caches-2026-06-09/accuracy-pass-ops.json', JSON.stringify(
    { ops: [...ops.entries()], flagged: Object.keys(SKIP_FLAGGED), removed: [...REMOVE_KEYS] }, null, 1));
  void CACHE_PARAMS;
});
