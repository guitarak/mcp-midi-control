/**
 * P1 de-risking gate (read-only): validate Drew's (BoodieTraps) fractal-syx-codec
 * read-ordinal roster tables against EVERY gen-3 enum point we captured on our own
 * hardware, and confirm the target param symbols exist in our gen-3 catalogs.
 *
 * Source tables (Apache-2.0, Andrew Mercurio): docs/_private/fractal-syx-codec-main/.../data/
 * Our anchors: FM9_ENUM_OVERRIDES (fractal-midi/gen3/fm9) — read-leg ordinal->name points
 * captured from a real FM9. If Drew's table disagrees with any captured anchor, STOP.
 */
import { readFileSync } from 'node:fs';
import { FM9_ENUM_OVERRIDES } from '../../packages/fractal-midi/src/gen3/fm9/index.ts';

const DREW = 'docs/_private/fractal-syx-codec-main/fractal-syx-codec-main/data';

// Drew block file -> our gen-3 param firmware symbol (the block's type selector).
const BLOCK_TO_SYMBOL: Record<string, string> = {
  amp: 'DISTORT_TYPE',
  drive: 'FUZZ_TYPE',
  reverb: 'REVERB_TYPE',
  delay: 'DELAY_TYPE',
  cab: 'CAB_TYPE',
  dynacab: 'CAB_TYPE', // verify: which one our CAB_TYPE roster matches
  chorus: 'CHORUS_TYPE',
  comp: 'COMP_TYPE',
  flanger: 'FLANGER_TYPE',
  phaser: 'PHASER_TYPE',
  tremolo: 'TREMOLO_TYPE',
  wah: 'WAH_TYPE',
  filter: 'FILTER_TYPE',
};

function load(block: string): Record<string, string> {
  return JSON.parse(readFileSync(`${DREW}/${block}_type_binary_ids.json`, 'utf8'));
}

console.log('=== Cross-validate Drew read-ordinal tables vs our FM9 hardware anchors ===\n');
let conflicts = 0;
let confirmed = 0;
for (const [symbol, anchors] of Object.entries(FM9_ENUM_OVERRIDES)) {
  // find the Drew block whose symbol maps here
  const block = Object.entries(BLOCK_TO_SYMBOL).find(([, s]) => s === symbol)?.[0];
  if (block === undefined) {
    console.log(`  [skip] our symbol ${symbol} has no mapped Drew table`);
    continue;
  }
  let table: Record<string, string>;
  try { table = load(block); } catch { console.log(`  [skip] no Drew ${block} table for ${symbol}`); continue; }
  for (const [ordStr, ourName] of Object.entries(anchors)) {
    const drewName = table[ordStr];
    const norm = (s: string) => s.toLowerCase().replace(/[\s,]+/g, '');
    if (drewName === undefined) {
      console.log(`  [GAP ]  ${symbol}[${ordStr}] = "${ourName}" (ours) — absent in Drew ${block}`);
    } else if (norm(drewName) === norm(ourName)) {
      console.log(`  [ OK ]  ${symbol}[${ordStr}] = "${ourName}" == Drew "${drewName}"`);
      confirmed++;
    } else {
      console.log(`  [CONFLICT] ${symbol}[${ordStr}]: ours "${ourName}" vs Drew "${drewName}"`);
      conflicts++;
    }
  }
}

console.log('\n=== Would-register roster sizes (read-ordinal -> name, display-only) ===');
let total = 0;
for (const [block, symbol] of Object.entries(BLOCK_TO_SYMBOL)) {
  try { const t = load(block); total += Object.keys(t).length; console.log(`  ${symbol.padEnd(13)} <- ${block.padEnd(8)} ${Object.keys(t).length} labels`); }
  catch { console.log(`  ${symbol.padEnd(13)} <- ${block.padEnd(8)} (no table)`); }
}
console.log(`\n  confirmed against our HW: ${confirmed}, conflicts: ${conflicts}, total labels: ${total}`);
console.log(conflicts === 0
  ? '\n  GATE PASS: no conflicts with captured anchors — safe to register as a shared gen-3 read overlay.'
  : '\n  GATE FAIL: conflicts found — do NOT mass-register until resolved.');
