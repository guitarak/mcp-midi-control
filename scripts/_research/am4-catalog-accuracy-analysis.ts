/**
 * am4-catalog-accuracy-analysis.ts
 *
 * Analysis (read-only) for the 2026-06-09 AM4 catalog accuracy pass.
 * Joins the shipped KNOWN_PARAMS amp banks (pidLow 0x3a = DISTORT section 10,
 * pidLow 0x3e = CABINET section 11) against the corrected zero-resync cache
 * walk and reports, per entry: shipped vs cache kind/unit/range/scaling and a
 * proposed correction. Also joins am4-taper-contradictions.json (the 72
 * family-4/5 log10 flips) to the live catalog keys.
 *
 * Run: npx tsx scripts/_research/am4-catalog-accuracy-analysis.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { KNOWN_PARAMS, type Param, type Unit } from '../../packages/fractal-midi/src/am4/params.js';
import { CACHE_PARAMS } from '../../packages/fractal-midi/src/am4/cacheParams.js';

const WALK = 'samples/captured/local-caches-2026-06-09/effectDefinitions_15_2p0.walk.json';
const CONTRA = 'samples/captured/local-caches-2026-06-09/am4-taper-contradictions.json';

interface WalkRec {
  kind: 'float' | 'enum';
  section: number;
  id: number;
  tc: number;
  min: number;
  max: number;
  /** display scale: display = field * def */
  def: number;
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

const round6 = (n: number): number => Number(n.toFixed(6));
const close = (a: number, b: number): boolean =>
  a === b || Math.abs(a - b) <= 0.002 * Math.max(1e-9, Math.abs(a), Math.abs(b));

const UNIT_SCALE: Record<string, number> = {
  knob_0_10: 10, knob_0_20: 20, db: 1, hz: 1, seconds: 1, percent: 100,
  bipolar_percent: 100, count: 1, semitones: 1, ratio: 1, ms: 1000,
  degrees: 57.29577951308232, pf: 1000000, rotary_mic_spacing: 31.83098793029785,
  amp_geq_band: 12,
};

interface Inferred { unit: Unit; note?: string }
function inferFloatUnit(r: WalkRec): Inferred {
  const nib = r.tc & 0x0f;
  const sc = r.def;
  const c = (b: number): boolean => Math.abs(sc - b) <= 0.001 * Math.max(1, Math.abs(b));
  if (c(10)) return { unit: 'knob_0_10' };
  if (c(20)) return { unit: 'knob_0_20' };
  if (c(100)) return { unit: r.min < 0 ? 'bipolar_percent' : 'percent' };
  if (c(1000)) return { unit: 'ms' };
  if (c(1000000)) return { unit: 'pf' };
  if (c(57.29577951308232)) return { unit: 'degrees' };
  if (c(31.83098793029785)) return { unit: 'rotary_mic_spacing' };
  if (c(12)) return { unit: 'amp_geq_band' };
  if (c(1)) {
    switch (nib) {
      case 1: return { unit: 'db' };
      case 2: return { unit: 'hz' };
      case 3: return { unit: 'seconds' };
      default: return { unit: 'count' };
    }
  }
  return { unit: 'count', note: `UNRESOLVED cache scale ${sc}` };
}

/** Family 4/5 = log10, HARDWARE-CONFIRMED HW-131 2026-06-09. */
const isLog10 = (r: WalkRec): boolean =>
  r.kind === 'float' && ((r.tc >> 4) & 0x0f) >= 4 && ((r.tc >> 4) & 0x0f) <= 5 && r.min * r.def > 0;

interface Row {
  key: string;
  pidHigh: number;
  inCacheParams: boolean;
  shipped: { unit: Unit; displayMin: number; displayMax: number; scaling?: string; enumCount?: number };
  cache: {
    kind: string; tc: string; displayMin?: number; displayMax?: number; step?: number;
    scale?: number; log10?: boolean; unit?: string; unitNote?: string; count?: number; values?: string[];
  };
  diffs: string[];
}

