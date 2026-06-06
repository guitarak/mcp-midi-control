import { readFileSync } from 'node:fs';

type Frame = { dir: string; t?: number; fn?: number; sub?: number; len?: number; hex: string };

function checkFrame(hex: string): { ok: boolean; computed: number; stored: number; nbytes: number } {
  // parse hex into bytes
  const bytes = hex.trim().split(/\s+/).map((h) => parseInt(h, 16));
  // must start f0 ... end f7
  const last = bytes.length - 1;
  if (bytes[0] !== 0xf0 || bytes[last] !== 0xf7) {
    return { ok: false, computed: -1, stored: -1, nbytes: bytes.length };
  }
  const stored = bytes[last - 1]; // byte just before f7
  // XOR all bytes from f0 through the last payload byte = everything except [stored, f7]
  let x = 0;
  for (let i = 0; i <= last - 2; i++) x ^= bytes[i];
  x &= 0x7f;
  return { ok: x === stored, computed: x, stored, nbytes: bytes.length };
}

function fnByte(hex: string): number {
  const bytes = hex.trim().split(/\s+/).map((h) => parseInt(h, 16));
  // f0 00 01 74 12 [fn] ...
  return bytes[5];
}

const files = [
  'C:/dev/mcp-midi-tools/samples/captured/decoded/fm9-receive-preset-from-device-harp-2026-06-04.frames.json',
  'C:/dev/mcp-midi-tools/samples/captured/decoded/fm9-enum-label-sweep-harp-2026-06-04.frames.json',
];

const targetFns = new Set([0x77, 0x79, 0x03, 0x7a]);

for (const f of files) {
  const frames: Frame[] = JSON.parse(readFileSync(f, 'utf8'));
  console.log(`\n=== ${f.split('/').pop()} (${frames.length} frames) ===`);

  // overall fn histogram
  const hist: Record<string, number> = {};
  for (const fr of frames) {
    const fn = fnByte(fr.hex);
    hist[fn.toString(16)] = (hist[fn.toString(16)] || 0) + 1;
  }
  console.log('fn histogram:', hist);

  const stats: Record<string, { pass: number; fail: number; fails: { len: number; computed: number; stored: number }[] }> = {};

  for (const fr of frames) {
    const fn = fnByte(fr.hex);
    let key: string | undefined;
    if (targetFns.has(fn)) key = '0x' + fn.toString(16);
    else if (fn === 0x78) {
      const nbytes = fr.hex.trim().split(/\s+/).length;
      if (nbytes === 3082) key = '0x78@3082';
    }
    if (!key) continue;
    const r = checkFrame(fr.hex);
    if (!stats[key]) stats[key] = { pass: 0, fail: 0, fails: [] };
    if (r.ok) stats[key].pass++;
    else {
      stats[key].fail++;
      if (stats[key].fails.length < 8) stats[key].fails.push({ len: r.nbytes, computed: r.computed, stored: r.stored });
    }
  }

  for (const [k, v] of Object.entries(stats)) {
    console.log(`  ${k}: pass=${v.pass} fail=${v.fail}` + (v.fail ? ` fails=${JSON.stringify(v.fails)}` : ''));
  }

  // also report ALL 0x78 by length, and any oversized fails
  const byLen: Record<number, { pass: number; fail: number }> = {};
  for (const fr of frames) {
    if (fnByte(fr.hex) !== 0x78) continue;
    const nbytes = fr.hex.trim().split(/\s+/).length;
    const r = checkFrame(fr.hex);
    if (!byLen[nbytes]) byLen[nbytes] = { pass: 0, fail: 0 };
    if (r.ok) byLen[nbytes].pass++; else byLen[nbytes].fail++;
  }
  console.log('  all 0x78 by length:', byLen);
}
