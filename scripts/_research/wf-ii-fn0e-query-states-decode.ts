/**
 * Scratch decode of Axe-Fx II fn 0x0E SYSEX_QUERY_STATES 62-byte response.
 * READ-ONLY. Operates entirely on the captured ground-truth bytes.
 *
 * Ground truth (samples/captured/probe-axefx2-new-opcodes-findings.md):
 *   Request : f0 00 01 74 07 0e 0c f7   (empty payload)
 *   Response: 62-byte frame, 11 records x 5 bytes.
 */

const FRAME = [
  0xf0, 0x00, 0x01, 0x74, 0x07, 0x0e,
  // payload begins
  0x03, 0x4a, 0x10, 0x53, 0x06,
  0x03, 0x4e, 0x18, 0x63, 0x06,
  0x02, 0x52, 0x20, 0x23, 0x07,
  0x02, 0x56, 0x00, 0x20, 0x06,
  0x02, 0x5e, 0x28, 0x03, 0x07,
  0x02, 0x62, 0x30, 0x2b, 0x78,
  0x02, 0x70, 0x38, 0x33, 0x07,
  0x02, 0x0a, 0x7d, 0x17, 0x07,
  0x03, 0x26, 0x51, 0x73, 0x06,
  0x02, 0x2c, 0x75, 0x43, 0x07,
  0x02, 0x42, 0x59, 0x63, 0x07,
  // payload ends
  0xf7,
];

// Block table (effectId -> name), from blockTypes.ts
const BLOCKS: Record<number, string> = {
  100: 'Compressor 1', 101: 'Compressor 2', 102: 'Graphic EQ 1', 103: 'Graphic EQ 2',
  104: 'Parametric EQ 1', 105: 'Parametric EQ 2', 106: 'Amp 1', 107: 'Amp 2',
  108: 'Cab 1', 109: 'Cab 2', 110: 'Reverb 1', 111: 'Reverb 2', 112: 'Delay 1',
  113: 'Delay 2', 114: 'Multi Delay 1', 115: 'Multi Delay 2', 116: 'Chorus 1',
  117: 'Chorus 2', 118: 'Flanger 1', 119: 'Flanger 2', 120: 'Rotary Speaker 1',
  121: 'Rotary Speaker 2', 122: 'Phaser 1', 123: 'Phaser 2', 124: 'Wah 1',
  125: 'Wah 2', 126: 'Formant', 127: 'Volume/Pan 1', 128: 'Tremolo/Panner 1',
  129: 'Tremolo/Panner 2', 130: 'Pitch 1', 131: 'Filter 1', 132: 'Filter 2',
  133: 'Drive 1', 134: 'Drive 2', 135: 'Enhancer', 136: 'FX Loop', 137: 'Mixer',
  138: 'Mixer 2', 139: 'Input Noise Gate', 140: 'Output', 141: 'Controllers',
  142: 'Feedback Send', 143: 'Feedback Return', 144: 'Synth 1', 145: 'Synth 2',
  146: 'Vocoder', 147: 'Megatap Delay', 148: 'Crossover 1', 149: 'Crossover 2',
  150: 'Gate Expander', 151: 'Gate Expander 2', 152: 'Ring Modulator', 153: 'Pitch 2',
  154: 'Multiband Compressor 1', 155: 'Multiband Compressor 2', 156: 'Quad Chorus 1',
  157: 'Quad Chorus 2', 158: 'Resonator 1', 159: 'Resonator 2', 160: 'Graphic EQ 3',
  161: 'Graphic EQ 4', 162: 'Parametric EQ 3', 163: 'Parametric EQ 4', 164: 'Filter 3',
  165: 'Filter 4', 166: 'Volume/Pan 2', 167: 'Volume/Pan 3', 168: 'Volume/Pan 4',
  169: 'Looper', 170: 'Tone Match',
};

function hex(b: number): string { return b.toString(16).padStart(2, '0'); }
function bin8(b: number): string { return (b & 0xff).toString(2).padStart(8, '0'); }
function decode14_loFirst(lo: number, hi: number): number { return (lo & 0x7f) | ((hi & 0x7f) << 7); }
function decode14_hiFirst(hi: number, lo: number): number { return (lo & 0x7f) | ((hi & 0x7f) << 7); }

// 1. Verify checksum (xor over F0..last payload byte, & 0x7f, compared to last payload byte? no -
// the 0x0E frame here has no separate checksum byte position visible: 62 bytes = 6 header + 55 payload + 1 F7.
// Check whether the LAST payload byte before F7 is a checksum.
console.log('=== Frame length / structure ===');
console.log('total bytes:', FRAME.length);
console.log('header (6):', FRAME.slice(0, 6).map(hex).join(' '));
console.log('trailer:', hex(FRAME[FRAME.length - 1]));
const payload = FRAME.slice(6, FRAME.length - 1);
console.log('payload length:', payload.length, '=> /5 =', payload.length / 5);

