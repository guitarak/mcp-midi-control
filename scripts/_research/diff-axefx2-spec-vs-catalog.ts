/**
 * Diff the public Axe-Fx II MIDI spec (Adam Cook, 2014) against our SHIPPED
 * Axe-Fx II catalog (hardware-mined: wiki + Axe-Edit XML + fn=0x28 + Ghidra).
 *
 * Discipline: our catalog is hardware-verified; the spec is self-described as
 * "not 100% accurate." So this is a CROSS-CHECK, not a source of truth. The diff
 * flags disagreements for careful human resolution; it does NOT auto-correct.
 *
 * Join strategy:
 *   - effect IDs: the spec's ID_* enum values are compared directly to our
 *     BLOCK_BY_ID (both number the blocks from 100).
 *   - params: the spec's per-block param enums carry ordinal paramIds; we align
 *     them to our params by (block, paramId), mapping the spec's block via the
 *     shared effect ID, then compare the symbol/name.
 *
 *   npx tsx scripts/_research/diff-axefx2-spec-vs-catalog.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { KNOWN_PARAMS } from '../../packages/fractal-midi/src/axe-fx-ii/params.js';
import { AXE_FX_II_BLOCKS, BLOCK_BY_ID } from '../../packages/fractal-midi/src/axe-fx-ii/blockTypes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GEN2 = join(HERE, 'gen2-out');
const OUT_DIR = GEN2;

interface SpecEffectId {
  name: string;
  id: number;
}
interface SpecMember {
  name: string;
  value: number;
}
interface SpecParamEnum {
  block: string;
  context: string;
  members: SpecMember[];
}

const specEffectIds: SpecEffectId[] = JSON.parse(readFileSync(join(GEN2, 'effectIds.json'), 'utf8'));
const specParamEnums: SpecParamEnum[] = JSON.parse(readFileSync(join(GEN2, 'paramEnums.json'), 'utf8'));

// ----- our catalog, indexed -------------------------------------------------
interface OurParam {
  groupCode: string;
  block: string;
  paramId: number;
  wikiName: string;
  name: string;
  parameterName?: string;
}
const ourParams = Object.values(KNOWN_PARAMS as Record<string, OurParam>);
// groupCode -> (paramId -> param)
const ourByGroup = new Map<string, Map<number, OurParam>>();
// groupCode -> representative block slug
const slugByGroup = new Map<string, string>();
for (const p of ourParams) {
  if (!ourByGroup.has(p.groupCode)) ourByGroup.set(p.groupCode, new Map());
  ourByGroup.get(p.groupCode)!.set(p.paramId, p);
  if (!slugByGroup.has(p.groupCode)) slugByGroup.set(p.groupCode, p.block);
}

// ----- effect-ID diff -------------------------------------------------------
/** Strip a trailing instance digit: ID_COMP1 -> COMP, ID_AMP2 -> AMP. */
function effectBase(idName: string): string {
  return idName.replace(/^ID_/, '').replace(/\d+$/, '');
}

interface EffectIdRow {
  specName: string;
  id: number;
  ourBlockName?: string;
  ourGroupCode?: string;
  status: 'match' | 'spec-only-id' | 'name-note';
}
const effectRows: EffectIdRow[] = [];
for (const e of specEffectIds) {
  const ours = BLOCK_BY_ID[e.id];
  effectRows.push({
    specName: e.name,
    id: e.id,
    ourBlockName: ours?.name,
    ourGroupCode: ours?.groupCode,
    status: ours ? 'match' : 'spec-only-id',
  });
}
const ourIds = new Set(AXE_FX_II_BLOCKS.map((b) => b.id));
const specIds = new Set(specEffectIds.map((e) => e.id));
const oursNotInSpec = AXE_FX_II_BLOCKS.filter((b) => !specIds.has(b.id));

// Map spec effect-base -> effectId (first instance) so we can route param blocks.
const effectBaseToId = new Map<string, number>();
for (const e of specEffectIds) {
  const base = effectBase(e.name);
  if (!effectBaseToId.has(base)) effectBaseToId.set(base, e.id);
}

