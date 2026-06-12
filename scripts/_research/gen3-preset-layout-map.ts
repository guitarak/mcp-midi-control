/**
 * Gen-3 preset inner-layout decode (offline, no hardware).
 *
 * Hypothesis under test: the 0x77/0x78/0x79 preset body is a SPARSE, UNCOMPRESSED
 * uint16 image (NOT Huffman-compressed as forum thread #159885 and our own
 * preset-format-research.md claim). If so, the block/param layout is recoverable
 * by differential analysis across the 384 III factory presets.
 *
 * Corpus: samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_ALL-BANKS (384 presets, model 0x10).
 * Cross-check: the FM9 152.syx export (model 0x12, 8 chunks).
 *
 * Word unpacking matches presetDump.ts: per 3074-byte chunk payload, words at
 * offset 2 + i*3, value = b0 | b1<<7 | b2<<14, masked 16-bit. 1024 words/chunk.
 */
import { readFileSync } from 'node:fs';
import { parsePresetBank, parsePresetDump, extractPresetName, type ParsedPresetDump } from '../../packages/fractal-gen3/src/presetDump.ts';

const WORDS_PER_CHUNK = 1024;
const CHUNK_BODY_OFFSET = 2;

function chunkToWords(chunk: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < WORDS_PER_CHUNK; i++) {
    const off = CHUNK_BODY_OFFSET + i * 3;
    out.push((chunk[off] | (chunk[off + 1] << 7) | (chunk[off + 2] << 14)) & 0xffff);
  }
  return out;
}
function presetToWords(p: ParsedPresetDump): number[] {
  const out: number[] = [];
  for (const ch of p.chunkPayloads) out.push(...chunkToWords(ch));
  return out;
}

console.log('=== Loading III factory corpus ===');
const bankDir = 'samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06';
const presets: ParsedPresetDump[] = [];
for (const b of ['A', 'B', 'C']) {
  const buf = new Uint8Array(readFileSync(`${bankDir}/Axe-Fx_III_BANK_${b}-250603-182903.syx`));
  presets.push(...parsePresetBank(buf, 0x10));
}
const N = presets.length;
const wordsLen = presets[0].chunkPayloads.length * WORDS_PER_CHUNK;
console.log(`presets=${N}, chunks/preset=${presets[0].chunkPayloads.length}, words/preset=${wordsLen}`);

// Confirm uncompressed: name decodes + magic universal.
let magicOk = 0;
const names: string[] = [];
for (const p of presets) {
  const w = chunkToWords(p.chunkPayloads[0]);
  if (w[1] === 0xaa55) magicOk++;
  names.push(extractPresetName(p));
}
console.log(`\nmagic word[1]==0xAA55: ${magicOk}/${N}`);
console.log(`sample names: ${names.slice(0, 8).map((n) => JSON.stringify(n)).join(', ')}`);
const nonEmptyNames = names.filter((n) => n.length > 0).length;
console.log(`non-empty names: ${nonEmptyNames}/${N}  (high => body is plain readable uint16, not compressed)`);

// Per-offset differential stats across the corpus.
const matrix = presets.map(presetToWords);
const distinct: Set<number>[] = Array.from({ length: wordsLen }, () => new Set<number>());
const zeroCount = new Array(wordsLen).fill(0);
for (const w of matrix) {
  for (let j = 0; j < wordsLen; j++) {
    if (distinct[j].size < 600) distinct[j].add(w[j]);
    if (w[j] === 0) zeroCount[j]++;
  }
}

// Per-chunk data profile: mean zero-fraction tells us which chunks carry data.
console.log('\n=== per-chunk zero-fraction (mean across 384 presets) ===');
const chunks = presets[0].chunkPayloads.length;
for (let c = 0; c < chunks; c++) {
  let z = 0;
  for (let j = c * WORDS_PER_CHUNK; j < (c + 1) * WORDS_PER_CHUNK; j++) z += zeroCount[j];
  const frac = z / (N * WORDS_PER_CHUNK);
  const bar = '#'.repeat(Math.round((1 - frac) * 40));
  console.log(`  chunk ${String(c).padStart(2)}: data-density ${((1 - frac) * 100).toFixed(1).padStart(5)}%  ${bar}`);
}

// Global header skeleton: words 0..47 — constant (structural) vs variable.
console.log('\n=== global header skeleton (chunk 0, words 0..47) ===');
console.log('  idx  distinct  zero%   constant/role');
for (let j = 0; j < 48; j++) {
  const d = distinct[j].size;
  const zpct = ((zeroCount[j] / N) * 100).toFixed(0);
  let role = '';
  if (j === 1) role = '<= 0xAA55 magic';
  else if (j >= 4 && j < 20) role = '<= preset name region';
  const constVal = d === 1 ? `const=0x${[...distinct[j]][0].toString(16)}` : `(${d} distinct)`;
  console.log(`  ${String(j).padStart(3)}  ${String(d).padStart(7)}  ${zpct.padStart(4)}%   ${constVal} ${role}`);
}

// Look for a candidate BLOCK/EFFECT table: a contiguous run of words that
// (a) are small integers (< 512), (b) vary per preset, (c) are mostly non-zero.
// Gen-3 effect/block IDs live in this range. Report the densest small-int runs
// in the first 3 chunks after the name region.
console.log('\n=== candidate small-integer (effect/block-id?) regions, words 20..400 ===');
let runStart = -1;
for (let j = 20; j < 400; j++) {
  const vals = [...distinct[j]];
  const small = vals.length > 1 && vals.every((v) => v < 1024) && (zeroCount[j] / N) < 0.5;
  if (small && runStart < 0) runStart = j;
  if (!small && runStart >= 0) {
    if (j - runStart >= 3) {
      console.log(`  words ${runStart}..${j - 1} (len ${j - runStart}): small varied ints, e.g. preset0 = [${matrix[0].slice(runStart, Math.min(j, runStart + 12)).join(', ')}]`);
    }
    runStart = -1;
  }
}

// Cross-check FM9 152.syx chunk-0 header against III chunk-0 structure.
console.log('\n=== FM9 152.syx chunk-0 cross-check ===');
const fm9 = parsePresetDump(new Uint8Array(readFileSync('samples/captured/fm9-152-super-duos2-exported-2026-06-03.syx')), 0, 0x12);
const fw = chunkToWords(fm9.chunkPayloads[0]);
console.log(`  name="${extractPresetName(fm9)}", word[1]=0x${fw[1].toString(16)} (expect aa55), words[0..9]=[${fw.slice(0, 10).map((v) => '0x' + v.toString(16)).join(', ')}]`);
console.log(`  III preset0 words[0..9]=[${matrix[0].slice(0, 10).map((v) => '0x' + v.toString(16)).join(', ')}]`);
