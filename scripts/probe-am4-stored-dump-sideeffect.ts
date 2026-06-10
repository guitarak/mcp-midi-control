/**
 * AM4 stored-dump side-effect discriminator (read-only).
 *
 * The first probe saw the active-buffer dump change across stored-dump
 * requests. Two explanations:
 *   (a) RELOAD: the stored request replaced the working buffer (the
 *       II's behavior) — then active-after should match the LAST
 *       stored dump's content.
 *   (b) VOLATILE BYTES: the buffer is intact and the dump just carries
 *       a few non-deterministic bytes — then active dumps drift in a
 *       handful of offsets even with NO stored request in between.
 *
 * Sequence: active x2 back-to-back (baseline drift), stored Z04,
 * active again. Diff offsets printed for each pair.
 *
 * Run: npx tsx scripts/probe-am4-stored-dump-sideeffect.ts
 */
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { fractalChecksum } from 'fractal-midi/shared';
import { guardAgainstRunningEditors } from './_lib/editor-guard.js';

const AM4_MODEL_ID = 0x15;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function buildDumpReq(p0: number, p1: number, p2: number): number[] {
  const head = [0xf0, 0x00, 0x01, 0x74, AM4_MODEL_ID, 0x03, p0, p1, p2];
  return [...head, fractalChecksum(head), 0xf7];
}
function isDumpFrame(b: number[]): boolean {
  return b.length >= 6 && b[0] === 0xf0 && b[4] === AM4_MODEL_ID && (b[5] === 0x77 || b[5] === 0x78 || b[5] === 0x79);
}

async function main(): Promise<void> {
  guardAgainstRunningEditors();
  const conn = connect({ needles: ['am4', 'fractal'], notFoundLeadIn: 'AM4 not visible.' });

  const collect = (req: number[]): Promise<number[]> =>
    new Promise((resolve) => {
      const frames: number[][] = [];
      const unsub = conn.onMessage((bytes) => {
        if (!isDumpFrame(bytes)) return;
        frames.push([...bytes]);
        if (bytes[5] === 0x79) { unsub(); resolve(frames.flat()); }
      });
      setTimeout(() => { unsub(); resolve(frames.flat()); }, 3500);
      conn.send(req);
    });

  const diffOffsets = (x: number[], y: number[], cap = 12): string => {
    if (x.length !== y.length) return `LENGTH ${x.length} vs ${y.length}`;
    const offs: number[] = [];
    for (let i = 0; i < x.length && offs.length <= cap; i++) if (x[i] !== y[i]) offs.push(i);
    return offs.length === 0 ? 'IDENTICAL' : `${offs.length}${offs.length > cap ? '+' : ''} diff(s) at [${offs.slice(0, cap).join(', ')}]`;
  };

  const act1 = await collect(buildDumpReq(0x7f, 0x7f, 0x00));
  await sleep(250);
  const act2 = await collect(buildDumpReq(0x7f, 0x7f, 0x00));
  await sleep(250);
  const z04 = await collect(buildDumpReq(0x19, 0x03, 0x00));
  await sleep(250);
  const act3 = await collect(buildDumpReq(0x7f, 0x7f, 0x00));

  console.log(`baseline drift  (active1 vs active2, nothing in between): ${diffOffsets(act1, act2)}`);
  console.log(`post-stored     (active2 vs active3, Z04 dump between):   ${diffOffsets(act2, act3)}`);
  console.log(`reload check    (active3 vs stored Z04, body region):     ${diffOffsets(act3.slice(13), z04.slice(13))}`);
  conn.close();
}

main().catch((err) => { console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
