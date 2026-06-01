/**
 * Decode the captured fn 0x07 modifier-read frames (PROBE-II-FN18-REPLY result).
 * Parses samples/captured/probe-axefx2-modifier-path.jsonl, extracts fn 0x07
 * device replies, and decodes each as:
 *   [effId:2 septet][slot:2 septet][fieldIdx:2 septet][value16:3 septet][ASCII label NUL]
 * so the structure is verified from bytes, not hand-read.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const file = path.resolve(process.cwd(), 'samples', 'captured', 'probe-axefx2-modifier-path.jsonl');
const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);

const dec14 = (lo: number, hi: number) => lo | (hi << 7);
const dec16 = (b0: number, b1: number, b2: number) => (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);

interface Row { fieldIdx: number; value: number; label: string; raw: string; }
const rows: Row[] = [];
const seenField = new Set<number>();
const sourceEnum = new Map<number, string>();

for (const l of lines) {
  const o = JSON.parse(l) as { fn: number; bytes: string };
  if (o.fn !== 0x07) continue;
  const b = o.bytes.split(' ').map((x) => parseInt(x, 16));
  // F0 00 01 74 07 07 | effId(6,7) | slot(8,9) | fieldIdx(10,11) | value(12,13,14) | ascii.. | 00 | cs | F7
  const effId = dec14(b[6], b[7]);
  const slot = dec14(b[8], b[9]);
  const fieldIdx = dec14(b[10], b[11]);
  const value = dec16(b[12], b[13], b[14]);
  // ASCII label runs from byte 15 to the NUL before checksum.
  let label = '';
  for (let i = 15; i < b.length - 2; i++) {
    if (b[i] === 0x00) break;
    label += String.fromCharCode(b[i]);
  }
  rows.push({ fieldIdx, value, label, raw: o.bytes });
  if (fieldIdx === 0x00) sourceEnum.set(value, label); // field 0 = source selector
}

// Field 0 across the toggles = the source enum.
console.log('=== MODIFIER-SOURCE ENUM (field 0x00 value -> label) ===');
for (const [idx, name] of [...sourceEnum.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${idx} (0x${idx.toString(16)}) = ${JSON.stringify(name)}`);
}

// The full record: take the LAST observed value for each field index 0x00..0x0e.
console.log('\n=== FULL MODIFIER RECORD (last value seen per field 0x00..0x0e) ===');
const byField = new Map<number, Row>();
for (const r of rows) byField.set(r.fieldIdx, r); // last wins
for (let i = 0; i <= 0x0e; i++) {
  const r = byField.get(i);
  if (r) console.log(`  field 0x${i.toString(16).padStart(2, '0')}: value=${r.value.toString().padStart(5)} label=${JSON.stringify(r.label)}`);
  else console.log(`  field 0x${i.toString(16).padStart(2, '0')}: (not captured)`);
}

// Sanity assertions (the target is Amp 1 input_drive, known ground truth).
const f8 = byField.get(0x08);
const f9 = byField.get(0x09);
console.log('\n=== SANITY ===');
console.log(`  field 0x08 (target effectId) = ${f8?.value} (expect 106 = Amp 1): ${f8?.value === 106 ? 'OK' : 'MISMATCH'}`);
console.log(`  field 0x09 (target paramId)  = ${f9?.value} (expect 1 = input_drive): ${f9?.value === 1 ? 'OK' : 'MISMATCH'}`);
