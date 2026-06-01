/**
 * The raw packed firmware contains the repeated 4-byte pattern
 * `6E 77 3B 5D` ("nw;]") in long stretches. If the payload is XOR-
 * encrypted with a short repeating key, those stretches correspond to
 * runs of zeros in the original.
 *
 * Tests:
 *   1. XOR the raw stream with each plausible repeating key derived from
 *      the most-common 4-byte n-gram. Score the decoded output against
 *      the AM4 string vocabulary (same as probe-am4-firmware-strings.ts).
 *   2. Also try XOR with the key candidates after unpacking 8→7.
 *   3. Report the highest-scoring (key, unpack-stage) combo.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const RAW = readFileSync(
  join(ROOT, 'packages/fractal-midi/samples/captured/decoded/am4-firmware-extracted-raw.bin')
);

// Find the most common 4-byte n-grams (across 4-byte-aligned slots,
// which is where a 4-byte XOR key would land).
const counts = new Map<string, number>();
for (let i = 0; i + 4 <= RAW.length; i += 4) {
  const key = RAW.subarray(i, i + 4).toString('hex');
  counts.set(key, (counts.get(key) ?? 0) + 1);
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('top 10 four-byte n-grams (4-byte aligned):');
for (const [k, n] of sorted) console.log(`   ${k}  ×${n}`);

const VOCAB = [
  'AMP',
  'DRIVE',
  'DELAY',
  'REVERB',
  'CHORUS',
  'FLANGER',
  'PHASER',
  'ROTARY',
  'WAH',
  'VOLUME',
  'TREMOLO',
  'FILTER',
  'ENHANCER',
  'GATE',
  'COMP',
  'GEQ',
  'PEQ',
  'Fractal',
  'FRACTAL',
  'AM4',
  'Mar 20 2026',
  'Bypass',
  'BYPASS',
  'Gain',
  'GAIN',
  'Master',
  'MASTER',
  'Bass',
  'BASS',
  'Treble',
  'TREBLE',
  'PRESET',
  'Preset',
];

function xorWithKey(b: Buffer, key: Buffer): Buffer {
  const out = Buffer.alloc(b.length);
  for (let i = 0; i < b.length; i++) {
    out[i] = b[i] ^ key[i % key.length];
  }
  return out;
}

function scoreStrings(b: Buffer): { hits: number; longest: number } {
  let hits = 0;
  let longest = 0;
  // scan strings
  let start = -1;
  const chars: number[] = [];
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c >= 0x20 && c <= 0x7e) {
      if (start === -1) start = i;
      chars.push(c);
    } else {
      if (start !== -1 && chars.length >= 4) {
        const s = Buffer.from(chars).toString('utf8');
        if (s.length > longest) longest = s.length;
        for (const w of VOCAB) if (s.includes(w)) hits++;
      }
      start = -1;
      chars.length = 0;
    }
  }
  return { hits, longest };
}

const candidates = sorted.slice(0, 5).map(([hex]) => Buffer.from(hex, 'hex'));
// Also try variants where we cycle the key by 1,2,3.
const expanded: Buffer[] = [];
for (const k of candidates) {
  expanded.push(k);
  expanded.push(Buffer.from([k[1], k[2], k[3], k[0]]));
  expanded.push(Buffer.from([k[2], k[3], k[0], k[1]]));
  expanded.push(Buffer.from([k[3], k[0], k[1], k[2]]));
}

console.log(`\nXOR variants (raw packed buffer, ${RAW.length} bytes):`);
const results: Array<{ key: string; hits: number; longest: number }> = [];
for (const k of expanded) {
  const dec = xorWithKey(RAW, k);
  const s = scoreStrings(dec);
  results.push({ key: k.toString('hex'), ...s });
}
results.sort((a, b) => b.hits - a.hits);
for (const r of results.slice(0, 10)) {
  console.log(`   key=${r.key}  vocab_hits=${r.hits}  longest_str=${r.longest}`);
}

// Baseline: no XOR
const base = scoreStrings(RAW);
console.log(`\nbaseline (no XOR): hits=${base.hits}, longest=${base.longest}`);
