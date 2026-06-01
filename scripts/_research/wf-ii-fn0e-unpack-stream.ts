/**
 * Treat the whole fn 0x0E payload as a septet-packed byte stream and
 * unpack it back to 8-bit bytes, then look for the 11 placed effectIds.
 * READ-ONLY. Tests both 7->8 LSB-first and MSB-first unpack.
 */

const PROBE_PAYLOAD = [
  0x03, 0x4a, 0x10, 0x53, 0x06, 0x03, 0x4e, 0x18, 0x63, 0x06, 0x02, 0x52, 0x20, 0x23, 0x07,
  0x02, 0x56, 0x00, 0x20, 0x06, 0x02, 0x5e, 0x28, 0x03, 0x07, 0x02, 0x62, 0x30, 0x2b, 0x78,
  0x02, 0x70, 0x38, 0x33, 0x07, 0x02, 0x0a, 0x7d, 0x17, 0x07, 0x03, 0x26, 0x51, 0x73, 0x06,
  0x02, 0x2c, 0x75, 0x43, 0x07, 0x02, 0x42, 0x59, 0x63, 0x07,
];
const SORTED_IDS = [100, 106, 108, 110, 112, 116, 118, 120, 122, 124, 133];
const GRID_ORDER_IDS = [100, 124, 122, 133, 106, 108, 116, 118, 112, 120, 110];
const hex = (b: number) => b.toString(16).padStart(2, '0');

// Standard MIDI 7-to-8 unpack: every group of 8 wire bytes -> first byte holds
// the high bits (bit0->byte1 msb, etc). But Fractal doesn't use that here for
// most messages. Try the generic continuous-bitstream unpack instead.
function unpackLSBFirst(payload: number[]): number[] {
  // Concatenate all 7-bit groups LSB-first into a bit buffer, re-chunk to 8.
  let bitbuf = 0, nbits = 0;
  const out: number[] = [];
  for (const b of payload) {
    bitbuf |= (b & 0x7f) << nbits;
    nbits += 7;
    while (nbits >= 8) { out.push(bitbuf & 0xff); bitbuf >>= 8; nbits -= 8; }
  }
  return out;
}
function unpackMSBFirst(payload: number[]): number[] {
  let bitbuf = 0, nbits = 0;
  const out: number[] = [];
  for (const b of payload) {
    bitbuf = (bitbuf << 7) | (b & 0x7f);
    nbits += 7;
    while (nbits >= 8) { nbits -= 8; out.push((bitbuf >> nbits) & 0xff); }
  }
  return out;
}

function report(name: string, bytes: number[]) {
  console.log(`\n=== ${name} (${bytes.length} bytes) ===`);
  console.log(bytes.map(hex).join(' '));
  const positions: Record<number, number[]> = {};
  bytes.forEach((b, idx) => {
    if (b >= 100 && b <= 170) { (positions[b] ??= []).push(idx); }
  });
  const foundIds = Object.keys(positions).map(Number).sort((a, b) => a - b);
  console.log('effectId-range bytes found:', foundIds.join(', '));
  console.log('want (sorted):', SORTED_IDS.join(', '));
  const hit = SORTED_IDS.filter((id) => foundIds.includes(id));
  console.log(`matched ${hit.length}/11 placed IDs: ${hit.join(', ')}`);
  if (hit.length >= 8) {
    console.log('positions:', JSON.stringify(positions));
  }
}

report('LSB-first 7->8 unpack', unpackLSBFirst(PROBE_PAYLOAD));
report('MSB-first 7->8 unpack', unpackMSBFirst(PROBE_PAYLOAD));

// Also try the classic MIDI block unpack (8-byte groups, leading hi-bit byte).
function unpackMidiBlocks(payload: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < payload.length; i += 8) {
    const group = payload.slice(i, i + 8);
    const hiBits = group[0] & 0x7f;
    for (let k = 1; k < group.length; k++) {
      const hi = (hiBits >> (k - 1)) & 1;
      out.push((group[k] & 0x7f) | (hi << 7));
    }
  }
  return out;
}
report('MIDI 8-byte-group unpack', unpackMidiBlocks(PROBE_PAYLOAD));

// Hypothesis: per-record, the high bits live in b4 (the 06/07/78 column).
// 0x06=0b110, 0x07=0b111. Maybe b4 carries the top bits for b0..b3 of THIS record.
// reconstruct each record's 4 data bytes with b4 as the hi-bit carrier.
console.log('\n=== Per-record: b4 as hi-bit carrier for b0..b3 ===');
const recs: number[][] = [];
for (let i = 0; i < PROBE_PAYLOAD.length; i += 5) recs.push(PROBE_PAYLOAD.slice(i, i + 5));
for (let r = 0; r < recs.length; r++) {
  const [b0, b1, b2, b3, b4] = recs[r];
  const d0 = (b0 & 0x7f) | (((b4 >> 0) & 1) << 7);
  const d1 = (b1 & 0x7f) | (((b4 >> 1) & 1) << 7);
  const d2 = (b2 & 0x7f) | (((b4 >> 2) & 1) << 7);
  const d3 = (b3 & 0x7f) | (((b4 >> 3) & 1) << 7);
  console.log(`rec ${String(r).padStart(2)} b4=${hex(b4)} -> d0=${d0}(${hex(d0)}) d1=${d1}(${hex(d1)}) d2=${d2}(${hex(d2)}) d3=${d3}(${hex(d3)})`);
}
