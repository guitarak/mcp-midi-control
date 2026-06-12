/**
 * ii-ranges-gapfill-analysis.ts
 *
 * Analysis (read-only) for the 2026-06-09 Axe-Fx II display-mapping
 * gap-fill. Joins the solved zero-resync II editor-cache walk
 * (effectDefinitions_07.walk.json) to the shipped II catalog
 * (fractal-midi/src/gen2/axe-fx-ii/params.ts) via the catalog-vote
 * block -> section map (same technique as tc_join_ii.py), then
 * classifies every joined float row:
 *
 *   FILL         catalog has no displayMin/displayMax, no explicit
 *                calibration overlay; cache supplies the display range
 *                (+ log10 for typecode family 4/5, + step).
 *   ADD_LOG10    catalog range present and cache-agreeing, family 4/5,
 *                but displayScale missing.
 *   CONFLICT     shipped catalog range disagrees with the cache, or an
 *                explicit hardware/editor overlay disagrees. HELD, not
 *                changed (hardware/capture evidence outranks cache).
 *   OVERLAY_AGREE explicit overlay entry, cache agrees byte-for-byte.
 *                Held anyway (filling the catalog would override the
 *                overlay's unit tag in the resolver ladder).
 *   SUSPECT      cache row looks like an internal extent, not a display
 *                range (degenerate scale/min==max, or G2/G3-style raw
 *                internal shape). HELD + flagged.
 *   SKIP         enums / switches / kind mismatch / degenerate record.
 *
 * Typecode layout (II cache, newer 3-nibble format): [unit][family][precision]
 * Family 4/5 = log10, HARDWARE-CONFIRMED HW-131 (II reverb Low Cut 20..2000 Hz
 * reads 200.0 Hz at 12 o'clock = geometric mean). See
 * docs/_private/TYPECODE-BITFIELD-DECODE-2026-06-09.md.
 *
 * Run: npx tsx scripts/_research/ii-ranges-gapfill-analysis.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { KNOWN_PARAMS, type AxeFxIIParam } from '../../packages/fractal-midi/src/gen2/axe-fx-ii/params.js';
import { KNOWN_PARAMS as AM4_PARAMS } from '../../packages/fractal-midi/src/am4/params.js';

const WALK = 'samples/captured/local-caches-2026-06-09/effectDefinitions_07.walk.json';
const REPORT = 'samples/captured/local-caches-2026-06-09/ii-gapfill-report.json';
const CALIBRATION = 'packages/fractal-gen2/src/calibration.ts';

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

// 6 significant digits: the cache stores float32; 9999.999776 is 10000,
// 0.0099999998 is 0.01 (same rounding the AM4 accuracy pass used).
const round6 = (n: number): number => (n === 0 ? 0 : Number(n.toPrecision(6)));
const close = (a: number | undefined, b: number | undefined): boolean =>
  a !== undefined && b !== undefined &&
  (a === b || Math.abs(a - b) <= 0.02 * Math.max(1e-9, Math.abs(a), Math.abs(b)) || Math.abs(a - b) < 1e-6);

const family = (tc: number): number => (tc >> 4) & 0x0f;
const precision = (tc: number): number => tc & 0x0f;
const unitNibble = (tc: number): number => (tc >> 8) & 0x0f;
/** Family 4/5 = log10 (HW-131). Requires positive display min. */
const isLog10 = (r: WalkRec): boolean =>
  r.kind === 'float' && family(r.tc) >= 4 && family(r.tc) <= 5 && r.min * r.def > 0;