// XOR checksum test: is the final payload byte a checksum over F0..(2nd-last payload)?
{
  let acc = 0;
  for (let i = 0; i < FRAME.length - 2; i++) acc ^= FRAME[i]; // F0..2nd-last-payload
  const cs = acc & 0x7f;
  console.log(`\nXOR-checksum-as-last-payload-byte test: computed ${hex(cs)} vs last payload byte ${hex(FRAME[FRAME.length - 2])}`,
    cs === FRAME[FRAME.length - 2] ? 'MATCH (so 11th record is truncated / cs)' : 'NO MATCH (last payload byte is data, no trailing cs)');
}

// 2. Split into 5-byte records and run candidate decodes.
const records: number[][] = [];
for (let i = 0; i < payload.length; i += 5) records.push(payload.slice(i, i + 5));

console.log('\n=== Records (raw + candidate decodes) ===');
console.log('idx | raw            | b0   b1   b2   b3   b4');
for (let r = 0; r < records.length; r++) {
  const [b0, b1, b2, b3, b4] = records[r];
  console.log(`${String(r).padStart(2)}  | ${records[r].map(hex).join(' ')}    | ${hex(b0)} ${hex(b1)} ${hex(b2)} ${hex(b3)} ${hex(b4)}`);
}

console.log('\n=== Hypothesis A: b0=tag(02/03), [b1,b2]=septet effectId(lo,hi), b3=?, b4=? ===');
for (let r = 0; r < records.length; r++) {
  const [b0, b1, b2, b3, b4] = records[r];
  const idLoFirst = decode14_loFirst(b1, b2);
  const idHiFirst = decode14_hiFirst(b1, b2);
  console.log(
    `rec ${String(r).padStart(2)} tag=${hex(b0)}  ` +
    `id(lo,hi)=${idLoFirst} (${BLOCKS[idLoFirst] ?? '???'})  ` +
    `id(hi,lo)=${idHiFirst} (${BLOCKS[idHiFirst] ?? '???'})  ` +
    `b3=${hex(b3)} b4=${hex(b4)}`);
}

console.log('\n=== Hypothesis B: b0=tag, b1=effectId-lowbyte-only(0x40+), [b2,b3]=septet state-ushort, b4=? ===');
for (let r = 0; r < records.length; r++) {
  const [b0, b1, b2, b3, b4] = records[r];
  // b1 looks like 0x4a,0x4e,0x52,0x56,0x5e,0x62,0x70,0x0a,0x26,0x2c,0x42 - climbing
  const ushortLo = decode14_loFirst(b2, b3);
  const ushortHi = decode14_hiFirst(b2, b3);
  console.log(
    `rec ${String(r).padStart(2)} tag=${hex(b0)} b1=${hex(b1)}(${b1})  ` +
    `ushort(lo,hi)=${ushortLo} (0x${ushortLo.toString(16)})  bypass=${ushortLo & 0xff} chanY=${(ushortLo >> 8) & 0xff}  ` +
    `b4=${hex(b4)}`);
}

console.log('\n=== b1 column analysis (is it a packed index/effectId?) ===');
console.log('b1 values:', records.map((r) => r[1]).map((v) => `${hex(v)}(${v})`).join(' '));
console.log('b1 deltas:', records.map((r) => r[1]).map((v, i, a) => i === 0 ? '-' : v - a[i - 1]).join(' '));

console.log('\n=== b4 column analysis (constant-ish? 06/07) ===');
console.log('b4 values:', records.map((r) => r[4]).map(hex).join(' '));

console.log('\n=== Per-record full bit dump ===');
for (let r = 0; r < records.length; r++) {
  console.log(`rec ${String(r).padStart(2)}: ` + records[r].map((b) => bin8(b)).join(' '));
}

// 3. Hypothesis C: the whole record is a packed bitstream. 5 bytes = 35 useful bits
// (5 septets). Reconstruct the 35-bit LSB-first value and the 35-bit value's fields.
console.log('\n=== Hypothesis C: 5 septets -> 35-bit LSB-first reconstruction ===');
for (let r = 0; r < records.length; r++) {
  const [b0, b1, b2, b3, b4] = records[r];
  let val = 0n;
  val |= BigInt(b0 & 0x7f) << 0n;
  val |= BigInt(b1 & 0x7f) << 7n;
  val |= BigInt(b2 & 0x7f) << 14n;
  val |= BigInt(b3 & 0x7f) << 21n;
  val |= BigInt(b4 & 0x7f) << 28n;
  console.log(`rec ${String(r).padStart(2)} 35bit=0x${val.toString(16)} (${val})`);
}
