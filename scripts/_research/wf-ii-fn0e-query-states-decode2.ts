/**
 * Scratch decode pass 2 of Axe-Fx II fn 0x0E SYSEX_QUERY_STATES.
 * READ-ONLY. Exhaustive field-pair search for effectId 100..170.
 */

const RECORDS: number[][] = [
  [0x03, 0x4a, 0x10, 0x53, 0x06],
  [0x03, 0x4e, 0x18, 0x63, 0x06],
  [0x02, 0x52, 0x20, 0x23, 0x07],
  [0x02, 0x56, 0x00, 0x20, 0x06],
  [0x02, 0x5e, 0x28, 0x03, 0x07],
  [0x02, 0x62, 0x30, 0x2b, 0x78],
  [0x02, 0x70, 0x38, 0x33, 0x07],
  [0x02, 0x0a, 0x7d, 0x17, 0x07],
  [0x03, 0x26, 0x51, 0x73, 0x06],
  [0x02, 0x2c, 0x75, 0x43, 0x07],
  [0x02, 0x42, 0x59, 0x63, 0x07],
];

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
const hex = (b: number) => b.toString(16).padStart(2, '0');

// The whole 5-byte record is 5 septets. Concatenate to a 35-bit LSB-first stream,
// then try extracting an effectId from various bit positions / widths.
function rec35(rec: number[]): bigint {
  let v = 0n;
  for (let i = 0; i < 5; i++) v |= BigInt(rec[i] & 0x7f) << BigInt(7 * i);
  return v;
}

console.log('=== Sliding 8-bit window over the 35-bit LSB-first stream, looking for 100..170 ===');
for (let r = 0; r < RECORDS.length; r++) {
  const v = rec35(RECORDS[r]);
  const hits: string[] = [];
  for (let shift = 0; shift <= 27; shift++) {
    const byte = Number((v >> BigInt(shift)) & 0xffn);
    if (BLOCKS[byte]) hits.push(`shift${shift}=${byte}(${BLOCKS[byte]})`);
  }
  console.log(`rec ${String(r).padStart(2)} (${RECORDS[r].map(hex).join(' ')}): ${hits.join('  ') || 'no 100..170 match'}`);
}

// Treat the record as a big-endian 35-bit stream (septet b0 is MSB).
function rec35BE(rec: number[]): bigint {
  let v = 0n;
  for (let i = 0; i < 5; i++) v = (v << 7n) | BigInt(rec[i] & 0x7f);
  return v;
}
console.log('\n=== Sliding 8-bit window over 35-bit BIG-endian stream ===');
for (let r = 0; r < RECORDS.length; r++) {
  const v = rec35BE(RECORDS[r]);
  const hits: string[] = [];
  for (let shift = 0; shift <= 27; shift++) {
    const byte = Number((v >> BigInt(shift)) & 0xffn);
    if (BLOCKS[byte]) hits.push(`shift${shift}=${byte}`);
  }
  console.log(`rec ${String(r).padStart(2)}: BE=0x${v.toString(16)}  ${hits.join('  ') || 'no match'}`);
}

// Try: effectId encoded as (b1<<? | ...) MSB-first 14-bit where b1 is HIGH septet.
console.log('\n=== b1 as HIGH septet, b2 as LOW septet (MSB-first 14-bit) ===');
for (let r = 0; r < RECORDS.length; r++) {
  const [, b1, b2] = RECORDS[r];
  const id = ((b1 & 0x7f) << 7) | (b2 & 0x7f);
  console.log(`rec ${String(r).padStart(2)} b1,b2 MSB-first = ${id} (0x${id.toString(16)})  ${BLOCKS[id] ?? ''}`);
}

// Try interpreting b1 directly minus a base. b1 = 0x4a(74),0x4e(78)... not 100.
// But maybe effectId = b1 + 26?  74+26=100! Let's test b1+26 for all.
console.log('\n=== b1 + 26 (does 0x4a->100 Amp? etc) ===');
for (let r = 0; r < RECORDS.length; r++) {
  const b1 = RECORDS[r][1];
  const id = b1 + 26;
  console.log(`rec ${String(r).padStart(2)} b1=${hex(b1)}(${b1}) +26 = ${id} (${BLOCKS[id] ?? '???'})`);
}

// b1 right-shifted by 1? b1 values are even-ish. 0x4a=74, >>1=37. no.
// b1 / 2 + base?
console.log('\n=== (b1>>1) and (b1>>1)+base candidates ===');
for (let r = 0; r < RECORDS.length; r++) {
  const b1 = RECORDS[r][1];
  console.log(`rec ${String(r).padStart(2)} b1=${hex(b1)}(${b1}) >>1=${b1 >> 1}  +100=${(b1 >> 1) + 100}(${BLOCKS[(b1 >> 1) + 100] ?? '?'})  +63=${(b1>>1)+63}(${BLOCKS[(b1>>1)+63]??'?'})`);
}

// CRITICAL: re-examine. Maybe the 5-byte record is: [count_or_scene, septet14 effectId (b1 lo, b2 hi)... ]
// but with effectId septet packed where b1&0x7f is LOW and (b2&0x7f) HIGH but effectId 106 = 0x6a.
// 0x6a low septet = 0x6a, high = 0. So b1 should be 0x6a for Amp1. We see 0x4a. diff 0x20.
// Hmm 0x4a vs 0x6a: bit 5 difference. Maybe b1 top bit(s) are flags and low 6 bits + something.
// Let's mask b1 to low 6 / low 5 bits and add.
console.log('\n=== b1 low-6-bits, low-5-bits ===');
for (let r = 0; r < RECORDS.length; r++) {
  const b1 = RECORDS[r][1];
  console.log(`rec ${String(r).padStart(2)} b1=${hex(b1)} &0x3f=${b1 & 0x3f}(+64=${(b1&0x3f)+64} +100=${(b1&0x3f)+100}) &0x1f=${b1 & 0x1f}`);
}
