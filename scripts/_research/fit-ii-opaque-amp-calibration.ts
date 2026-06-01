/**
 * Deterministic calibration fitter for the opaque-amp sweep.
 *
 * Reads samples/captured/decoded/ii-opaque-amp-sweep.json (produced by
 * probe-ii-opaque-amp-sweep.ts) and fits each param to a calibration
 * candidate: parse the device-rendered numeric labels at the 5 wire
 * points, take the endpoints as displayMin/displayMax, and pick
 * linear-vs-log10 by whichever predicts the measured midpoint better.
 *
 * Arithmetic lives here (not in the workflow) because LLMs fumble it.
 * The workflow agents consume this candidate table and do the JUDGMENT:
 * cross-check against AM4 siblings / manual / convention, classify
 * enums, and adversarially refute bad fits before anything reaches the
 * shared resolver (which governs writes as well as reads).
 *
 * Output: samples/captured/decoded/ii-opaque-amp-fit.json
 * Run: npx tsx scripts/_research/fit-ii-opaque-amp-calibration.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

interface Sample { setWire: number; echoedWire: number; label: string }
interface ParamSweep { paramId: number; name: string; controlType: string; originalWire: number; samples: Sample[] }
interface SweepFile { effectId: number; sweepWires: number[]; params: ParamSweep[] }

const FULL = 65534;

function parseLabel(label: string): { num?: number; unit: string; raw: string } {
  const m = /^(-?\d+(?:\.\d+)?)\s*(.*)$/.exec(label.trim());
  if (!m) return { unit: '', raw: label };
  return { num: Number(m[1]), unit: m[2].trim(), raw: label };
}

type Classification = 'linear' | 'log10' | 'enum' | 'stuck' | 'ambiguous';

interface Fit {
  paramId: number;
  name: string;
  controlType: string;
  classification: Classification;
  unit?: string;
  displayMin?: number;
  displayMax?: number;
  displayScale?: 'linear' | 'log10';
  residLinearPct?: number;
  residLog10Pct?: number;
  monotonic: boolean;
  distinctLabels: string[];
  specialMinLabel?: string;
  samples: Array<{ setWire: number; echoedWire: number; label: string; num?: number }>;
  notes: string[];
}

function fitParam(p: ParamSweep): Fit {
  const notes: string[] = [];
  const parsed = p.samples.map((s) => ({ ...s, ...parseLabel(s.label) }));
  const distinctLabels = [...new Set(p.samples.map((s) => s.label))];
  const echoes = p.samples.map((s) => s.echoedWire);
  const echoDistinct = new Set(echoes).size;
  const monotonic = echoes.every((v, i) => i === 0 || v >= echoes[i - 1]) && echoDistinct >= 4;

  // Stuck/gated: the param did not move (same echoed wire / same label at
  // every set point) -> inactive on the loaded amp model.
  if (echoDistinct <= 1 || distinctLabels.length === 1) {
    notes.push('param did not respond to sets (gated/inactive on loaded amp model); re-sweep on a model where it is active');
    return {
      paramId: p.paramId, name: p.name, controlType: p.controlType,
      classification: 'stuck', monotonic: false, distinctLabels,
      samples: parsed.map((s) => ({ setWire: s.setWire, echoedWire: s.echoedWire, label: s.label, num: s.num })),
      notes,
    };
  }

  const numericCount = parsed.filter((s) => s.num !== undefined).length;
  // Enum: labels are (mostly) non-numeric.
  if (numericCount <= 2) {
    notes.push('non-numeric labels -> enum; coarse 5-point sweep under-samples enum indices, needs finer sweep or fn 0x28 dump for full table');
    return {
      paramId: p.paramId, name: p.name, controlType: p.controlType,
      classification: 'enum', monotonic, distinctLabels,
      samples: parsed.map((s) => ({ setWire: s.setWire, echoedWire: s.echoedWire, label: s.label, num: s.num })),
      notes,
    };
  }

  // Numeric fit. Endpoints from the set points closest to 0 and FULL that
  // parsed numerically. wire 0 may carry a special label (e.g. "P.A. OFF").
  const lo = parsed[0];
  const hi = parsed[parsed.length - 1];
  let specialMinLabel: string | undefined;
  let min: number;
  if (lo.num === undefined) {
    // Special min label; take the next numeric sample as the practical min.
    specialMinLabel = lo.raw;
    const firstNumeric = parsed.find((s) => s.num !== undefined)!;
    min = firstNumeric.num!;
    notes.push(`wire 0 renders as "${lo.raw}" (special); numeric range starts at next point`);
  } else {
    min = lo.num;
  }
  const max = hi.num!;
  const unit = (hi.unit || parsed.find((s) => s.unit)?.unit || '').trim();

  // Midpoint prediction. setWire 32767 ~= FULL/2.
  const midSample = parsed.find((s) => s.setWire === 32767);
  const mid = midSample?.num;
  let residLinearPct: number | undefined;
  let residLog10Pct: number | undefined;
  let classification: Classification = 'linear';
  let displayScale: 'linear' | 'log10' = 'linear';
  const span = Math.abs(max - min) || 1;
  if (mid !== undefined) {
    const linMid = min + (max - min) * (32767 / FULL);
    residLinearPct = (Math.abs(mid - linMid) / span) * 100;
    if (min > 0 && max > 0) {
      const logMid = min * Math.pow(max / min, 32767 / FULL);
      residLog10Pct = (Math.abs(mid - logMid) / span) * 100;
    }
    if (residLog10Pct !== undefined && residLog10Pct + 0.5 < residLinearPct) {
      classification = 'log10'; displayScale = 'log10';
    } else {
      classification = 'linear'; displayScale = 'linear';
    }
    // If both residuals are large, flag ambiguous.
    const best = Math.min(residLinearPct, residLog10Pct ?? Infinity);
    if (best > 5) {
      classification = 'ambiguous';
      notes.push(`midpoint fits neither scale well (lin ${residLinearPct.toFixed(1)}%, log ${residLog10Pct?.toFixed(1) ?? 'n/a'}%); verify manually`);
    }
  } else {
    notes.push('no numeric midpoint; scale undetermined');
    classification = 'ambiguous';
  }

  return {
    paramId: p.paramId, name: p.name, controlType: p.controlType,
    classification,
    unit,
    displayMin: min,
    displayMax: max,
    displayScale,
    residLinearPct,
    residLog10Pct,
    monotonic,
    distinctLabels,
    specialMinLabel,
    samples: parsed.map((s) => ({ setWire: s.setWire, echoedWire: s.echoedWire, label: s.label, num: s.num })),
    notes,
  };
}

function main(): void {
  const root = process.cwd();
  const inPath = path.resolve(root, 'samples', 'captured', 'decoded', 'ii-opaque-amp-sweep.json');
  const sweep = JSON.parse(readFileSync(inPath, 'utf8')) as SweepFile;
  const fits = sweep.params.map(fitParam);

  const by = (c: Classification) => fits.filter((f) => f.classification === c);
  console.log(`Fitted ${fits.length} params:`);
  console.log(`  linear:    ${by('linear').length}`);
  console.log(`  log10:     ${by('log10').length}`);
  console.log(`  enum:      ${by('enum').length}`);
  console.log(`  stuck:     ${by('stuck').length}`);
  console.log(`  ambiguous: ${by('ambiguous').length}\n`);

  console.log('name\tclass\tunit\tmin\tmax\tscale\tlinResid%\tlogResid%');
  for (const f of fits) {
    console.log([
      f.name, f.classification, f.unit ?? '', f.displayMin ?? '', f.displayMax ?? '',
      f.displayScale ?? '',
      f.residLinearPct?.toFixed(1) ?? '', f.residLog10Pct?.toFixed(1) ?? '',
    ].join('\t'));
  }

  const outPath = path.resolve(root, 'samples', 'captured', 'decoded', 'ii-opaque-amp-fit.json');
  writeFileSync(outPath, JSON.stringify({ effectId: sweep.effectId, fits }, null, 2));
  console.log(`\nWrote ${fits.length} fits → ${outPath}`);
}

main();
