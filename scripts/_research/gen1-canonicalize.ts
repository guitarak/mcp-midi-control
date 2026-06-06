/**
 * Canonicalization stage for the gen-1 (Ultra) draft catalog.
 *
 * Turns the raw parser output (scripts/_research/gen1-out/params.json) into
 * codec-shaped records: a snake_case `name`, a `<blockSlug>.<name>` registry
 * key, a control-type classification, and a `scaling` field that REFUSES to
 * imply linear interpolation for the doc's non-linear (`*`) params (the AM4
 * "867 ms vs 40 ms" decode-bug class). Preserves the original doc label as
 * `docName`. This is the prerequisite for emitting a real params.ts.
 *
 * Read-only over the draft; writes gen1-out/canonical-params.json + a report.
 *   npx tsx scripts/_research/gen1-canonicalize.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'gen1-out');

// Explicit block-name -> slug map (controlled; mirrors cross-device slugs where
// a sibling device already uses one, so the later concept-key/alias map has a
// clean target). Keys are the HTML anchor names the parser emits.
const BLOCK_SLUG: Record<string, string> = {
  Amp: 'amp', Cab: 'cab', Chorus: 'chorus', Compressor: 'compressor',
  Controllers: 'controllers', Crossover: 'crossover', Delay: 'delay', Drive: 'drive',
  EffectsLoop: 'effects_loop', Enhancer: 'enhancer', Filter: 'filter', Flanger: 'flanger',
  Formant: 'formant', GateExpander: 'gate_expander', GraphicEQ: 'graphic_eq',
  MegaTap: 'mega_tap', Mixer: 'mixer', MultiDelay: 'multi_delay', MultibandComp: 'multiband_comp',
  NoiseGate: 'noise_gate', Output: 'output', PanTrem: 'pan_trem', ParametricEQ: 'parametric_eq',
  Phaser: 'phaser', Pitch: 'pitch', QuadChorus: 'quad_chorus', Resonator: 'resonator',
  Reverb: 'reverb', RingMod: 'ring_mod', Rotary: 'rotary', Synth: 'synth',
  Vocoder: 'vocoder', VolPan: 'vol_pan', Wah: 'wah',
};

interface ParserParam {
  block: string;
  paramName: string;
  paramDecimal: number;
  paramHex: [number, number];
  decMin?: number;
  decDefault?: number;
  decMax?: number;
  description: string;
  enumValues?: { value: number; name: string }[];
  display?: { min: number; max: number; unit: string; nonlinear: boolean };
}

const params: ParserParam[] = JSON.parse(readFileSync(join(OUT, 'params.json'), 'utf8'));

function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

type ControlType = 'enum' | 'switch' | 'continuous';
type Scaling = 'linear' | 'pending'; // 'pending' = curve unknown, refuse display conversion

interface CanonParam {
  key: string;
  block: string;
  blockSlug: string;
  name: string;
  docName: string;
  paramId: number;
  controlType: ControlType;
  enumValues?: { value: number; name: string }[];
  display?: { min: number; max: number; unit: string };
  scaling?: Scaling;
  scalingPending?: boolean;
  range: { min?: number; default?: number; max?: number };
}

// A param is a "switch" if it has exactly an on/off-style 2-value enum.
function classify(p: ParserParam): ControlType {
  if (p.enumValues && p.enumValues.length >= 2) {
    const names = p.enumValues.map((v) => v.name.toUpperCase());
    if (p.enumValues.length === 2 && names.every((n) => /ON|OFF|YES|NO|ENGAGED|BYPASS/.test(n))) return 'switch';
    return 'enum';
  }
  return 'continuous';
}

// Heuristic scaling: a continuous param whose unit spans >1 decade (Hz/ms/sec)
// is very likely logarithmic; the doc's `*` flag marks non-linear explicitly.
// We NEVER assert linear for a non-linear param: such params get scaling:'pending'
// and scalingPending:true (display conversion refused until a curve is supplied).
function deriveScaling(p: ParserParam): { scaling?: Scaling; pending: boolean } {
  if (!p.display) return { pending: false };
  if (p.display.nonlinear) return { scaling: 'pending', pending: true };
  // Linear-flagged but wide-range Hz/ms/sec: still suspicious -> pending.
  const u = p.display.unit.toLowerCase();
  const span = Math.abs(p.display.max) / Math.max(Math.abs(p.display.min) || 1, 1);
  if ((u.includes('hz') || u === 'ms' || u === 's' || u === 'sec') && span >= 10) {
    return { scaling: 'pending', pending: true };
  }
  return { scaling: 'linear', pending: false };
}

const canon: CanonParam[] = [];
const usedKeys = new Set<string>();
const dupes: string[] = [];

for (const p of params) {
  const blockSlug = BLOCK_SLUG[p.block] ?? slugify(p.block);
  let name = slugify(p.paramName);
  if (!name) name = `param_${p.paramDecimal}`;
  let key = `${blockSlug}.${name}`;
  // Disambiguate intra-block name collisions (e.g. two "spare" rows, or a
  // disambiguated suffix that clashes with a natural "Level 2" label).
  // Increment the suffix until the key is genuinely free.
  if (usedKeys.has(key)) {
    let n = 2;
    while (usedKeys.has(`${blockSlug}.${name}_${n}`)) n++;
    name = `${name}_${n}`;
    key = `${blockSlug}.${name}`;
    dupes.push(`${key} (paramId ${p.paramDecimal})`);
  }
  usedKeys.add(key);

  const controlType = classify(p);
  const { scaling, pending } = controlType === 'continuous' ? deriveScaling(p) : { scaling: undefined, pending: false };

  canon.push({
    key,
    block: p.block,
    blockSlug,
    name,
    docName: p.paramName,
    paramId: p.paramDecimal,
    controlType,
    enumValues: p.enumValues,
    display: p.display ? { min: p.display.min, max: p.display.max, unit: p.display.unit } : undefined,
    scaling,
    scalingPending: pending || undefined,
    range: { min: p.decMin, default: p.decDefault, max: p.decMax },
  });
}

writeFileSync(join(OUT, 'canonical-params.json'), JSON.stringify(canon, null, 2));

// ----- report ---------------------------------------------------------------
const byType = (t: ControlType) => canon.filter((c) => c.controlType === t).length;
const pendingCount = canon.filter((c) => c.scalingPending).length;
const linearCount = canon.filter((c) => c.scaling === 'linear').length;
const blocks = [...new Set(canon.map((c) => c.blockSlug))];

const L: string[] = [];
L.push('# gen-1 canonical params (draft codec data)');
L.push('');
L.push(`- Params: ${canon.length}`);
L.push(`- Block slugs: ${blocks.length}`);
L.push(`- Control types: enum ${byType('enum')}, switch ${byType('switch')}, continuous ${byType('continuous')}`);
L.push(`- Continuous scaling: linear ${linearCount}, **pending (curve unknown, display conversion refused) ${pendingCount}**`);
L.push(`- Registry-key collisions disambiguated: ${dupes.length}`);
L.push('');
L.push('Every key is `<blockSlug>.<name>`. `scalingPending` params must NOT be');
L.push('display-converted until a curve is supplied (no implicit-linear interpolation).');
L.push('');
if (dupes.length) {
  L.push('## Disambiguated keys (verify these are genuinely distinct params)');
  L.push('');
  for (const d of dupes) L.push(`- ${d}`);
  L.push('');
}
L.push('## Sample (first 3 per block, first 8 blocks)');
L.push('');
let shown = 0;
for (const b of blocks.slice(0, 8)) {
  L.push(`### ${b}`);
  for (const c of canon.filter((x) => x.blockSlug === b).slice(0, 3)) {
    const kind = c.controlType === 'enum' ? `enum(${c.enumValues?.length})` : c.controlType;
    const disp = c.display ? `${c.display.min}..${c.display.max}${c.display.unit}${c.scalingPending ? ' [scaling pending]' : c.scaling === 'linear' ? ' [linear]' : ''}` : '';
    L.push(`- \`${c.key}\` pid=${c.paramId} ${kind} ${disp}`);
    shown++;
  }
}
writeFileSync(join(OUT, 'canonical-report.md'), L.join('\n'));

console.log(`canon params=${canon.length} blocks=${blocks.length} enum=${byType('enum')} switch=${byType('switch')} continuous=${byType('continuous')}`);
console.log(`scaling: linear=${linearCount} pending=${pendingCount}; key collisions disambiguated=${dupes.length}`);
console.log(`output -> ${join(OUT, 'canonical-params.json')}`);
