/**
 * fn 0x28 SYSEX_GET_PARAM_STRINGS live dump for the 4 opaque amp enums
 * the calibration sweep could not enumerate (cliptype2, drivetype,
 * fbtype, version). The device emits each param's enum-value display
 * labels as a NULL-delimited 7-bit ASCII array. READ ONLY.
 *
 * Request: F0 00 01 74 07 28 [effLo effHi] [pidLo pidHi] cksum F7
 * Response: one or more fn 0x28 frames; concatenate payloads, split on
 * NUL. (Per Session 104 the array can fill a 2048-byte frame and may
 * chunk across frames.)
 *
 * Run: npx tsx scripts/_research/probe-ii-amp-enum-dump.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';

const AMP_EFFECT_ID = parseInt(process.env.AMP_EFFECT_ID ?? '106', 10);
const II_MODEL = 0x07;

const TARGETS: Array<{ paramId: number; name: string }> = [
  { paramId: 18, name: 'cliptype2' },
  { paramId: 30, name: 'drivetype' },
  { paramId: 37, name: 'fbtype' },
  { paramId: 82, name: 'version' },
];

type Conn = ReturnType<typeof connectAxeFxII>;
function csum(b: number[]): number { let a = 0; for (const x of b) a ^= x; return a & 0x7f; }
function enc14(v: number): [number, number] { return [v & 0x7f, (v >> 7) & 0x7f]; }
function buildGetParamStrings(effectId: number, paramId: number): number[] {
  const head = [0xf0, 0x00, 0x01, 0x74, II_MODEL, 0x28, ...enc14(effectId), ...enc14(paramId)];
  return [...head, csum(head), 0xf7];
}

function isFn28(bytes: number[]): boolean {
  return bytes.length >= 7 && bytes[0] === 0xf0 && bytes[3] === 0x74
    && bytes[4] === II_MODEL && bytes[5] === 0x28;
}

function dump(conn: Conn, effectId: number, paramId: number, ms: number): Promise<string[]> {
  return new Promise((resolve) => {
    const payload: number[] = [];
    let frames = 0;
    const unsub = conn.onMessage((bytes) => {
      if (!isFn28(bytes)) return;
      frames++;
      const terminated = bytes[bytes.length - 1] === 0xf7;
      const end = terminated ? bytes.length - 2 : bytes.length;
      for (let i = 6; i < end; i++) payload.push(bytes[i]);
    });
    conn.send(buildGetParamStrings(effectId, paramId));
    setTimeout(() => {
      unsub();
      const strings: string[] = [];
      let cur: number[] = [];
      for (const b of payload) {
        if (b === 0x00) { strings.push(String.fromCharCode(...cur)); cur = []; }
        else cur.push(b);
      }
      if (cur.length) strings.push(String.fromCharCode(...cur) + '⟨partial⟩');
      void frames;
      resolve(strings);
    }, ms);
  });
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();
  await new Promise((r) => setTimeout(r, 150));
  const out: Record<string, Record<number, string>> = {};
  for (const t of TARGETS) {
    const strings = await dump(conn, AMP_EFFECT_ID, t.paramId, 2500);
    console.log(`\n=== ${t.name} (paramId ${t.paramId}) — ${strings.length} labels ===`);
    const table: Record<number, string> = {};
    strings.forEach((s, i) => { table[i] = s; console.log(`  ${i}: ${JSON.stringify(s)}`); });
    out[t.name] = table;
  }
  const outDir = path.resolve(process.cwd(), 'samples', 'captured', 'decoded');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'ii-amp-enum-dump.json');
  writeFileSync(outPath, JSON.stringify({ effectId: AMP_EFFECT_ID, enums: out }, null, 2));
  console.log(`\nWrote → ${outPath}`);
  setTimeout(() => process.exit(0), 200);
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : String(e)); process.exit(1); });
