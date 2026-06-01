/**
 * Extract printable ASCII strings >= 4 chars from each candidate-unpacked
 * firmware binary. If a variant is the correct unpacking, we expect to
 * see at least some recognizable Fractal/AM4 strings (block names,
 * param labels, "AMP", "DELAY", "REVERB", "Fractal", version build
 * date, etc.).
 *
 * Pass / fail criterion (per CLAUDE.md "one capture per hypothesis"):
 *   PASS: at least 5 hits among the AM4 block-name vocabulary
 *         (AMP, DRIVE, DELAY, REVERB, CHORUS, FLANGER, PHASER, ROTARY,
 *         WAH, VOLUME, TREMOLO, FILTER, ENHANCER, GATE, COMP, GEQ, PEQ)
 *         AND at least one occurrence of "Fractal" or "AM4" or a
 *         build-date "Mar 20 2026" (or similar).
 *   FAIL: variant produces fewer than 5 hits → not the right unpacking,
 *         OR the firmware is encrypted/compressed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function unpack8to7MsbLast(p: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < p.length) {
    const groupLen = Math.min(8, p.length - i);
    if (groupLen < 2) break;
    const dataLen = groupLen - 1;
    const msbByte = p[i + dataLen];
    for (let k = 0; k < dataLen; k++) {
      const lo7 = p[i + k] & 0x7f;
      const hi1 = (msbByte >> k) & 0x01;
      out.push((hi1 << 7) | lo7);
    }
    i += groupLen;
  }
  return Buffer.from(out);
}
function unpack8to7MsbFirst(p: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < p.length) {
    const groupLen = Math.min(8, p.length - i);
    if (groupLen < 2) break;
    const msbByte = p[i];
    for (let k = 0; k < groupLen - 1; k++) {
      const lo7 = p[i + 1 + k] & 0x7f;
      const hi1 = (msbByte >> k) & 0x01;
      out.push((hi1 << 7) | lo7);
    }
    i += groupLen;
  }
  return Buffer.from(out);
}

function extractStrings(b: Buffer, minLen = 4): Array<{ off: number; s: string }> {
  const out: Array<{ off: number; s: string }> = [];
  let start = -1;
  const chars: number[] = [];
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c >= 0x20 && c <= 0x7e) {
      if (start === -1) start = i;
      chars.push(c);
    } else {
      if (start !== -1 && chars.length >= minLen) {
        out.push({ off: start, s: Buffer.from(chars).toString('utf8') });
      }
      start = -1;
      chars.length = 0;
    }
  }
  if (start !== -1 && chars.length >= minLen) {
    out.push({ off: start, s: Buffer.from(chars).toString('utf8') });
  }
  return out;
}

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
  'Mid',
  'Treble',
  'TREBLE',
];

const VARIANTS = [
  {
    name: 'raw',
    buf: readFileSync(
      join(ROOT, 'packages/fractal-midi/samples/captured/decoded/am4-firmware-extracted-raw.bin')
    ),
  },
  {
    name: 'msb-first-8to7',
    buf: unpack8to7MsbFirst(
      readFileSync(
        join(ROOT, 'packages/fractal-midi/samples/captured/decoded/am4-firmware-extracted-raw.bin')
      )
    ),
  },
  {
    name: 'msb-last-8to7',
    buf: unpack8to7MsbLast(
      readFileSync(
        join(ROOT, 'packages/fractal-midi/samples/captured/decoded/am4-firmware-extracted-raw.bin')
      )
    ),
  },
];

const report: any[] = [];
for (const v of VARIANTS) {
  const strs = extractStrings(v.buf, 4);
  const vocabHits: Array<{ word: string; count: number; sample_offs: number[] }> = [];
  for (const w of VOCAB) {
    const hits = strs.filter((x) => x.s.includes(w));
    if (hits.length > 0) {
      vocabHits.push({ word: w, count: hits.length, sample_offs: hits.slice(0, 3).map((h) => h.off) });
    }
  }
  const ascii_strings_total = strs.length;
  const longest = strs.reduce(
    (acc, s) => (s.s.length > acc.s.length ? s : acc),
    { off: -1, s: '' }
  );
  console.log(`\n[${v.name}] ${v.buf.length} bytes`);
  console.log(`   ASCII strings (>=4 chars): ${ascii_strings_total}`);
  console.log(`   longest: len=${longest.s.length}  off=${longest.off}  "${longest.s.slice(0, 60).replace(/\n/g, '\\n')}"`);
  console.log(`   vocab hits: ${vocabHits.length}`);
  for (const h of vocabHits) {
    console.log(`      ${h.word}: ${h.count}× (first off=0x${h.sample_offs[0].toString(16)})`);
  }
  report.push({
    variant: v.name,
    bytes: v.buf.length,
    ascii_strings_total,
    vocab_hits: vocabHits,
    longest_string: { off: longest.off, len: longest.s.length, preview: longest.s.slice(0, 200) },
  });
}

writeFileSync(
  join(
    ROOT,
    'packages/fractal-midi/samples/captured/decoded/am4-firmware-string-probe.json'
  ),
  JSON.stringify(report, null, 2)
);
