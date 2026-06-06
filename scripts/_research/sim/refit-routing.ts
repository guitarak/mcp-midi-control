/**
 * Offline refit of the gen-3 sub=0x35 routing endpoint encoding.
 *
 * No new captures. Loads the four GROUND-TRUTH-labeled controlled cables
 * (human-noted source + auto-shunt-confirmed dest) and the free-form sub=0x35
 * frames mined from the m2/m2c simulator sessions, decomposes bytes 21/22/23,
 * and tests a bit-field model. Prints exactly which coefficients the existing
 * data determines and which remain under-sampled.
 *
 * Run: npx tsx scripts/_research/sim/refit-routing.ts
 */
import { parseWriteFrames } from './decodeWrites.js';

// ── Ground-truth labeled cables ───────────────────────────────────────────
// src/dst as (row, col), 1-based. b21=byte21, b22=byte22 (endpoint), b23=byte23.
// dst confirmed by the auto-shunt the editor inserts on the empty dest cell
// immediately before the sub=0x35 (controlled-capture context).
interface Cable { name: string; sr: number; sc: number; dr: number; dc: number; b21: number; b22: number; b23: number; }
const LABELED: Cable[] = [
  { name: 'A', sr: 2, sc: 3, dr: 3, dc: 4, b21: 0x06, b22: 0x45, b23: 0x00 },
  { name: 'B', sr: 2, sc: 3, dr: 4, dc: 4, b21: 0x06, b22: 0x45, b23: 0x20 },
  { name: 'C', sr: 3, sc: 3, dr: 3, dc: 4, b21: 0x07, b22: 0x05, b23: 0x00 },
  { name: 'D', sr: 2, sc: 5, dr: 3, dc: 6, b21: 0x0c, b22: 0x48, b23: 0x00 },
];

const bits = (n: number, w = 8) => n.toString(2).padStart(w, '0');

console.log('=== labeled cables: byte decomposition ===');
console.log('cable src   dst   | b21  | b22=endpoint        | b23');
for (const c of LABELED) {
  const top2 = (c.b22 >> 6) & 0x3;        // hypothesised row field
  const low6 = c.b22 & 0x3f;              // hypothesised col field
  const b21Model = 3 * c.sc + c.sr - 5;   // source-cell fit
  const b23Idx = c.b23 >> 5;
  console.log(
    `  ${c.name}   r${c.sr}c${c.sc} r${c.dr}c${c.dc} | ` +
    `0x${c.b21.toString(16).padStart(2, '0')}(=3c+r-5? ${b21Model === c.b21 ? 'Y' : 'N ' + b21Model}) | ` +
    `${bits(c.b22)}  top2=${top2}(3-r=${3 - c.sr}) low6=${low6} | ` +
    `0x${c.b23.toString(16).padStart(2, '0')} idx=${b23Idx}(dr-3=${c.dr - 3})`,
  );
}

console.log('\nModel from labeled set:');
console.log('  byte21 = 3*srcCol + srcRow - 5         (exact on all 4; region rows2-3 cols3-5)');
console.log('  byte22 = ((3 - srcRow) << 6) | colLow  (top2 = 3-srcRow; low6 = f(srcCol) only)');
console.log('           colLow: col3->5, col5->8       (per-column increment UNDETERMINED: need col4)');
console.log('  byte23 = (dstRow - 3) << 5             (baseline row3; dst rows 1-2 UNSAMPLED)');