function compareBank(pidLow: number, section: number): { rows: Row[]; clean: string[]; noCacheRec: string[] } {
  const sec = bySection.get(section)!;
  const rows: Row[] = [];
  const clean: string[] = [];
  const noCacheRec: string[] = [];
  for (const [key, p] of Object.entries(KNOWN_PARAMS) as Array<[string, Param]>) {
    if (p.pidLow !== pidLow) continue;
    const r = sec.get(p.pidHigh);
    if (!r) { noCacheRec.push(key); continue; }
    const diffs: string[] = [];
    const cache: Row['cache'] = { kind: r.kind, tc: `0x${r.tc.toString(16).padStart(2, '0')}` };
    if (r.kind === 'enum') {
      cache.count = r.count;
      cache.values = r.values;
      if (p.unit !== 'enum') diffs.push(`kind: shipped ${p.unit} [${p.displayMin}..${p.displayMax}] vs cache enum n=${r.count}`);
      else {
        const shippedVals = p.enumValues ?? {};
        const n = Object.keys(shippedVals).length;
        if (n !== r.count) diffs.push(`enum size: shipped ${n} vs cache ${r.count}`);
        else {
          const mismatch = r.values!.findIndex((v, i) => (shippedVals[i] ?? '').trim().toUpperCase() !== v.trim().toUpperCase());
          if (mismatch >= 0) diffs.push(`enum label[${mismatch}]: shipped '${shippedVals[mismatch]}' vs cache '${r.values![mismatch]}'`);
        }
      }
    } else {
      const lo = round6(r.min * r.def);
      const hi = round6(r.max * r.def);
      const inf = inferFloatUnit(r);
      const log = isLog10(r);
      cache.displayMin = lo; cache.displayMax = hi; cache.step = round6(r.step * r.def);
      cache.scale = round6(r.def); cache.log10 = log; cache.unit = inf.unit; cache.unitNote = inf.note;
      if (p.unit === 'enum') diffs.push(`kind: shipped enum vs cache float [${lo}..${hi}]`);
      else {
        if (!close(p.displayMin, lo) || !close(p.displayMax, hi)) {
          diffs.push(`range: shipped [${p.displayMin}..${p.displayMax}] vs cache [${lo}..${hi}]`);
        }
        const shippedScale = UNIT_SCALE[p.unit];
        if (!close(shippedScale, r.def)) {
          diffs.push(`ENCODE SCALE: shipped unit '${p.unit}' (x${shippedScale}) vs cache scale ${round6(r.def)}`);
        }
        const shippedLog = (p.scaling ?? 'linear') === 'log10';
        if (shippedLog !== log) diffs.push(`scaling: shipped ${p.scaling ?? 'linear'} vs cache ${log ? 'log10' : 'linear'}`);
      }
    }
    if (diffs.length === 0) { clean.push(key); continue; }
    rows.push({
      key,
      pidHigh: p.pidHigh,
      inCacheParams: key in CACHE_PARAMS,
      shipped: {
        unit: p.unit, displayMin: p.displayMin, displayMax: p.displayMax,
        scaling: p.scaling, enumCount: p.enumValues ? Object.keys(p.enumValues).length : undefined,
      },
      cache,
      diffs,
    });
  }
  return { rows, clean, noCacheRec };
}

const amp = compareBank(0x3a, 10);
const cab = compareBank(0x3e, 11);

// ---- 72 log10 flips ----
const contra = JSON.parse(readFileSync(CONTRA, 'utf8')) as Array<{ key: string; sec: number; id: number; tc: number }>;
const flipRows: Array<{ key: string; found: boolean; inCacheParams: boolean; alreadyLog: boolean; displayMin?: number }> = [];
for (const c of contra) {
  const p = (KNOWN_PARAMS as Record<string, Param>)[c.key];
  flipRows.push({
    key: c.key,
    found: !!p,
    inCacheParams: c.key in CACHE_PARAMS,
    alreadyLog: p ? (p.scaling ?? 'linear') === 'log10' : false,
    displayMin: p?.displayMin,
  });
}

const report = {
  amp3a: { mismatches: amp.rows.length, clean: amp.clean.length, noCacheRec: amp.noCacheRec, rows: amp.rows },
  cab3e: { mismatches: cab.rows.length, clean: cab.clean.length, noCacheRec: cab.noCacheRec, rows: cab.rows },
  flips: {
    total: flipRows.length,
    notFound: flipRows.filter((f) => !f.found).map((f) => f.key),
    alreadyLog: flipRows.filter((f) => f.alreadyLog).map((f) => f.key),
    zeroMin: flipRows.filter((f) => f.found && (f.displayMin ?? 1) <= 0).map((f) => f.key),
    inCacheParams: flipRows.filter((f) => f.found && f.inCacheParams).map((f) => f.key),
    rows: flipRows,
  },
};

writeFileSync('samples/captured/local-caches-2026-06-09/accuracy-pass-report.json', JSON.stringify(report, null, 1));
console.log(`amp@0x3a: ${amp.rows.length} mismatches, ${amp.clean.length} clean, ${amp.noCacheRec.length} no-cache-record`);
console.log(`cab@0x3e: ${cab.rows.length} mismatches, ${cab.clean.length} clean, ${cab.noCacheRec.length} no-cache-record`);
console.log(`flips: ${flipRows.length} total, ${report.flips.notFound.length} key-not-found, ${report.flips.alreadyLog.length} already log10, ${report.flips.zeroMin.length} zero-min`);
console.log('wrote samples/captured/local-caches-2026-06-09/accuracy-pass-report.json');
