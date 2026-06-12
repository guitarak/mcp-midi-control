/**
 * Analyze the FM9 "amp balance 0 → -100" controlled edit capture
 * (Ralf, 2026-06-04; FW 11.00 / FM9-Edit 1.03.19; Preset 433, Scene S03).
 *
 * Hypothesis (from the contributor email): the only musical edit in the
 * session is the Amp block's Balance dragged from 0 to -100 in the editor.
 * The FM9 amp block is the DISTORT family; its Balance control is
 * DISTORT_PAN, paramId 2 in the device-true FM9 catalog.
 *
 * What we expect on the wire, and what this script verifies:
 *   A. OUT fn=0x01 sub=0x52 (mouse-drag SET) frames carrying the dragged
 *      paramId and a 5-septet float32 NORMALIZED value. For a -100..+100
 *      Balance, center 0 = 0.5 and full-left -100 = 0.0, so the drag should
 *      sweep 0.5 → 0.0 on ONE paramId.
 *   B. IN 60-byte SET value-echo frames mirroring A (effectId, paramId,
 *      device-quantized normalized value).
 *   C. The 0x74/0x75.../0x76 positional state-broadcast bursts: assemble
 *      each, diff consecutive bursts for the SAME blockId, and report which
 *      paramId record changed and by how much. The changed record's paramId
 *      must agree with A/B.
 *
 * All decoding reuses the SHIPPED gen-3 codec (no re-implementation of the
 * septet/float math) so this analysis validates the same path get_param /
 * set_param run on hardware.
 *
 * Run: npx tsx scripts/_research/analyze-fm9-balance-edit.ts <frames.json>
 */
import { readFileSync, existsSync } from 'node:fs';
import {
  parseGen3SetValueEcho,
  parseGen3StateBroadcastHead,
  parseGen3StateBroadcastBody,
  isGen3BroadcastFrame,
} from 'fractal-midi/gen3/axe-fx-iii';

const FM9_MODEL = 0x12;
const DISTORT_PAN_PARAMID = 2; // amp "Balance" in the device-true FM9 catalog

interface Frame { dir: 'IN' | 'OUT'; t: string; fn: number; sub: number; len: number; hex: string; }
const PATH = process.argv[2];
if (!PATH || !existsSync(PATH)) { console.error('usage: <frames.json>'); process.exit(1); }
const frames = JSON.parse(readFileSync(PATH, 'utf8')) as Frame[];
const bytes = (f: Frame): number[] => f.hex.split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16));

// display Balance from a -100..+100 normalized [0,1] value
const balOf = (norm: number): number => norm * 200 - 100;
const f3 = (n: number): string => n.toFixed(4);

console.log(`Frames: ${frames.length}  (file ${PATH})\n`);

// ── A. OUT mouse-drag SETs (sub=0x52) ────────────────────────────────────────
const dragSets = frames.filter((f) => f.dir === 'OUT' && f.fn === 0x01 && f.sub === 0x52);
console.log(`═══ A. OUT mouse-drag SET frames (fn=0x01 sub=0x52) — ${dragSets.length} ═══`);
const dragByPid = new Map<number, number>();
for (const f of dragSets) {
  const b = bytes(f);
  const e = parseGen3SetValueEcho(b);
  dragByPid.set(e.paramId, (dragByPid.get(e.paramId) ?? 0) + 1);
  console.log(
    `+${f.t}s eff=${e.effectId} pid=${e.paramId} norm=${f3(e.normalizedValue)} `
    + `→ balance≈${balOf(e.normalizedValue).toFixed(1)}   ${f.hex}`,
  );
}
console.log(`  paramId histogram: ${[...dragByPid.entries()].map(([p, n]) => `pid${p}×${n}`).join('  ')}`);