// ---- explicit calibration overlay keys (packages/fractal-gen2/src/calibration.ts) ----
// Extracted textually: that file imports from the fractal-midi dist build,
// which may be stale this session; the keys + values are what we need.
const calSrc = readFileSync(CALIBRATION, 'utf8');
interface OverlayEntry { displayMin: number; displayMax: number; displayScale?: string; table: string }
const overlay = new Map<string, OverlayEntry>();
for (const tbl of ['AM4_SHARED', 'EDITOR_OBSERVED', 'HARDWARE_SWEPT']) {
  const m = calSrc.match(new RegExp(`const ${tbl}[^=]*= \\{([\\s\\S]*?)\\n\\};`));
  if (!m) throw new Error(`overlay table ${tbl} not found`);
  const entryRe = /'([a-z0-9_]+\.[a-z0-9_]+)':\s*\{\s*displayMin:\s*(-?[\d.]+),\s*displayMax:\s*(-?[\d.]+)(?:,\s*displayScale:\s*'(\w+)')?/g;
  let e: RegExpExecArray | null;
  while ((e = entryRe.exec(m[1])) !== null) {
    overlay.set(e[1], { displayMin: Number(e[2]), displayMax: Number(e[3]), displayScale: e[4], table: tbl });
  }
}
console.log(`overlay keys extracted: ${overlay.size}`);

// ---- block -> section vote (same as tc_join_ii.py) ----
const entries = Object.entries(KNOWN_PARAMS) as Array<[string, AxeFxIIParam]>;
const votes = new Map<string, Map<number, number>>();
for (const [, p] of entries) {
  for (const [sec, ids] of bySection) {
    const r = ids.get(p.paramId);
    if (!r) continue;
    let w = 0;
    if (p.enumValues || p.controlType === 'select') {
      if (r.kind === 'enum') {
        w = 1;
        // stronger: enum roster size match
        if (p.enumValues && r.count === Object.keys(p.enumValues).length) {
          w = 2;
          // strongest: label-for-label match (>= 80% case-insensitive)
          const vals = p.enumValues;
          const hits = r.values!.filter((v, i) => (vals[i] ?? '').trim().toUpperCase() === v.trim().toUpperCase()).length;
          if (hits >= 0.8 * r.count!) w = 5;
        }
      }
    } else if (r.kind === 'float' && p.displayMin !== undefined && p.displayMax !== undefined) {
      if (close(round6(r.min * r.def), p.displayMin) && close(round6(r.max * r.def), p.displayMax)) w = 2;
    }
    if (w > 0) {
      if (!votes.has(p.block)) votes.set(p.block, new Map());
      const c = votes.get(p.block)!;
      c.set(sec, (c.get(sec) ?? 0) + w);
    }
  }
}
const blockmap = new Map<string, number>();
const voteTable: Array<{ block: string; section: number; votes: number; margin: number }> = [];
for (const [blk, c] of [...votes.entries()].sort()) {
  const sorted = [...c.entries()].sort((a, b) => b[1] - a[1]);
  const [sec, n] = sorted[0];
  const margin = n - (sorted[1]?.[1] ?? 0);
  voteTable.push({ block: blk, section: sec, votes: n, margin });
  if (n >= 4 && margin >= 3) blockmap.set(blk, sec);
  console.log(`  ${blk.padEnd(16)} -> sec ${String(sec).padStart(3)}  votes=${n} margin=${margin}${n >= 4 && margin >= 3 ? '' : '  (REJECTED: weak vote)'}`);
}
// uniqueness check
const secUse = new Map<number, string[]>();
for (const [blk, sec] of blockmap) secUse.set(sec, [...(secUse.get(sec) ?? []), blk]);
for (const [sec, blks] of secUse) {
  if (blks.length > 1) {
    console.log(`  COLLISION on section ${sec}: ${blks.join(', ')} (all dropped)`);
    for (const b of blks) blockmap.delete(b);
  }
}
console.log(`block map accepted: ${blockmap.size} blocks`);

// ---- AM4 same-key cross-reference ----
const am4ByKey = new Map<string, { displayMin: number; displayMax: number; unit: string; scaling?: string }>();
for (const [key, p] of Object.entries(AM4_PARAMS) as Array<[string, { displayMin: number; displayMax: number; unit: string; scaling?: string }]>) {
  am4ByKey.set(key, p);
}

// ---- classification ----
type Verdict = 'FILL' | 'ADD_LOG10' | 'CONFLICT' | 'OVERLAY_AGREE' | 'SUSPECT' | 'SKIP';
interface Row {
  key: string;
  verdict: Verdict;
  reason: string;
  section?: number;
  tc?: string;
  fam?: number;
  cache?: { displayMin: number; displayMax: number; step: number; scale: number; log10: boolean; precision: number };
  shipped?: { displayMin?: number; displayMax?: number; step?: number; displayScale?: string };
  overlay?: OverlayEntry;
  am4?: { displayMin: number; displayMax: number; unit: string; scaling?: string };
  fill?: { displayMin: number; displayMax: number; displayScale?: 'log10'; step?: number };
}

const rows: Row[] = [];
let noSection = 0;
let noRecord = 0;

for (const [key, p] of entries) {
  const sec = blockmap.get(p.block);
  if (sec === undefined) { noSection++; continue; }
  const r = bySection.get(sec)!.get(p.paramId);
  if (!r) { noRecord++; continue; }

  const isEnumish = !!p.enumValues || p.controlType === 'select' || p.controlType === 'switch';
  if (isEnumish || r.kind !== 'float') {
    rows.push({ key, verdict: 'SKIP', reason: isEnumish ? 'enum/switch entry (ranges n/a)' : `kind mismatch: catalog ${p.controlType} vs cache ${r.kind}` });
    continue;
  }

  // degenerate cache record: no info
  if (r.def === 0 || r.min === r.max) {
    rows.push({ key, verdict: 'SKIP', reason: `degenerate cache record (min=${r.min} max=${r.max} scale=${r.def})` });
    continue;
  }

  const lo = round6(r.min * r.def);
  const hi = round6(r.max * r.def);
  const dStep = round6(r.step * r.def);
  const log = isLog10(r);
  const fam = family(r.tc);
  const prec = precision(r.tc);
  const cache = { displayMin: lo, displayMax: hi, step: dStep, scale: round6(r.def), log10: log, precision: prec };
  const am4p = am4ByKey.get(key);
  const am4 = am4p ? { displayMin: am4p.displayMin, displayMax: am4p.displayMax, unit: am4p.unit, scaling: am4p.scaling } : undefined;
  const base = {
    key, section: sec, tc: `0x${r.tc.toString(16)}`, fam, cache,
    shipped: { displayMin: p.displayMin, displayMax: p.displayMax, step: p.step, displayScale: p.displayScale },
    am4,
  };

  const ov = overlay.get(key);
  const shippedHasRange = p.displayMin !== undefined && p.displayMax !== undefined;

  if (shippedHasRange) {
    const rangeAgrees = close(p.displayMin, lo) && close(p.displayMax, hi);
    if (!rangeAgrees) {
      rows.push({ ...base, verdict: 'CONFLICT', reason: `shipped catalog range [${p.displayMin}..${p.displayMax}] vs cache [${lo}..${hi}] (held: II shipped ranges are hardware/capture-derived)` });
      continue;
    }
    const shippedLog = p.displayScale === 'log10';
    if (log && !shippedLog) {
      if ((p.displayMin as number) > 0) {
        rows.push({ ...base, verdict: 'ADD_LOG10', reason: 'range cache-agreeing, family 4/5, displayScale missing', fill: { displayMin: p.displayMin as number, displayMax: p.displayMax as number, displayScale: 'log10' } });
      } else {
        rows.push({ ...base, verdict: 'CONFLICT', reason: `family ${fam} says log10 but shipped displayMin ${p.displayMin} <= 0 (held)` });
      }
      continue;
    }
    if (!log && shippedLog && fam === 3) {
      rows.push({ ...base, verdict: 'CONFLICT', reason: 'shipped log10 but cache family 3 (linear); hardware outranks, held + flagged' });
      continue;
    }
    rows.push({ ...base, verdict: 'SKIP', reason: 'shipped range agrees with cache; nothing to fill' });
    continue;
  }

  if (ov) {
    const agrees = close(ov.displayMin, lo) && close(ov.displayMax, hi) && ((ov.displayScale === 'log10') === log);
    rows.push({
      ...base, overlay: ov,
      verdict: agrees ? 'OVERLAY_AGREE' : 'CONFLICT',
      reason: agrees
        ? `explicit ${ov.table} overlay agrees with cache; held (catalog fill would override the overlay's unit tag)`
        : `explicit ${ov.table} overlay [${ov.displayMin}..${ov.displayMax}${ov.displayScale === 'log10' ? ' log10' : ''}] vs cache [${lo}..${hi}${log ? ' log10' : ''}] (held: overlay evidence outranks cache)`,
    });
    continue;
  }

  // SUSPECT heuristics: internal-extent shapes (the fn 0x16 G2/G3 class).
  // 1. scale==1 with a positive sub-unity span whose magnitudes look like raw
  //    component values (max <= 0.05): bright_cap-style raw farads/internal.
  // 2. AM4 same-key display range exists, disagrees by >50x span ratio, and
  //    the cache row is NOT unit-scaled (scale==1): smells like an unscaled
  //    internal register rather than a genuine II range divergence.
  if (r.def === 1 && r.min > 0 && hi <= 0.05) {
    rows.push({ ...base, verdict: 'SUSPECT', reason: `cache range [${lo}..${hi}] at scale 1 looks like a raw internal extent (bright_cap class); held` });
    continue;
  }
  if (am4 && am4.displayMin !== undefined && r.def === 1) {
    const am4Span = Math.abs(am4.displayMax - am4.displayMin);
    const cSpan = Math.abs(hi - lo);
    if (am4Span > 0 && cSpan > 0 && (am4Span / cSpan > 50 || cSpan / am4Span > 50)) {
      rows.push({ ...base, verdict: 'SUSPECT', reason: `cache span [${lo}..${hi}] vs AM4 same-key [${am4.displayMin}..${am4.displayMax}] (${am4.unit}) differs >50x at scale 1; held as possible internal extent` });
      continue;
    }
  }
  if (log && lo <= 0) {
    rows.push({ ...base, verdict: 'SUSPECT', reason: 'family 4/5 but non-positive display min; held' });
    continue;
  }

  const fill: Row['fill'] = { displayMin: lo, displayMax: hi };
  if (log) fill.displayScale = 'log10';
  if (dStep > 0) fill.step = dStep;
  else if (log) fill.step = round6(Math.pow(10, -prec)); // precision nibble = display decimals
  rows.push({ ...base, verdict: 'FILL', reason: 'catalog has no display mapping; cache supplies it', fill });
}

// ---- summary ----
const counts: Record<Verdict, number> = { FILL: 0, ADD_LOG10: 0, CONFLICT: 0, OVERLAY_AGREE: 0, SUSPECT: 0, SKIP: 0 };
for (const row of rows) counts[row.verdict]++;
console.log('\nverdicts:', counts);
console.log(`unjoined: ${noSection} entries in unmapped blocks, ${noRecord} entries with no cache record at (section, paramId)`);

// overlay cross-validation stats (cache vs hardware/editor overlays)
const ovRows = rows.filter((r) => r.verdict === 'OVERLAY_AGREE' || (r.verdict === 'CONFLICT' && r.overlay));
const ovAgree = rows.filter((r) => r.verdict === 'OVERLAY_AGREE').length;
console.log(`overlay cross-validation: ${ovAgree}/${ovRows.length} explicit overlay entries agree with cache`);

for (const v of ['CONFLICT', 'SUSPECT'] as const) {
  console.log(`\n${v} rows:`);
  for (const row of rows.filter((r) => r.verdict === v)) {
    console.log(`  ${row.key.padEnd(36)} ${row.reason}`);
  }
}

writeFileSync(REPORT, JSON.stringify({ voteTable, counts, rows }, null, 1));
console.log(`\nwrote ${REPORT}`);
