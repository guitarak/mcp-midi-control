/**
 * Extract the source text (entry + up to 6 preceding comment lines) for a
 * list of KNOWN_PARAMS / CACHE_PARAMS keys, for provenance review before the
 * 2026-06-09 accuracy-pass rewrite. Read-only.
 *
 * Run: npx tsx scripts/_research/am4-extract-entries.ts <keysFile>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const PARAMS = 'packages/fractal-midi/src/am4/params.ts';
const CACHE = 'packages/fractal-midi/src/am4/cacheParams.ts';

const report = JSON.parse(readFileSync('samples/captured/local-caches-2026-06-09/accuracy-pass-report.json', 'utf8'));
const keys: string[] = [
  ...report.amp3a.rows.map((r: { key: string }) => r.key),
  ...report.cab3e.rows.map((r: { key: string }) => r.key),
  'reverb.low_decay',
  'rotary.low_time_constant',
  'rotary.high_time_constant',
  'compressor.attack',
];

function extract(file: string, key: string): string | undefined {
  const lines = readFileSync(file, 'utf8').split('\n');
  const startRe = new RegExp(`^  '${key.replace('.', '\\.')}':`);
  const idx = lines.findIndex((l) => startRe.test(l));
  if (idx < 0) return undefined;
  // preceding comment lines
  let from = idx;
  while (from > 0 && /^\s*(\/\/|\/\*|\*)/.test(lines[from - 1])) from--;
  // entry end: single-line if it closes on the same line, else scan to '  },'
  let to = idx;
  if (!/},\s*$/.test(lines[idx])) {
    while (to < lines.length - 1 && !/^  },\s*$/.test(lines[to])) to++;
  }
  return lines.slice(from, to + 1).map((l, i) => `${from + i + 1}\t${l}`).join('\n');
}

const out: string[] = [];
for (const key of keys) {
  out.push(`========== ${key} ==========`);
  const p = extract(PARAMS, key);
  out.push(p ? `--- params.ts ---\n${p}` : '--- params.ts: NOT FOUND ---');
  const c = extract(CACHE, key);
  if (c) out.push(`--- cacheParams.ts ---\n${c}`);
  out.push('');
}
writeFileSync('samples/captured/local-caches-2026-06-09/entry-extract.txt', out.join('\n'));
console.log(`extracted ${keys.length} keys -> samples/captured/local-caches-2026-06-09/entry-extract.txt`);