// ── B. IN 60-byte SET value-echo frames ──────────────────────────────────────
const echoes = frames.filter((f) => f.dir === 'IN' && f.fn === 0x01 && f.len === 60);
console.log(`\n═══ B. IN 60-byte SET value-echo frames — ${echoes.length} (showing pid=${DISTORT_PAN_PARAMID} only) ═══`);
const echoByPid = new Map<number, number>();
let shown = 0;
for (const f of echoes) {
  const e = parseGen3SetValueEcho(bytes(f));
  echoByPid.set(e.paramId, (echoByPid.get(e.paramId) ?? 0) + 1);
  if (e.paramId === DISTORT_PAN_PARAMID && shown < 20) {
    console.log(`+${f.t}s eff=${e.effectId} pid=${e.paramId} norm=${f3(e.normalizedValue)} → balance≈${balOf(e.normalizedValue).toFixed(1)}`);
    shown++;
  }
}
console.log(`  echo paramId histogram: ${[...echoByPid.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `pid${p}×${n}`).join('  ')}`);

// ── C. Positional state-broadcast diff ───────────────────────────────────────
// Assemble bursts: a 0x74 head opens, 0x75 bodies append, 0x76 closes.
interface Burst { blockId: number; itemCount: number; values: number[]; t: string; }
const bursts: Burst[] = [];
let cur: Burst | null = null;
for (const f of frames) {
  const b = bytes(f);
  if (isGen3BroadcastFrame(b, 0x74, FM9_MODEL)) {
    const h = parseGen3StateBroadcastHead(b);
    cur = { blockId: h.blockId, itemCount: h.itemCount, values: [], t: f.t };
  } else if (cur && isGen3BroadcastFrame(b, 0x75, FM9_MODEL)) {
    for (const v of parseGen3StateBroadcastBody(b).values) cur.values.push(v);
  } else if (cur && isGen3BroadcastFrame(b, 0x76, FM9_MODEL)) {
    bursts.push(cur);
    cur = null;
  }
}
console.log(`\n═══ C. State-broadcast bursts — ${bursts.length} ═══`);
for (const bu of bursts) {
  console.log(`+${bu.t}s blockId=${bu.blockId} itemCount=${bu.itemCount} valuesDecoded=${bu.values.length} pid2(wire)=${bu.values[DISTORT_PAN_PARAMID]}`);
}

// Diff consecutive bursts that share a blockId.
console.log(`\n─── consecutive-burst diffs (same blockId) ───`);
for (let i = 1; i < bursts.length; i++) {
  const a = bursts[i - 1], c = bursts[i];
  if (a.blockId !== c.blockId) continue;
  const n = Math.min(a.values.length, c.values.length);
  const changed: string[] = [];
  for (let p = 0; p < n; p++) {
    if (a.values[p] !== c.values[p]) {
      const an = a.values[p] / 65534, cn = c.values[p] / 65534;
      changed.push(`pid${p}: ${a.values[p]}→${c.values[p]} (wire16) ≈ bal ${balOf(an).toFixed(1)}→${balOf(cn).toFixed(1)}`);
    }
  }
  console.log(`[${a.t}s → ${c.t}s] blockId=${a.blockId} changed ${changed.length}: ${changed.slice(0, 8).join(' | ') || '(none)'}`);
}

// ── Verdict summary ──────────────────────────────────────────────────────────
const dragPids = [...dragByPid.keys()];
const soleDragPid = dragPids.length === 1 ? dragPids[0] : undefined;
console.log(`\n═══ VERDICT ═══`);
console.log(`  mouse-drag SET paramId(s): ${dragPids.join(',') || '(none)'}${soleDragPid === DISTORT_PAN_PARAMID ? '  ✓ == DISTORT_PAN(2)' : ''}`);
const firstDrag = dragSets.length ? parseGen3SetValueEcho(bytes(dragSets[0])) : undefined;
const lastDrag = dragSets.length ? parseGen3SetValueEcho(bytes(dragSets[dragSets.length - 1])) : undefined;
if (firstDrag && lastDrag) {
  console.log(`  drag value sweep: norm ${f3(firstDrag.normalizedValue)}→${f3(lastDrag.normalizedValue)} ≈ balance ${balOf(firstDrag.normalizedValue).toFixed(1)}→${balOf(lastDrag.normalizedValue).toFixed(1)}`);
}
