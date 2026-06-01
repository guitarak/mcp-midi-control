/**
 * wf-ii-fn16-roundtrip.ts (READ-ONLY)
 * Round-trip proof: re-encode the decoded fields back to wire and assert
 * byte-exact match with the two captured payloads. Confirms the 5x5-septet
 * field model with sept5-LE (low septet first, then reinterpret as u32/f32)
 * is the correct packing — independent of the (min/max/default) labelling.
 */
function encSept5FromU32(u: number): number[] {
  u = u >>> 0;
  return [u & 0x7f, (u >>> 7) & 0x7f, (u >>> 14) & 0x7f, (u >>> 21) & 0x7f, (u >>> 28) & 0x7f];
}
function f32ToU32(f: number): number {
  const b = new ArrayBuffer(4); new DataView(b).setFloat32(0, f, true);
  return new DataView(b).getUint32(0, true);
}
function decU32(w: number[]): number {
  return (((w[0]&0x7f)|((w[1]&0x7f)<<7)|((w[2]&0x7f)<<14)|((w[3]&0x7f)<<21))+(w[4]&0x7f)*0x10000000)>>>0;
}
function decF32(w: number[]): number {
  const u = decU32(w); const b=new ArrayBuffer(4); new DataView(b).setUint32(0,u,true); return new DataView(b).getFloat32(0,true);
}

const P0 = [0x10,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x12,0x1c,0x04,0x00,0x00,0x00,0x7c,0x03,0x00,0x00,0x00,0x00,0x00];
const P10= [0x41,0x10,0x00,0x00,0x00,0x2c,0x0b,0x1f,0x39,0x03,0x0a,0x2e,0x0f,0x61,0x03,0x00,0x48,0x50,0x4b,0x04,0x00,0x00,0x00,0x00,0x00];

function check(name: string, p: number[]) {
  const g = [0,1,2,3,4].map(i => p.slice(i*5, i*5+5));
  const fields = {
    g0_int: decU32(g[0]),
    g1_f32: decF32(g[1]),
    g2_f32: decF32(g[2]),
    g3_f32: decF32(g[3]),
    g4_int: decU32(g[4]),
  };
  // re-encode: g0 + g4 as their int u32; g1..g3 as float u32
  const re = [
    ...encSept5FromU32(fields.g0_int),
    ...encSept5FromU32(f32ToU32(fields.g1_f32)),
    ...encSept5FromU32(f32ToU32(fields.g2_f32)),
    ...encSept5FromU32(f32ToU32(fields.g3_f32)),
    ...encSept5FromU32(fields.g4_int),
  ];
  const match = re.length === p.length && re.every((b,i)=>b===p[i]);
  console.log(`\n${name}: roundtrip ${match ? 'PASS' : 'FAIL'}`);
  console.log('  fields:', JSON.stringify(fields));
  if (!match) console.log('  re:', re.map(b=>b.toString(16).padStart(2,'0')).join(' '));
}

check('P0  (pid=0 enum amp.effect_type)', P0);
check('P10 (pid=10 knob)', P10);
