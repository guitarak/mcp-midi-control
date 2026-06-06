/**
 * Direct pattern-scan a Fractal editor .exe for its (paramId, symbol)
 * param-table structs — the SeekParamTables technique, generalized to
 * the gen-3 64-bit editors.
 *
 * The dispatcher tables are arrays of 16-byte structs:
 *   { int32 paramId; int32 padding; const char* nameStr; }   // 4+4+8
 * On disk the `nameStr` pointer is an absolute VA (imageBase + rva of
 * the symbol string). We:
 *   1. Parse the PE so we can map file-offset <-> virtual-address.
 *   2. Collect every param-symbol string ([A-Z][A-Z0-9_]+ with a '_'),
 *      recording its VA.
 *   3. Walk the file reading a u64 at each 8-aligned offset; when it
 *      equals a known symbol VA, read the int32 at (offset-8) as the
 *      paramId. That is one table entry.
 *
 * This recovers (paramId, symbol) WITHOUT Ghidra and WITHOUT hardware.
 * Running it on Axe-Edit III.exe must reproduce the Ghidra paramIds
 * (control); running it on FM9-Edit.exe confirms or refutes that the
 * gen-3 family shares paramIds per symbol.
 *
 * Usage:
 *   npx tsx scripts/_research/scan-editor-param-tables.ts <exe> <outJson>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const exePath = process.argv[2];
const outJson = process.argv[3];
if (!exePath || !outJson) {
  console.error('usage: scan-editor-param-tables.ts <exe> <outJson>');
  process.exit(1);
}
const buf = readFileSync(exePath);
console.log(`exe: ${exePath} (${(buf.length / 1048576).toFixed(1)} MB)`);

// ── PE parse: image base + sections ────────────────────────────────
const peOff = buf.readUInt32LE(0x3c);
if (buf.toString('latin1', peOff, peOff + 4) !== 'PE\0\0') {
  throw new Error('not a PE file');
}
const numSections = buf.readUInt16LE(peOff + 6);
const optSize = buf.readUInt16LE(peOff + 20);
const optOff = peOff + 24;
const magic = buf.readUInt16LE(optOff);
const pe32plus = magic === 0x20b;
// ImageBase: PE32+ at optOff+24 (u64); PE32 at optOff+28 (u32).
const imageBase = pe32plus
  ? buf.readBigUInt64LE(optOff + 24)
  : BigInt(buf.readUInt32LE(optOff + 28));
console.log(`PE32+${pe32plus ? '' : ' (32-bit!)'}  imageBase=0x${imageBase.toString(16)}  sections=${numSections}`);

interface Sec { name: string; va: number; vsize: number; raw: number; rawSize: number; }
const sections: Sec[] = [];
const secTableOff = optOff + optSize;
for (let i = 0; i < numSections; i++) {
  const o = secTableOff + i * 40;
  sections.push({
    name: buf.toString('latin1', o, o + 8).replace(/\0+$/, ''),
    vsize: buf.readUInt32LE(o + 8),
    va: buf.readUInt32LE(o + 12),
    rawSize: buf.readUInt32LE(o + 16),
    raw: buf.readUInt32LE(o + 20),
  });
}

function faToVa(fa: number): bigint | undefined {
  for (const s of sections) {
    if (fa >= s.raw && fa < s.raw + s.rawSize) {
      return imageBase + BigInt(s.va + (fa - s.raw));
    }
  }
  return undefined;
}

// ── 1. Collect param-symbol strings and their VAs ──────────────────
// A param symbol: starts A-Z, then [A-Z0-9_], length >= 4, has a '_',
// NUL-terminated. We map VA -> symbol.
const vaToSymbol = new Map<bigint, string>();
let symCount = 0;
{
  let i = 0;
  while (i < buf.length) {
    const c = buf[i];
    // start of token
    if (c >= 0x41 && c <= 0x5a) {
      let j = i + 1;
      let hasUnderscore = false;
      while (j < buf.length) {
        const d = buf[j];
        if (d === 0x5f) hasUnderscore = true;
        if ((d >= 0x41 && d <= 0x5a) || (d >= 0x30 && d <= 0x39) || d === 0x5f) j++;
        else break;
      }
      const len = j - i;
      if (buf[j] === 0x00 && len >= 4 && hasUnderscore) {
        const sym = buf.toString('latin1', i, j);
        const va = faToVa(i);
        if (va !== undefined && !vaToSymbol.has(va)) {
          vaToSymbol.set(va, sym);
          symCount++;
        }
      }
      i = j + 1;
    } else {
      i++;
    }
  }
}
console.log(`param-symbol candidate strings: ${symCount}`);

// ── 2. Walk file for u64 pointers into the symbol set ──────────────
interface Entry { paramId: number; name: string; at: number; }
const entries: Entry[] = [];
for (let off = 8; off + 8 <= buf.length; off += 4) {
  // pointers are 8-aligned in the struct array; struct is 16 bytes so
  // the name pointer sits at a 8-aligned offset. Step by 4 to be safe.
  const ptr = buf.readBigUInt64LE(off);
  if (ptr < imageBase) continue;
  const sym = vaToSymbol.get(ptr);
  if (!sym) continue;
  const paramId = buf.readInt32LE(off - 8);
  // padding sanity: struct's int32 padding at off-4 is usually 0.
  entries.push({ paramId, name: sym, at: off - 8 });
}
console.log(`struct hits (u64 ptr -> symbol): ${entries.length}`);

// Dedupe (symbol -> most common paramId across table copies).
const byName = new Map<string, Map<number, number>>();
for (const e of entries) {
  const m = byName.get(e.name) ?? new Map<number, number>();
  m.set(e.paramId, (m.get(e.paramId) ?? 0) + 1);
  byName.set(e.name, m);
}
const resolved: { name: string; paramId: number; conflicts?: number[] }[] = [];
let conflictCount = 0;
for (const [name, m] of byName) {
  const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const paramId = sorted[0][0];
  const conflicts = sorted.length > 1 ? sorted.map((x) => x[0]) : undefined;
  if (conflicts) conflictCount++;
  resolved.push({ name, paramId, conflicts });
}
resolved.sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(outJson, JSON.stringify({ exe: exePath, count: resolved.length, params: resolved }, null, 2));
console.log(`unique symbols resolved: ${resolved.length} (paramId conflicts: ${conflictCount})`);
console.log(`wrote ${outJson}`);