// The spec's param-enum member prefix is NOT always its effect-ID base name.
// This map is the cross-reference work: spec member-prefix -> our groupCode,
// with a representative effectId for routing. Derived by reading both sides.
// `ambiguous`/`note` flag rows that need a careful human call.
const PREFIX_TO_GROUP: Record<string, { group: string; note?: string }> = {
  COMP: { group: 'CPR' },
  GEQ: { group: 'GEQ' },
  PEQ: { group: 'PEQ' },
  DISTORT: { group: 'AMP', note: 'spec calls the amp block DISTORT' },
  CABINET: { group: 'CAB' },
  REVERB: { group: 'REV' },
  DELAY: { group: 'DLY' },
  MULTITAP: { group: 'MTD', note: 'spec MULTITAP = our Multi Delay (MTD)' },
  CHORUS: { group: 'CHO' },
  FLANGER: { group: 'FLG' },
  ROTARY: { group: 'ROT' },
  PHASER: { group: 'PHA' },
  WAH: { group: 'WAH' },
  FORMANT: { group: 'FRM' },
  VOLUME: { group: 'VOL' },
  TREMOLO: { group: 'TRM' },
  PITCH: { group: 'PIT' },
  FILTER: { group: 'FIL' },
  FUZZ: { group: 'DRV', note: 'spec FUZZ = our Drive (DRV)' },
  ENHANCER: { group: 'ENH' },
  LOOPER: { group: 'LPR', note: 'spec LOOPER = our audio Looper (LPR id 169). Confirmed by RECORD/PLAY/ONCE/DUB/UNDO members. FX Loop (FXL id 136) is NOT separately documented in the spec.' },
  MIXER: { group: 'MIX' },
  NOISEGATE: { group: 'INPUT', note: 'spec NOISEGATE = our Input Noise Gate (INPUT)' },
  OUTPUT: { group: 'OUTPUT' },
  CONTROLLERS: { group: 'CONTROLLERS' },
  FDBKSEND: { group: 'SND' },
  FDBKRET: { group: 'RTN' },
  SYNTH: { group: 'SYN' },
  VOCODER: { group: 'VOC' },
  MEGATAP: { group: 'MGT' },
  CROSSOVER: { group: 'XVR' },
  GATE: { group: 'GTE' },
  RINGMOD: { group: 'RNG' },
  MULTICOMP: { group: 'MBC' },
  QUADCHO: { group: 'QCH' },
  RESONATOR: { group: 'RES' },
  EQMATCH: { group: 'TMA', note: 'Tone Match: block exists (id 170) but our catalog has NO TMA params -> all spec-only' },
  // Non-block param structs: documented, not aligned to a block.
  GLOBAL: { group: '', note: 'global/system params, not a per-block effect' },
  MOD: { group: '', note: 'modifier definition struct, not a block' },
  B: { group: '', note: 'auxiliary type enums (interpolation/units), not params' },
};

/** Spec block key = the common prefix of its members (before the first "_"). */
function specBlockKey(members: SpecMember[]): string {
  const real = members.filter((m) => !/_(END|MAX|COUNT|NUM)$/.test(m.name));
  const prefixes = real.map((m) => m.name.split('_')[0]);
  const first = prefixes[0] ?? '';
  return prefixes.every((p) => p === first) ? first : first; // first prefix is the block tag
}

function specBlockToGroup(prefix: string): { groupCode?: string; via?: number; note?: string } {
  const mapped = PREFIX_TO_GROUP[prefix];
  if (mapped && mapped.group) {
    const ids = AXE_FX_II_BLOCKS.filter((b) => b.groupCode === mapped.group).map((b) => b.id);
    return { groupCode: mapped.group, via: ids[0], note: mapped.note };
  }
  if (mapped) return { note: mapped.note }; // known non-block
  // fall back to effect-base match
  const id = effectBaseToId.get(prefix);
  if (id !== undefined) return { groupCode: BLOCK_BY_ID[id]?.groupCode, via: id };
  return {};
}

