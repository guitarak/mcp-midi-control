/**
 * wf-ii-editor-minimal-path-frames.ts  (READ-ONLY analysis)
 *
 * Walks each session-58 Axe-Fx II capture frame-by-frame (F0..F7),
 * tallies model+fn occurrences, and prints the ordered fn-byte
 * sequence so we can reconstruct the editor's minimal read flow + the
 * per-edit state-broadcast triple.
 *
 * The .syx captures are MIDI-OX style both-direction dumps with NO
 * per-frame direction tag, so we INFER direction from fn semantics:
 *   - request-only opcodes (0x08, 0x47, 0x20, 0x0E, 0x18, 0x15, 0x12,
 *     0x1F, 0x0F, 0x29, 0x11, 0x3C) that carry a SHORT payload are
 *     host->device requests; long-payload frames of the same fn are
 *     device->host responses.
 *   - 0x74/0x75/0x76 triples are device->host broadcasts unless they
 *     are part of a host write (we flag both; for session-58 these are
 *     device-emitted edit broadcasts).
 * Direction inference is a heuristic; the fn-SEQUENCE + payload length
 * is the load-bearing output (does NOT need hardware to be correct).
 */
import { readFileSync } from 'node:fs';
import { AXE_FX_II_OPCODES } from 'fractal-midi/gen2/axe-fx-ii';

const NAME_BY_WIRE = new Map<number, string>();
for (const [k, v] of Object.entries(AXE_FX_II_OPCODES)) NAME_BY_WIRE.set(v as number, k);
// Legacy wiki fn-bytes not in the AxeEdit opcode table (which is editor-internal):
const LEGACY: Record<number, string> = {
  0x11: 'BLOCK_XY (wiki)',
  0x2a: 'PRESET_EDITED_STATUS (wiki)',
  0x3c: 'SET_PRESET_NUMBER (wiki)',
  0x64: 'MULTIPURPOSE_RESPONSE (wiki)',
};
function fnName(fn: number): string {
  return NAME_BY_WIRE.get(fn) ?? LEGACY[fn] ?? `?0x${fn.toString(16)}`;
}

interface Frame {
  model: number;
  fn: number;
  payloadLen: number; // bytes between fn and checksum (exclusive)
  total: number;
  firstPayload: number[]; // up to first 6 payload bytes
}

function walk(buf: Buffer): Frame[] {
  const frames: Frame[] = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xf0) { i++; continue; }
    const start = i;
    let j = i + 1;
    while (j < buf.length && buf[j] !== 0xf7) j++;
    if (j >= buf.length) break;
    const len = j - start + 1;
    if (len >= 7 && buf[start + 1] === 0x00 && buf[start + 2] === 0x01 && buf[start + 3] === 0x74) {
      const model = buf[start + 4];
      const fn = buf[start + 5];
      // payload = bytes [start+6 .. j-2]  (j-1 is checksum, j is F7)
      const payloadLen = Math.max(0, (j - 1) - (start + 6));
      const firstPayload: number[] = [];
      for (let p = start + 6; p < Math.min(start + 6 + 6, j - 1); p++) firstPayload.push(buf[p]);
      frames.push({ model, fn, payloadLen, total: len, firstPayload });
    }
    i = j + 1;
  }
  return frames;
}

// A request frame is "short" (no big body); a response carries the body.
function classifyDir(f: Frame): 'host→dev (req)' | 'dev→host (resp/bcast)' {
  // 0x74/0x75/0x76 triples in session-58 are device-emitted edit broadcasts.
  if (f.fn === 0x74 || f.fn === 0x75 || f.fn === 0x76) return 'dev→host (resp/bcast)';
  // Bare query opcodes with no/short payload are requests.
  if (f.payloadLen <= 8) return 'host→dev (req)';
  return 'dev→host (resp/bcast)';
}

const files = process.argv.slice(2);
for (const file of files) {
  const buf = readFileSync(file);
  const frames = walk(buf);
  console.log(`\n================ ${file} ================`);
  console.log(`total Fractal frames: ${frames.length}`);

  // Tally model+fn, split by inferred direction.
  const tally = new Map<string, number>();
  for (const f of frames) {
    const dir = classifyDir(f);
    const key = `${dir}  model=0x${f.model.toString(16).padStart(2, '0')}  fn=0x${f.fn.toString(16).padStart(2, '0')} ${fnName(f.fn)}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  console.log('--- model+fn tally (inferred direction) ---');
  for (const [k, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)} x  ${k}`);
  }

  // Ordered host->dev request sequence (dedupe consecutive repeats with a count).
  console.log('--- host→dev request opcode sequence (run-length) ---');
  const reqs = frames.filter((f) => classifyDir(f) === 'host→dev (req)');
  let prev = '';
  let run = 0;
  const out: string[] = [];
  const flush = () => { if (run > 0) out.push(run > 1 ? `${prev} ×${run}` : prev); };
  for (const f of reqs) {
    const tag = `0x${f.fn.toString(16).padStart(2, '0')} ${fnName(f.fn)}`;
    if (tag === prev) { run++; } else { flush(); prev = tag; run = 1; }
  }
  flush();
  console.log('  ' + out.join('  →  '));

  // First few frames verbatim (head of the conversation).
  console.log('--- first 14 frames (verbatim head) ---');
  frames.slice(0, 14).forEach((f, idx) => {
    console.log(
      `  [${idx}] ${classifyDir(f)}  fn=0x${f.fn.toString(16).padStart(2, '0')} ${fnName(f.fn).padEnd(26)} payloadLen=${String(f.payloadLen).padStart(4)} firstBytes=[${f.firstPayload.map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`,
    );
  });

  // State-broadcast triple summary (0x74 headers + their itemCount).
  const headers = frames.filter((f) => f.fn === 0x74);
  if (headers.length > 0) {
    console.log('--- 0x74 EFFECT_START broadcast headers ---');
    headers.forEach((h, idx) => {
      const t = (h.firstPayload[0] & 0x7f) | ((h.firstPayload[1] & 0x7f) << 7);
      const c = (h.firstPayload[2] & 0x7f) | ((h.firstPayload[3] & 0x7f) << 7);
      const op = h.firstPayload[4];
      console.log(`  header[${idx}] targetId=${t} itemCount=${c} opFlag=0x${(op ?? 0).toString(16)}`);
    });
  }
}
