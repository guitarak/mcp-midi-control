/**
 * Decode the editor-WRITE frames out of an emulator-session `.annotated.jsonl`.
 *
 * Shared by the offline miner (`mine-editor-writes.ts`) and the controlled-
 * capture runner (`controlled-capture.ts`). The session log records both
 * directions:
 *   - editor -> simulator : records with NO `dir` field (the inbound branch).
 *   - simulator -> editor : records with `dir:"OUT"`.
 * Only the inbound fn=0x01 write sub-actions are decoded here.
 */
import fs from 'node:fs';
import readline from 'node:readline';

export const WRITE_SUBS: Readonly<Record<number, string>> = Object.freeze({
  0x30: 'select',
  0x32: 'insert',
  0x35: 'routing',
  0x26: 'store',
  0x52: 'drag',
  0x09: 'typed',
});

export const toBytes = (hex: string): number[] => hex.trim().split(/\s+/).map((b) => parseInt(b, 16));
export const dec14 = (lo: number, hi: number): number => (lo & 0x7f) | ((hi & 0x7f) << 7);
export const toHex = (a: readonly number[]): string => a.map((x) => x.toString(16).padStart(2, '0')).join(' ');

export interface WriteFrame {
  t: string;
  sub: number;
  subName: string;
  bytes: number[];
  hex: string;
  /** Structured per-sub fields (gridPos/effectId/op/endpoint/...). */
  fields: Record<string, number | string>;
  /** One-line human reading. */
  label: string;
}

export interface AnyFrame {
  dir: 'IN' | 'OUT';
  t: string;
  fn: number;
  sub: number;
  bytes: number[];
}

/** Decode one fn=0x01 write frame into structured fields + a label. */
export function decodeWrite(b: number[]): { fields: Record<string, number | string>; label: string } {
  const sub = b[6];
  switch (sub) {
    case 0x32: {
      const isShunt = (b[9] & 0x7f) === 0x08;
      const gridPos = dec14(b[12], b[13]);
      const col = Math.floor(gridPos / 6) + 1;
      const row = (gridPos % 6) + 1;
      if (isShunt) {
        return { fields: { kind: 'shunt', instance: b[8] & 0x7f, gridPos, row, col }, label: `shunt#${b[8] & 0x7f} @gridPos ${gridPos} (r${row}c${col})` };
      }
      const effectId = dec14(b[8], b[9]);
      return { fields: { kind: 'effect', effectId, gridPos, row, col }, label: `effectId ${effectId} @gridPos ${gridPos} (r${row}c${col})` };
    }
    case 0x30: {
      const gridPos = dec14(b[12], b[13]);
      return { fields: { gridPos, row: (gridPos % 6) + 1, col: Math.floor(gridPos / 6) + 1 }, label: `gridPos ${gridPos} (r${(gridPos % 6) + 1}c${Math.floor(gridPos / 6) + 1})` };
    }
    case 0x26: {
      const presetNum = dec14(b[12], b[13]);
      return { fields: { presetNum }, label: `presetNum ${presetNum}` };
    }
    case 0x35: {
      const op = b[12] & 0x7f;
      const rowMask = b[21] & 0x7f;
      const endpoint = b[22] & 0x7f;
      const destRow = (b[23] & 0x7f) >> 5;
      return {
        fields: { op, rowMask, endpoint, destRow },
        label: `op=0x${op.toString(16)} rowMask=0x${rowMask.toString(16)} endpoint=0x${endpoint.toString(16)} destRow=${destRow}`,
      };
    }
    case 0x52: {
      const effectId = dec14(b[8], b[9]);
      const paramId = dec14(b[10], b[11]);
      // 5-septet float32 at bytes 12..16, normalized to [0,1].
      const raw = (b[12] & 0x7f) | ((b[13] & 0x7f) << 7) | ((b[14] & 0x7f) << 14) | ((b[15] & 0x7f) << 21) | ((b[16] & 0x7f) << 28);
      const f = new Float32Array(new Uint32Array([raw >>> 0]).buffer)[0];
      return { fields: { effectId, paramId, value: Number.isFinite(f) ? Number(f.toFixed(4)) : 0 }, label: `eff ${effectId} param ${paramId} value ${Number.isFinite(f) ? f.toFixed(4) : '?'}` };
    }
    case 0x09: {
      const effectId = dec14(b[8], b[9]);
      const paramId = dec14(b[10], b[11]);
      const value = (b[15] & 0x7f) | ((b[16] & 0x7f) << 7) | ((b[17] & 0x03) << 14);
      return { fields: { effectId, paramId, value }, label: `eff ${effectId} param ${paramId} value ${value}` };
    }
    default:
      return { fields: {}, label: '' };
  }
}

/** Stream a jsonl and return every editor-write frame, in chronological order. */
export async function parseWriteFrames(jsonlPath: string): Promise<WriteFrame[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(jsonlPath), crlfDelay: Infinity });
  const out: WriteFrame[] = [];
  for await (const line of rl) {
    if (!line) continue;
    let rec: { dir?: string; fn?: string; hex?: string; t?: string };
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.dir === 'OUT' || rec.fn !== '0x1' || !rec.hex) continue;
    const bytes = toBytes(rec.hex);
    const sub = bytes[6];
    if (!(sub in WRITE_SUBS)) continue;
    const { fields, label } = decodeWrite(bytes);
    out.push({ t: rec.t ?? '', sub, subName: WRITE_SUBS[sub], bytes, hex: rec.hex, fields, label });
  }
  return out;
}

/** Stream a jsonl and return every fn=0x01 frame with a given sub, either direction. */
export async function parseFramesBySub(jsonlPath: string, sub: number): Promise<AnyFrame[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(jsonlPath), crlfDelay: Infinity });
  const out: AnyFrame[] = [];
  for await (const line of rl) {
    if (!line) continue;
    let rec: { dir?: string; fn?: string; hex?: string; t?: string };
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.fn !== '0x1' || !rec.hex) continue;
    const bytes = toBytes(rec.hex);
    if (bytes[6] !== sub) continue;
    out.push({ dir: rec.dir === 'OUT' ? 'OUT' : 'IN', t: rec.t ?? '', fn: bytes[5], sub, bytes });
  }
  return out;
}