// ----- name comparison ------------------------------------------------------
function normName(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
/** Does the spec symbol plausibly denote our param? Strip the block prefix. */
function namesAgree(specSymbol: string, specBlock: string, our: OurParam): boolean {
  let sym = specSymbol;
  const pre = specBlock + '_';
  if (sym.startsWith(pre)) sym = sym.slice(pre.length);
  const s = normName(sym);
  const candidates = [our.name, our.wikiName, our.parameterName ?? ''].map(normName).filter(Boolean);
  return candidates.some((c) => c === s || c.includes(s) || s.includes(c));
}

interface ParamDiff {
  specBlock: string;
  groupCode?: string;
  via?: number;
  bothAgree: number;
  bothDisagree: { paramId: number; spec: string; ours: string }[];
  specOnly: { paramId: number; spec: string }[];
  oursOnly: { paramId: number; ours: string }[];
  unmapped?: boolean;
  coverageGap?: boolean;
  note?: string;
  memberCount: number;
}

const paramDiffs: ParamDiff[] = [];
for (const pe of specParamEnums) {
  const realMembers = pe.members.filter((m) => !/_(END|MAX|COUNT|NUM)$/.test(m.name));
  const prefix = specBlockKey(pe.members);
  const { groupCode, via, note } = specBlockToGroup(prefix);
  const diff: ParamDiff & { note?: string } = {
    specBlock: prefix,
    groupCode,
    via,
    note,
    bothAgree: 0,
    bothDisagree: [],
    specOnly: [],
    oursOnly: [],
    memberCount: realMembers.length,
  };
  if (!groupCode) {
    diff.unmapped = true; // genuine non-block (GLOBAL/MOD/B)
    paramDiffs.push(diff);
    continue;
  }
  if (!ourByGroup.has(groupCode)) {
    // Block exists in our blockTypes but has ZERO params in our catalog.
    diff.coverageGap = true;
    diff.specOnly = realMembers.map((m) => ({ paramId: m.value, spec: m.name }));
    paramDiffs.push(diff);
    continue;
  }
  const ourMap = ourByGroup.get(groupCode)!;
  const specMap = new Map<number, string>();
  for (const m of realMembers) if (!specMap.has(m.value)) specMap.set(m.value, m.name);

  const allIds = new Set<number>([...specMap.keys(), ...ourMap.keys()]);
  for (const pid of [...allIds].sort((a, b) => a - b)) {
    const spec = specMap.get(pid);
    const our = ourMap.get(pid);
    if (spec && our) {
      if (namesAgree(spec, prefix, our)) diff.bothAgree++;
      else diff.bothDisagree.push({ paramId: pid, spec, ours: `${our.name} (${our.wikiName})` });
    } else if (spec && !our) {
      diff.specOnly.push({ paramId: pid, spec });
    } else if (!spec && our) {
      diff.oursOnly.push({ paramId: pid, ours: `${our.name} (${our.wikiName})` });
    }
  }
  paramDiffs.push(diff);
}

// ----- report ---------------------------------------------------------------
const L: string[] = [];
L.push('# Axe-Fx II: public spec (Adam Cook 2014) vs shipped catalog');
L.push('');
L.push('Mechanical diff. Our catalog is hardware-mined and verified; the spec is a');
L.push('cross-check ("not 100% accurate" per its author). Disagreements are flagged,');
L.push('not auto-resolved.');
L.push('');
L.push('## 1. Effect-ID table');
L.push('');
L.push(`- Spec effect IDs: ${specEffectIds.length}`);
L.push(`- Our blocks: ${AXE_FX_II_BLOCKS.length}`);
L.push(`- Spec IDs present in our table: ${effectRows.filter((r) => r.status === 'match').length}`);
L.push(`- Spec IDs NOT in our table: ${effectRows.filter((r) => r.status === 'spec-only-id').length}`);
L.push(`- Our blocks NOT in spec: ${oursNotInSpec.length}${oursNotInSpec.length ? ' (' + oursNotInSpec.map((b) => `${b.id} ${b.name}`).join(', ') + ')' : ''}`);
L.push('');
L.push('| Spec ID | # | Our block | group | status |');
L.push('|---|---|---|---|---|');
for (const r of effectRows) {
  L.push(`| ${r.specName} | ${r.id} | ${r.ourBlockName ?? '—'} | ${r.ourGroupCode ?? '—'} | ${r.status} |`);
}
L.push('');
L.push('## 2. Parameter alignment by block');
L.push('');
const mapped = paramDiffs.filter((d) => !d.unmapped && !d.coverageGap);
const coverageGaps = paramDiffs.filter((d) => d.coverageGap);
const unmapped = paramDiffs.filter((d) => d.unmapped);
const totAgree = mapped.reduce((n, d) => n + d.bothAgree, 0);
const totDisagree = mapped.reduce((n, d) => n + d.bothDisagree.length, 0);
const totSpecOnly = mapped.reduce((n, d) => n + d.specOnly.length, 0);
const totOursOnly = mapped.reduce((n, d) => n + d.oursOnly.length, 0);
L.push(`- Spec param-enum blocks: ${specParamEnums.length} (mapped to our blocks: ${mapped.length}, unmapped: ${unmapped.length})`);
L.push(`- Param IDs where BOTH agree: ${totAgree}`);
L.push(`- Param IDs where BOTH present but names DISAGREE: ${totDisagree}`);
L.push(`- Spec-only paramIds (in spec, absent in our block): ${totSpecOnly}`);
L.push(`- Our-only paramIds (in our block, absent in spec): ${totOursOnly}`);
if (unmapped.length) L.push(`- Unmapped spec blocks (no effect-ID equivalent): ${unmapped.map((d) => `${d.specBlock}(${d.memberCount})`).join(', ')}`);
L.push('');
L.push('| Spec block | via id | group | agree | disagree | spec-only | ours-only |');
L.push('|---|---|---|---|---|---|---|');
for (const d of mapped.sort((a, b) => (a.via ?? 0) - (b.via ?? 0))) {
  L.push(`| ${d.specBlock} | ${d.via ?? '—'} | ${d.groupCode ?? '—'} | ${d.bothAgree} | ${d.bothDisagree.length} | ${d.specOnly.length} | ${d.oursOnly.length} |`);
}
L.push('');
L.push('## 3. Name DISAGREEMENTS (same paramId, different meaning) — investigate carefully');
L.push('');
L.push('These are the rows that matter most: the spec and our catalog both define a');
L.push('paramId but the names do not obviously match. Each needs a human call on which');
L.push('is right (default: trust the hardware-mined catalog; the spec is older + lossy).');
L.push('');
let anyDisagree = false;
for (const d of mapped) {
  if (!d.bothDisagree.length) continue;
  anyDisagree = true;
  L.push(`### ${d.specBlock} (group ${d.groupCode}, effectId ${d.via})`);
  L.push('');
  L.push('| paramId | spec symbol | our param |');
  L.push('|---|---|---|');
  for (const r of d.bothDisagree) L.push(`| ${r.paramId} | ${r.spec} | ${r.ours} |`);
  L.push('');
}
if (!anyDisagree) L.push('_none_');
L.push('');
L.push('## 4. Spec-only paramIds (candidate gaps in our catalog) — verify before adding');
L.push('');
let anySpecOnly = false;
for (const d of mapped) {
  if (!d.specOnly.length) continue;
  anySpecOnly = true;
  L.push(`- **${d.specBlock}** (group ${d.groupCode}): ${d.specOnly.map((r) => `${r.paramId}:${r.spec}`).join(', ')}`);
}
if (!anySpecOnly) L.push('_none_');
L.push('');
L.push('## 5. Coverage gaps: blocks in our blockTypes with ZERO params in our catalog');
L.push('');
L.push('These blocks exist (effectId assigned) but we expose no parameters for them.');
L.push('The 2014 spec documents their full param list, a concrete way to close the gap.');
L.push('');
if (!coverageGaps.length) L.push('_none_');
for (const d of coverageGaps) {
  L.push(`- **${d.specBlock}** -> group ${PREFIX_TO_GROUP[d.specBlock]?.group ?? '?'} (${d.memberCount} spec params). ${d.note ?? ''}`);
}
L.push('');
L.push('## 6. Non-block spec enums (not effect blocks)');
L.push('');
for (const d of unmapped) {
  L.push(`- **${d.specBlock}** (${d.memberCount} members): ${d.note ?? 'no mapping'}`);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'diff-report.md'), L.join('\n'));
writeFileSync(
  join(OUT_DIR, 'diff.json'),
  JSON.stringify({ effectRows, oursNotInSpec, paramDiffs }, null, 2),
);

console.log(`effect IDs: spec=${specEffectIds.length} ours=${AXE_FX_II_BLOCKS.length} matched=${effectRows.filter((r) => r.status === 'match').length}`);
console.log(`params: agree=${totAgree} disagree=${totDisagree} specOnly=${totSpecOnly} oursOnly=${totOursOnly}`);
console.log(`unmapped spec blocks: ${unmapped.map((d) => d.specBlock).join(', ') || '(none)'}`);
console.log(`report -> ${join(OUT_DIR, 'diff-report.md')}`);
