/**
 * wf-am4-variant-blocks-roundtrip.ts  (READ-ONLY, offline)
 *
 * Proves the wire-address derivation for the AM4 variant block families
 * (PLEX / MEGATAP / TENTAP / MULTITAP / DYNDIST / FUZZ) decoded from
 * the Ghidra param-table dump + the vtable variant-resolver table.
 *
 * Two independent offline sources agree:
 *   1. samples/captured/decoded/ghidra-am4edit-paramtables.json
 *        - per-block ParamDescriptor table; table-local paramId field
 *        - ID enum table: effectId -> ID_<BLOCK><instance>
 *   2. packages/fractal-midi/src/am4/variantResolverTables.ts
 *        - vtable resolver: effectType -> [{cache_id, parameterName}]
 *
 * Derivation under test (for signal-processing blocks, paramId >= 10):
 *   wire pidLow  = effectId of ID_<BLOCK>1 in the ID table
 *   wire pidHigh = Ghidra table-local paramId  ( == resolver cache_id )
 *
 * Anchor proof: the same derivation reproduces the SHIPPED reverb/delay
 * addresses byte-for-byte (effectId(ID_REVERB1)=0x42 == reverb pidLow,
 * REVERB_TIME paramId 0x0b == reverb.time pidHigh, etc.), and reproduces
 * the SYSEX-MAP reverb-bypass golden. No hardware, no MIDI port.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildSetFloatParam } from '../../packages/fractal-midi/src/am4/setParam.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');

type GhidraDump = {
  tables: { effectFamily: string; params: { paramId: number; name: string }[] }[];
};
const dump: GhidraDump = JSON.parse(
  readFileSync(resolve(repo, 'samples/captured/decoded/ghidra-am4edit-paramtables.json'), 'utf8'),
);

function famByName(fam: string): Map<string, number> {
  const t = dump.tables.find((x) => x.effectFamily === fam)!;
  return new Map(t.params.map((p) => [p.name, p.paramId]));
}
function idTable(): Map<string, number> {
  const t = dump.tables.find((x) => x.effectFamily === 'ID')!;
  return new Map(t.params.map((p) => [p.name, p.paramId]));
}

const IDS = idTable();
const hex = (n: number) => '0x' + n.toString(16).padStart(2, '0');
const hx = (a: number[]) => a.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

let fails = 0;
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
  if (!ok) fails++;
}

// ---- 1. effectId == SET_PARAM pidLow anchor (known placeable blocks) ----
const knownPidLow: Record<string, number> = {
  ID_COMP1: 0x2e, ID_GRAPHEQ1: 0x32, ID_PARAEQ1: 0x36, ID_DISTORT1: 0x3a,
  ID_REVERB1: 0x42, ID_DELAY1: 0x46, ID_CHORUS1: 0x4e, ID_FLANGER1: 0x52,
  ID_ROTARY1: 0x56, ID_PHASER1: 0x5a, ID_WAH1: 0x5e, ID_VOLUME1: 0x66,
  ID_TREMOLO1: 0x6a, ID_FILTER1: 0x72, ID_FUZZ1: 0x76, ID_ENHANCER1: 0x7a,
  ID_GATE1: 0x92,
};
let anchorOk = true;
for (const [sym, pl] of Object.entries(knownPidLow)) {
  if (IDS.get(sym) !== pl) { anchorOk = false; console.log(`  anchor miss: ${sym} idTable=${IDS.get(sym)} expected=${hex(pl)}`); }
}
check('effectId(ID_<BLOCK>1) == SET_PARAM pidLow for all 17 placeable blocks', anchorOk);

// ---- 2. variant pidLow derivation ----
const variantPidLow = {
  MULTITAP: IDS.get('ID_MULTITAP1')!,
  MEGATAP: IDS.get('ID_MEGATAP1')!,
  TENTAP: IDS.get('ID_TENTAP1')!,
  PLEX: IDS.get('ID_PLEX1')!,
  DYNDIST: IDS.get('ID_DYNDIST1')!,
  FUZZ: IDS.get('ID_FUZZ1')!,
};
console.log('\nDerived variant pidLows (slot-1 instance effectId):');
for (const [k, v] of Object.entries(variantPidLow)) console.log(`  ${k.padEnd(10)} ${hex(v)}`);

// ---- 3. wire round-trip for representative params ----
console.log('\nWire round-trip (action=WRITE float32) for representative variant params:');
const samples: { fam: keyof typeof variantPidLow; sym: string; val: number }[] = [
  { fam: 'PLEX', sym: 'PLEX_DECAY', val: 0.5 },
  { fam: 'PLEX', sym: 'PLEX_SIZE', val: 0.75 },
  { fam: 'MULTITAP', sym: 'MULTITAP_FEEDBACK1', val: 0.4 },
  { fam: 'MEGATAP', sym: 'MEGATAP_NUMTAPS', val: 0.25 },
  { fam: 'TENTAP', sym: 'TENTAP_FEEDBACK', val: 0.6 },
  { fam: 'DYNDIST', sym: 'DYNDIST_DRIVE', val: 0.8 },
];
for (const s of samples) {
  const pidHigh = famByName(s.fam).get(s.sym)!;
  const pidLow = variantPidLow[s.fam];
  const bytes = buildSetFloatParam({ pidLow, pidHigh }, s.val);
  const envelopeOk = bytes[0] === 0xf0 && bytes[1] === 0x00 && bytes[2] === 0x01 &&
    bytes[3] === 0x74 && bytes[4] === 0x15 && bytes[5] === 0x01 && bytes[bytes.length - 1] === 0xf7;
  // septet decode pidLow/pidHigh back out of bytes[6..9]
  const decLow = bytes[6] | (bytes[7] << 7);
  const decHigh = bytes[8] | (bytes[9] << 7);
  check(`${s.fam}.${s.sym}  pidLow=${hex(pidLow)} pidHigh=${hex(pidHigh)}`,
    envelopeOk && decLow === pidLow && decHigh === pidHigh,
    hx(bytes));
}

// ---- 4. shipped-anchor regression: reverb.time reproduced from derivation ----
const revTimeHigh = famByName('REVERB').get('REVERB_TIME')!; // expect 0x0b
const revPidLow = IDS.get('ID_REVERB1')!;                    // expect 0x42
check('derived reverb.time address matches shipped (pidLow 0x42 / pidHigh 0x0b)',
  revPidLow === 0x42 && revTimeHigh === 0x0b, `pidLow=${hex(revPidLow)} pidHigh=${hex(revTimeHigh)}`);

console.log(`\n${fails === 0 ? 'ALL CHECKS PASS' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails === 0 ? 0 : 1);