// ── Cross-check the model against the free-form m2/m2c frames ──────────────
// For each free-form sub=0x35, invert byte22 -> (row, colLow), then solve col
// from byte21 = 3*col + row - 5. If the labeled model generalised, col is a
// positive integer consistent across both bytes. Where it is not, the frame
// lives outside the fitted region (or the endpoint pairing differs).
async function crossCheck(logs: string[]): Promise<void> {
  const seen = new Set<string>();
  const rows: { b21: number; b22: number; b23: number; op: number }[] = [];
  for (const log of logs) {
    let writes;
    try { writes = await parseWriteFrames(log); } catch { continue; }
    for (const w of writes) {
      if (w.sub !== 0x35) continue;
      const key = `${w.fields.op}-${w.fields.rowMask}-${w.fields.endpoint}-${w.fields.destRow}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ b21: w.fields.rowMask as number, b22: w.fields.endpoint as number, b23: (w.fields.destRow as number) << 5, op: w.fields.op as number });
    }
  }
  console.log(`\n=== free-form frames vs model (${rows.length} unique) ===`);
  console.log('b21  b22   | row(3-top2) colLow | implied col=(b21-row+5)/3 | consistent?');
  for (const r of rows.sort((a, b) => a.b21 - b.b21 || a.b22 - b.b22)) {
    const row = 3 - ((r.b22 >> 6) & 0x3);
    const colLow = r.b22 & 0x3f;
    const colNum = (r.b21 - row + 5) / 3;
    const ok = Number.isInteger(colNum) && colNum >= 1;
    console.log(
      `  0x${r.b21.toString(16).padStart(2, '0')} 0x${r.b22.toString(16).padStart(2, '0')}  | ` +
      `row=${row} colLow=${colLow}`.padEnd(22) + ` | col=${ok ? colNum : colNum.toFixed(2)}`.padEnd(28) +
      ` | ${ok ? 'yes' : 'NO (outside region)'} ${r.op === 2 ? '[disconnect]' : ''}`,
    );
  }
}

// ── Sweep analysis: close δ / byte23-baseline / row-1 from a targeted capture ─
// The morning capture is a dest-row SWEEP at a fixed source: each cable is drawn
// onto an empty dest cell, so the editor auto-inserts a shunt THERE first (the
// sub=0x32 immediately preceding the sub=0x35). That shunt's (row,col) IS the
// dest cell. Pairing each routing frame with its preceding shunt gives dest
// geometry with zero guesswork; the source is the fixed cell the user drew from.
//
// Run after capture:  npx tsx scripts/_research/sim/refit-routing.ts <log.annotated.jsonl>
async function sweepAnalyze(logPath: string): Promise<void> {
  const writes = await parseWriteFrames(logPath);
  console.log(`\n=== sweep analysis: ${logPath} ===`);
  let pendingDest: { row: number; col: number } | undefined;
  const rows: { dr: number; dc: number; op: number; b21: number; b22: number; b23: number }[] = [];
  for (const w of writes) {
    if (w.sub === 0x32 && w.fields.kind === 'shunt') {
      pendingDest = { row: w.fields.row as number, col: w.fields.col as number };
    } else if (w.sub === 0x35) {
      const b21 = w.fields.rowMask as number;
      const b22 = w.fields.endpoint as number;
      const b23 = (w.fields.destRow as number) << 5;
      rows.push({ dr: pendingDest?.row ?? -1, dc: pendingDest?.col ?? -1, op: w.fields.op as number, b21, b22, b23 });
    }
  }
  console.log('dest(shunt)  op        b21   b22   b23  | b22: top2=(3-srcRow?) δ=LSB | b23>>5');
  for (const r of rows) {
    const top2 = (r.b22 >> 6) & 0x3;
    const delta = r.b22 & 0x1;
    const opName = r.op === 1 ? 'connect' : r.op === 2 ? 'disconn' : `op${r.op}`;
    console.log(
      `  r${r.dr}c${r.dc}`.padEnd(12) + ` ${opName.padEnd(8)} ` +
      `0x${r.b21.toString(16).padStart(2, '0')}  0x${r.b22.toString(16).padStart(2, '0')}  0x${r.b23.toString(16).padStart(2, '0')} | ` +
      `top2=${top2} δ=${delta}`.padEnd(28) + ` | ${r.b23 >> 5}`,
    );
  }
  // Residual-closing tables (connect frames only): byte23 vs dest row, δ vs dest.
  const connects = rows.filter((r) => r.op === 1 && r.dr > 0);
  console.log('\n-- byte23 baseline: dest row -> b23 (look for the (dstRow-3)<<5 vs a fixed base) --');
  const byRow = new Map<number, Set<string>>();
  for (const r of connects) {
    if (!byRow.has(r.dr)) byRow.set(r.dr, new Set());
    byRow.get(r.dr)!.add(`0x${r.b23.toString(16)}(idx${r.b23 >> 5})`);
  }
  for (const dr of [...byRow.keys()].sort((a, b) => a - b)) console.log(`   dest row ${dr}: ${[...byRow.get(dr)!].join(' ')}`);
  console.log('\n-- δ (byte22 LSB) vs dest row (does the LSB track dest?) --');
  const dByRow = new Map<number, Set<number>>();
  for (const r of connects) {
    if (!dByRow.has(r.dr)) dByRow.set(r.dr, new Set());
    dByRow.get(r.dr)!.add(r.b22 & 0x1);
  }
  for (const dr of [...dByRow.keys()].sort((a, b) => a - b)) console.log(`   dest row ${dr}: δ ∈ {${[...dByRow.get(dr)!].join(',')}}`);
  console.log('\nWith source FIXED across the sweep, b21 + b22-top2 are constant; b23 and δ');
  console.log('isolate against dest row. A row-1-source cable (sweep 2) tests b21/b22-top at srcRow=1.');
}

const argLog = process.argv[2];
if (argLog) {
  await sweepAnalyze(argLog);
} else {
  const LOGS = [
    'samples/captured/fm9-cc-routing-sweep.annotated.jsonl', // morning sweep (if present)
    'samples/captured/fm9-sim-m2c-2026-06-04.annotated.jsonl',
    'samples/captured/fm9-sim-m2-2026-06-04.annotated.jsonl',
  ];
  await crossCheck(LOGS);
}
