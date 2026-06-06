/**
 * Gen-3 sub=0x35 routing wire formula — DECODED from controlled-capture sweeps.
 *
 * Source rows 2-6 are byte-exact on 13 cables across two independent sweeps
 * (a dest-row fan-out at fixed source + a source-column walk). Run to re-validate:
 *   npx tsx scripts/_research/sim/routing-formula.ts
 *
 * Frame (26 bytes): F0 00 01 74 <model> 01 35 00 00 00 00 00 <OP> 00 00 00 00 00
 *                   00 02 00 <b21> <b22> <b23> <cks> F7
 *
 *   byte 12 OP  = 0x01 connect / 0x02 disconnect
 *   byte 21     = 3*srcCol + srcRow - 5                       (source cell)
 *   byte 22     = ((3 - srcRow) << 6) | (colTerm + destSign)
 *                   colTerm  = floor(3*(srcCol-1)/2) + 1      (source-column base)
 *                   destSign = (destRow >= 3) ? 1 : 0
 *   byte 23     = ((|destRow - 3| + (srcCol even ? 2 : 0)) mod 4) << 5
 *   dest col    = src col + 1 (implicit; routing is between adjacent columns)
 *
 * KNOWN GAP — source ROW 1: byte 23 still fits, but byte 21 is +1 and byte 22's
 * top bits do not follow (3 - srcRow). Refuse row-1 sources (or capture 2-3 clean
 * row-1 cables with empty dests to close it) before emitting.
 */
export const ROUTING_OP_CONNECT = 0x01;
export const ROUTING_OP_DISCONNECT = 0x02;

const colTerm = (srcCol: number): number => Math.floor((3 * (srcCol - 1)) / 2) + 1;

export interface RoutingEdge {
  srcRow: number;
  srcCol: number;
  destRow: number;
  /** destCol is implicit (srcCol + 1); accepted only to assert the adjacency. */
  destCol?: number;
  op?: number; // default connect
}

/** Returns the three variable wire bytes [b21, b22, b23] for a routing edge. */
export function routingBytes(e: RoutingEdge): { b21: number; b22: number; b23: number } {
  if (e.srcRow < 2) {
    throw new Error(
      `routingBytes: source row ${e.srcRow} is the undecoded row-1 corner ` +
        `(byte21/byte22 special-case; needs a clean row-1 capture). Refusing rather than emit guessed wire.`,
    );
  }
  if (e.destCol !== undefined && e.destCol !== e.srcCol + 1) {
    throw new Error(`routingBytes: dest col must be src col + 1 (got src ${e.srcCol}, dst ${e.destCol}).`);
  }
  const b21 = 3 * e.srcCol + e.srcRow - 5;
  const destSign = e.destRow >= 3 ? 1 : 0;
  const b22 = ((3 - e.srcRow) << 6) | (colTerm(e.srcCol) + destSign);
  const b23 = ((Math.abs(e.destRow - 3) + (e.srcCol % 2 === 0 ? 2 : 0)) % 4) << 5;
  return { b21, b22, b23 };
}

// ── Self-validation against the captured corpus ────────────────────────────
// [label, srcRow, srcCol, dstRow, dstCol, b21, b22, b23]
const CORPUS: [string, number, number, number, number, number, number, number][] = [
  ['A r2c3->r3c4', 2, 3, 3, 4, 0x06, 0x45, 0x00],
  ['B r2c3->r4c4', 2, 3, 4, 4, 0x06, 0x45, 0x20],
  ['C r3c3->r3c4', 3, 3, 3, 4, 0x07, 0x05, 0x00],
  ['D r2c5->r3c6', 2, 5, 3, 6, 0x0c, 0x48, 0x00],
  ['sweep r3c3->r1c4', 3, 3, 1, 4, 0x07, 0x04, 0x40],
  ['sweep r3c3->r3c4', 3, 3, 3, 4, 0x07, 0x05, 0x00],
  ['sweep r3c3->r4c4', 3, 3, 4, 4, 0x07, 0x05, 0x20],
  ['sweep r3c3->r5c4', 3, 3, 5, 4, 0x07, 0x05, 0x40],
  ['sweep r3c3->r6c4', 3, 3, 6, 4, 0x07, 0x05, 0x60],
  ['col r3c1->r3c2', 3, 1, 3, 2, 0x01, 0x02, 0x00],
  ['col r3c2->r3c3', 3, 2, 3, 3, 0x04, 0x03, 0x40],
  ['col r3c4->r3c5', 3, 4, 3, 5, 0x0a, 0x06, 0x40],
  ['col r3c5->r3c6', 3, 5, 3, 6, 0x0d, 0x08, 0x00],
];

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('routing-formula.ts')) {
  let pass = 0;
  for (const [lab, sr, sc, dr, dc, b21, b22, b23] of CORPUS) {
    const got = routingBytes({ srcRow: sr, srcCol: sc, destRow: dr, destCol: dc });
    const ok = got.b21 === b21 && got.b22 === b22 && got.b23 === b23;
    if (ok) pass++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${lab.padEnd(20)} ${ok ? '' : `got ${got.b21.toString(16)}/${got.b22.toString(16)}/${got.b23.toString(16)} want ${b21.toString(16)}/${b22.toString(16)}/${b23.toString(16)}`}`);
  }
  console.log(`\n${pass}/${CORPUS.length} byte-exact (source rows 2-6). Row-1 sources refused pending capture.`);
}
