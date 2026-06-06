/**
 * Mine the editor-WRITE traffic out of an emulator-session log (offline).
 *
 * The live sim sessions (`samples/captured/fm9-sim-m*.annotated.jsonl`) recorded
 * both directions over loopMIDI; this extracts the editor's fn=0x01 write frames
 * (insert / select / routing / store / drag / typed), deduped + decoded, in
 * chronological order so a routing/insert/drag sequence can be correlated to the
 * drawn grid. The per-frame decode lives in `decodeWrites.ts` (shared with the
 * controlled-capture runner).
 *
 * Usage:
 *   npx tsx scripts/_research/sim/mine-editor-writes.ts <annotated.jsonl> [--subs 35,32] [--seq]
 */
import { parseWriteFrames, WRITE_SUBS } from './decodeWrites.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: mine-editor-writes.ts <annotated.jsonl> [--subs 35,32] [--seq]');
  process.exit(1);
}
const subArg = (() => {
  const i = process.argv.indexOf('--subs');
  return i >= 0 ? new Set(process.argv[i + 1].split(',').map((s) => parseInt(s, 16))) : undefined;
})();
const seq = process.argv.includes('--seq');

async function main(): Promise<void> {
  const all = await parseWriteFrames(file);
  const rows = subArg ? all.filter((r) => subArg.has(r.sub)) : all;

  console.log(`\n# ${file}`);
  console.log(`# ${rows.length} editor-write frames matched\n`);

  const bySub = new Map<number, Map<string, { count: number; t: string; label: string }>>();
  for (const r of rows) {
    if (!bySub.has(r.sub)) bySub.set(r.sub, new Map());
    const m = bySub.get(r.sub)!;
    const prev = m.get(r.hex);
    if (prev) prev.count++;
    else m.set(r.hex, { count: 1, t: r.t, label: r.label });
  }

  for (const [sub, m] of [...bySub.entries()].sort((a, b) => a[0] - b[0])) {
    const total = [...m.values()].reduce((a, v) => a + v.count, 0);
    console.log(`## sub=0x${sub.toString(16)} (${WRITE_SUBS[sub]}) — ${m.size} unique / ${total} total`);
    for (const [hex, v] of [...m.entries()].sort((a, b) => Number(a[1].t) - Number(b[1].t))) {
      console.log(`  [t=${v.t} ×${v.count}] ${v.label}`);
      console.log(`    ${hex}`);
    }
    console.log();
  }

  if (seq) {
    console.log('## chronological sequence');
    for (const r of rows) console.log(`  t=${r.t} 0x${r.sub.toString(16)}(${r.subName}) ${r.label}`);
  }
}

main();
