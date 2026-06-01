/**
 * Look for ARM Thumb-2 code regions in the candidate-unpacked firmware
 * binaries, in case the actual vector table doesn't sit at offset 0
 * (e.g. there's a metadata/header region first).
 *
 * Strategy: 4 KB sliding window. For each window, count the density of
 * Thumb-2 prologue/epilogue/branch byte pairs. Report:
 *   - Top 20 windows by code-density
 *   - First window whose density exceeds a threshold (code-start
 *     candidate)
 *   - Magic bytes at first probable code start
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const VARIANTS = [
  {
    name: 'msb-last-8to7',
    path: join(
      ROOT,
      'packages/fractal-midi/samples/captured/decoded/am4-firmware-extracted-raw.bin'
    ),
    unpack: 'msb-last',
  },
  {
    name: 'unpacked-msb-first',
    path: join(
      ROOT,
      'packages/fractal-midi/samples/captured/decoded/am4-firmware-extracted-unpacked.bin'
    ),
    unpack: 'msb-first-already-unpacked',
  },
];

function unpack8to7MsbLast(p: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < p.length) {
    const groupLen = Math.min(8, p.length - i);
    if (groupLen < 2) break;
    const dataLen = groupLen - 1;
    const msbByte = p[i + dataLen];
    for (let k = 0; k < dataLen; k++) {
      const lo7 = p[i + k] & 0x7f;
      const hi1 = (msbByte >> k) & 0x01;
      out.push((hi1 << 7) | lo7);
    }
    i += groupLen;
  }
  return Buffer.from(out);
}

function loadVariant(v: (typeof VARIANTS)[number]): Buffer {
  const raw = readFileSync(v.path);
  if (v.unpack === 'msb-last') return unpack8to7MsbLast(raw);
  return raw;
}

const WINDOW = 4096;
const STEP = 1024;

function thumbDensity(b: Buffer, start: number, end: number): number {
  let push_b5 = 0;
  let bx_lr = 0;
  let ldr_48 = 0;
  let mov_20 = 0;
  let bl_calls = 0;
  let mov_46 = 0;
  let lsl_lsr_0xx = 0;
  for (let i = start; i + 1 < end; i += 2) {
    const lo = b[i];
    const hi = b[i + 1];
    if (hi === 0xb5) push_b5++;
    if (lo === 0x70 && hi === 0x47) bx_lr++;
    if (hi >= 0x48 && hi <= 0x4f) ldr_48++; // ldr rN, [pc, #imm]
    if (hi >= 0x20 && hi <= 0x27) mov_20++; // mov rN, #imm
    if (hi >= 0x46 && hi <= 0x47) mov_46++; // mov / bx high-reg
    if (hi >= 0xf0 && hi <= 0xf7) bl_calls++; // bl / blx prefix half
    if (hi >= 0x00 && hi <= 0x07) lsl_lsr_0xx++; // lsl rN, #imm
  }
  return push_b5 + bx_lr + ldr_48 + mov_20 + mov_46 + bl_calls + lsl_lsr_0xx;
}

for (const v of VARIANTS) {
  const b = loadVariant(v);
  console.log(`\n[${v.name}] ${b.length} bytes`);

  const windows: Array<{ start: number; density: number; first_bytes_hex: string }> = [];
  for (let start = 0; start + WINDOW <= b.length; start += STEP) {
    const d = thumbDensity(b, start, start + WINDOW);
    windows.push({
      start,
      density: d,
      first_bytes_hex: b.subarray(start, start + 16).toString('hex'),
    });
  }

  windows.sort((a, b) => b.density - a.density);
  console.log(`   top 10 by thumb-sig density per 4KB:`);
  for (const w of windows.slice(0, 10)) {
    console.log(
      `      0x${w.start.toString(16).padStart(7, '0')} density=${w.density}  ${w.first_bytes_hex}`
    );
  }
  const max = windows[0]?.density ?? 0;
  const min = windows[windows.length - 1]?.density ?? 0;
  console.log(`   density range: ${min}..${max}`);

  // Find the first window whose density is >= 75% of the max — that's
  // likely the start of the code region.
  windows.sort((a, b) => a.start - b.start);
  const threshold = Math.floor(max * 0.75);
  const codeStart = windows.find((w) => w.density >= threshold);
  console.log(
    `   first window with density >= 75%% of max (${threshold}): ${
      codeStart ? `0x${codeStart.start.toString(16)} (density=${codeStart.density})` : '(none)'
    }`
  );

  if (codeStart) {
    const off = codeStart.start;
    function u32(o: number): number {
      return (
        (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
      );
    }
    console.log(
      `   at code-start: bytes=${b.subarray(off, off + 32).toString('hex')}`
    );
    console.log(
      `   interpreted as vector table: SP=0x${u32(off).toString(16).padStart(8, '0')}, reset=0x${u32(off + 4).toString(16).padStart(8, '0')}, nmi=0x${u32(off + 8).toString(16).padStart(8, '0')}`
    );
  }

  // Save windowed report
  const out = join(
    ROOT,
    `packages/fractal-midi/samples/captured/decoded/am4-firmware-code-regions-${v.name}.json`
  );
  writeFileSync(
    out,
    JSON.stringify(
      { variant: v.name, file_bytes: b.length, window: WINDOW, step: STEP, windows },
      null,
      2
    )
  );
  console.log(`   wrote ${out}`);
}
