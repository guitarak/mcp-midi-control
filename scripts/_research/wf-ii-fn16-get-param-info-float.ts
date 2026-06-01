/**
 * wf-ii-fn16-get-param-info-float.ts  (READ-ONLY research scratch)
 *
 * HYP A produced 32-bit values that look like IEEE-754 floats. Decode
 * each 5-septet group as a float32 (both the AM4 packFloat32LE 8-to-7
 * stream AND the plain sept5 LE u32 -> reinterpret), and match against
 * the catalog: enum max 258, knob range, default.
 *
 * Run: npx tsx scripts/_research/wf-ii-fn16-get-param-info-float.ts
 */
import { unpackFloat32LE } from '../../packages/fractal-midi/src/shared/packValue.ts';

const P0 = [
  0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x12, 0x1c, 0x04, 0x00, 0x00, 0x00, 0x7c, 0x03, 0x00, 0x00, 0x00, 0x00,
  0x00,
];
const P10 = [
  0x41, 0x10, 0x00, 0x00, 0x00, 0x2c, 0x0b, 0x1f, 0x39, 0x03, 0x0a, 0x2e,
  0x0f, 0x61, 0x03, 0x00, 0x48, 0x50, 0x4b, 0x04, 0x00, 0x00, 0x00, 0x00,
  0x00,
];

// plain sept5 LE -> u32 -> reinterpret as float32
function sept5u32(w: number[]): number {
  return (
    ((w[0] & 0x7f) |
      ((w[1] & 0x7f) << 7) |
      ((w[2] & 0x7f) << 14) |
      ((w[3] & 0x7f) << 21)) +
    (w[4] & 0x7f) * 0x10000000
  );
}
function u32ToF32(u: number): number {
  const b = new ArrayBuffer(4);
  new DataView(b).setUint32(0, u >>> 0, true);
  return new DataView(b).getFloat32(0, true);
}

function decodeGroups(label: string, p: number[]) {
  console.log(`\n=== ${label} ===`);
  for (let g = 0; g < 5; g++) {
    const o = g * 5;
    const w = p.slice(o, o + 5);
    const u_sept5 = sept5u32(w) >>> 0;
    const f_sept5 = u32ToF32(u_sept5);
    let f_8to7 = NaN;
    try {
      f_8to7 = unpackFloat32LE(Uint8Array.from(w));
    } catch {
      /* ignore */
    }
    console.log(
      `group ${g} (off ${o}-${o + 4}) wire=[${w
        .map((x) => x.toString(16).padStart(2, '0'))
        .join(' ')}]  sept5u32=${u_sept5} (0x${u_sept5
        .toString(16)
        .padStart(8, '0')})  asF32(sept5)=${f_sept5}  asF32(8to7stream)=${f_8to7}`,
    );
  }
}

decodeGroups('P0  paramId=0 (amp.effect_type, enum)', P0);
decodeGroups('P10 paramId=10 (amp.bright_cap, knob)', P10);

console.log('\n=== Interpretation table ===');
console.log('Catalog: enum has 259 entries (0..258). Knob nominal display 0..10 (bright_cap implied).');
