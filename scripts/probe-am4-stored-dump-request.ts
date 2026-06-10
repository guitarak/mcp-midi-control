/**
 * AM4 stored-location dump-request probe (read-only, zero writes).
 *
 * Disambiguates the fn=0x03 stored-preset request encoding that has
 * blocked `export_preset(location)` on the AM4 (see
 * fractal-midi/docs/devices/am4/preset-dump-request-research.md):
 *
 *   H1: payload = [bank, sub, 0x00]           (A02 -> 00 01 00)
 *   H2: payload = [bank, active_flag, sub]    (A02 -> 00 00 01)
 *
 * Sequence (every request is a READ; nothing is written):
 *   1. Active-buffer dump (sentinel 7F 7F 00) -> baseline A1.
 *   2. H1 request for A01 (00 00 00): expect 6-frame stream whose 0x77
 *      header echoes bank=0, sub=0.
 *   3. H1 request for A02 (00 01 00): header should echo sub=1 and the
 *      dump should differ from A01's. If silent, try H2 (00 00 01).
 *   4. H1 request for Z04 (19 03 00): full-range check.
 *   5. Active-buffer dump again -> A2. A1 == A2 proves the stored
 *      requests have NO working-buffer side effect (unlike the II's
 *      slot-addressed fn 0x03, which reloads the buffer).
 *
 * Dumps land in samples/captured/hw132/ for the SYSEX-MAP citation.
 *
 * Run: npx tsx scripts/probe-am4-stored-dump-request.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { fractalChecksum } from 'fractal-midi/shared';
import { guardAgainstRunningEditors } from './_lib/editor-guard.js';

const AM4_MODEL_ID = 0x15;
const FN_DUMP = 0x03;
const FN_HEADER = 0x77;
const FN_CHUNK = 0x78;
const FN_FOOTER = 0x79;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hex = (b: number[]) => b.map((v) => v.toString(16).padStart(2, '0')).join(' ');

function buildDumpReq(p0: number, p1: number, p2: number): number[] {
  const head = [0xf0, 0x00, 0x01, 0x74, AM4_MODEL_ID, FN_DUMP, p0, p1, p2];
  return [...head, fractalChecksum(head), 0xf7];
}

function isDumpFrame(b: number[]): boolean {
  return b.length >= 6 && b[0] === 0xf0 && b[4] === AM4_MODEL_ID
    && (b[5] === FN_HEADER || b[5] === FN_CHUNK || b[5] === FN_FOOTER);
}

async function main(): Promise<void> {
  guardAgainstRunningEditors();
  const conn = connect({ needles: ['am4', 'fractal'], notFoundLeadIn: 'AM4 not visible.' });
  const outDir = path.join('samples', 'captured', 'hw132');
  mkdirSync(outDir, { recursive: true });
  const findings: string[] = [];

  const collectDump = (req: number[], label: string): Promise<number[][]> =>
    new Promise((resolve) => {
      const frames: number[][] = [];
      const unsub = conn.onMessage((bytes) => {
        if (!isDumpFrame(bytes)) return;
        frames.push([...bytes]);
        if (bytes[5] === FN_FOOTER) { unsub(); resolve(frames); }
      });
      setTimeout(() => { unsub(); resolve(frames); }, 3500);
      conn.send(req);
      void label;
    });

  const flat = (fs: number[][]) => fs.flat();
  const eq = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  const describe = (fs: number[][]) =>
    fs.length === 0 ? 'NO RESPONSE' : `${fs.length} frames / ${flat(fs).length} bytes, header [${hex(fs[0].slice(6, 11))}]`;

  // 1. Baseline active-buffer dump (shipped, verified path).
  const a1 = await collectDump(buildDumpReq(0x7f, 0x7f, 0x00), 'active-1');
  console.log(`active buffer dump #1: ${describe(a1)}`);
  await sleep(200);

  // 2. H1 for A01.
  const a01 = await collectDump(buildDumpReq(0x00, 0x00, 0x00), 'A01');
  console.log(`H1 A01 (00 00 00):     ${describe(a01)}`);
  await sleep(200);

  // 3. Sub-index disambiguation: A02.
  let a02 = await collectDump(buildDumpReq(0x00, 0x01, 0x00), 'A02-H1');
  let a02Shape = 'H1';
  console.log(`H1 A02 (00 01 00):     ${describe(a02)}`);
  if (a02.length === 0) {
    await sleep(200);
    a02 = await collectDump(buildDumpReq(0x00, 0x00, 0x01), 'A02-H2');
    a02Shape = 'H2';
    console.log(`H2 A02 (00 00 01):     ${describe(a02)}`);
  }
  await sleep(200);

  // 4. Z04 range check (H1 encoding).
  const z04 = await collectDump(buildDumpReq(0x19, 0x03, 0x00), 'Z04');
  console.log(`H1 Z04 (19 03 00):     ${describe(z04)}`);
  await sleep(200);

  // 5. Side-effect check: active dump again.
  const a2 = await collectDump(buildDumpReq(0x7f, 0x7f, 0x00), 'active-2');
  console.log(`active buffer dump #2: ${describe(a2)}`);

  // Classify.
  if (a01.length > 0) {
    const hdr = a01[0].slice(6, 8);
    findings.push(`STORED REQUEST WORKS: A01 returned ${a01.length} frames; 0x77 header bank/sub = [${hex(hdr)}] (expect 00 00).`);
    if (a02.length > 0) {
      findings.push(`SUB ENCODING: A02 answered the ${a02Shape} shape (header bank/sub [${hex(a02[0].slice(6, 8))}]); A01 vs A02 dumps ${eq(flat(a01), flat(a02)) ? 'IDENTICAL (suspicious!)' : 'differ as expected'}.`);
    } else {
      findings.push('SUB ENCODING: A02 request got NO response under either H1 or H2.');
    }
    if (z04.length > 0) {
      findings.push(`RANGE: Z04 (bank 25, sub 3) returned ${z04.length} frames; header bank/sub [${hex(z04[0].slice(6, 8))}] (expect 19 03).`);
    } else {
      findings.push('RANGE: Z04 request got NO response (location may be empty — try a populated high slot).');
    }
  } else {
    findings.push('STORED REQUEST: A01 (H1 shape) got NO response. H3 (different fn / shape for stored exports) back on the table; a real AM4-Edit capture is still needed.');
  }
  findings.push(eq(flat(a1), flat(a2))
    ? 'SIDE EFFECT: NONE — active-buffer dump identical before/after the stored requests (no buffer reload on AM4, unlike the II).'
    : 'SIDE EFFECT: active-buffer dump CHANGED across the stored requests — the stored request appears to touch the working buffer. Investigate before shipping.');

  if (a1.length) writeFileSync(path.join(outDir, 'am4-active-1.syx'), Buffer.from(flat(a1)));
  if (a01.length) writeFileSync(path.join(outDir, 'am4-stored-a01.syx'), Buffer.from(flat(a01)));
  if (a02.length) writeFileSync(path.join(outDir, `am4-stored-a02-${a02Shape.toLowerCase()}.syx`), Buffer.from(flat(a02)));
  if (z04.length) writeFileSync(path.join(outDir, 'am4-stored-z04.syx'), Buffer.from(flat(z04)));
  console.log(`dumps saved to ${outDir}/`);

  console.log('\n── FINDINGS ──');
  for (const f of findings) console.log(`  • ${f}`);
  conn.close();
}

main().catch((err) => {
  console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
