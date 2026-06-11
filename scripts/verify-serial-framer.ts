/**
 * Goldens for the serial (USB-CDC) MIDI transport pieces in
 * packages/core/src/midi/serialFraming.ts and serialTransport.ts.
 *
 * Why this exists. The FM3's USB control channel is a CDC serial device
 * carrying a raw MIDI byte stream — reads arrive at ARBITRARY chunk
 * boundaries (half a SysEx frame, or three frames back-to-back in one
 * chunk), unlike node-midi which delivers message-aligned fragments.
 * `createSerialMidiFramer` re-frames that stream into the
 * one-complete-message-per-dispatch contract every downstream parser
 * assumes. These goldens prove the framing without hardware, including
 * the MIDI-grammar edge cases (realtime interleave inside SysEx, running
 * status, malformed-frame drop).
 *
 * Also covers `matchFractalSerialPort` — the discovery filter that decides
 * which OS serial ports look like a Fractal CDC control channel.
 *
 * Runs in `npm test`. No hardware, no serialport native module needed.
 */

import { createSerialMidiFramer } from '../packages/core/src/midi/serialFraming.js';
import {
  matchFractalSerialPort,
  type SerialPortInfoLike,
} from '../packages/core/src/midi/serialTransport.js';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function runFramer(chunks: number[][]): number[][] {
  const out: number[][] = [];
  const frame = createSerialMidiFramer((bytes) => out.push(bytes));
  for (const c of chunks) frame(c);
  return out;
}

function eq(a: number[][], b: number[][]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A realistic gen-3 frame (FM3 model byte 0x11, fn=0x01 discrete SELECT —
// the collaborator's hardware-confirmed Shiver Clean frame).
const FM3_SELECT_FRAME = [
  0xf0, 0x00, 0x01, 0x74, 0x11, 0x01, 0x09, 0x00, 0x3a, 0x00, 0x06, 0x00,
  0x00, 0x00, 0x60, 0x0f, 0x04, 0x00, 0x00, 0x00, 0x00, 0x4b, 0xf7,
];

console.log('serial framer:');

check(
  'complete SysEx in one chunk passes through',
  eq(runFramer([FM3_SELECT_FRAME]), [FM3_SELECT_FRAME]),
);

check(
  'SysEx split at arbitrary boundaries (1-byte chunks) reassembles byte-exact',
  eq(runFramer(FM3_SELECT_FRAME.map((b) => [b])), [FM3_SELECT_FRAME]),
);

check(
  'three frames back-to-back in ONE chunk emit as three messages',
  eq(
    runFramer([[...FM3_SELECT_FRAME, ...FM3_SELECT_FRAME, ...FM3_SELECT_FRAME]]),
    [FM3_SELECT_FRAME, FM3_SELECT_FRAME, FM3_SELECT_FRAME],
  ),
);

check(
  'frame boundary mid-chunk: tail of frame 1 + head of frame 2 in one chunk',
  eq(
    runFramer([
      FM3_SELECT_FRAME.slice(0, 10),
      [...FM3_SELECT_FRAME.slice(10), ...FM3_SELECT_FRAME.slice(0, 7)],
      FM3_SELECT_FRAME.slice(7),
    ]),
    [FM3_SELECT_FRAME, FM3_SELECT_FRAME],
  ),
);

check(
  'realtime byte (0xFE active sensing) inside a SysEx emits alone, frame survives',
  eq(
    runFramer([
      [...FM3_SELECT_FRAME.slice(0, 12), 0xfe, ...FM3_SELECT_FRAME.slice(12)],
    ]),
    [[0xfe], FM3_SELECT_FRAME],
  ),
);

check(
  'channel message (PC) between SysEx frames',
  eq(
    runFramer([[...FM3_SELECT_FRAME, 0xc0, 0x05, ...FM3_SELECT_FRAME]]),
    [FM3_SELECT_FRAME, [0xc0, 0x05], FM3_SELECT_FRAME],
  ),
);

check(
  'CC split across chunks + running status',
  eq(
    runFramer([[0xb0, 0x07], [0x40, 0x0b, 0x22]]),
    [[0xb0, 0x07, 0x40], [0xb0, 0x0b, 0x22]],
  ),
);

check(
  'malformed: new F0 mid-SysEx drops the partial frame, keeps the new one',
  eq(
    runFramer([[0xf0, 0x00, 0x01, ...FM3_SELECT_FRAME]]),
    [FM3_SELECT_FRAME],
  ),
);

check(
  'stray data bytes with no status are dropped',
  eq(runFramer([[0x12, 0x34, 0x56]]), []),
);

check(
  'stray F7 (EOX without F0) is dropped, never dispatched as data',
  eq(runFramer([[0xf7, ...FM3_SELECT_FRAME]]), [FM3_SELECT_FRAME]),
);

check(
  'stray F7 cancels running status (no mis-framing of following data bytes)',
  eq(runFramer([[0xb0, 0x07, 0x40, 0xf7, 0x0b, 0x22]]), [[0xb0, 0x07, 0x40]]),
);

check(
  'SysEx cancels running status (data after the frame is not framed onto the old CC)',
  eq(
    runFramer([[0xb0, 0x07, 0x40, ...FM3_SELECT_FRAME, 0x0b, 0x22]]),
    [[0xb0, 0x07, 0x40], FM3_SELECT_FRAME],
  ),
);

console.log('serial discovery filter:');

const cases: { name: string; info: SerialPortInfoLike; matches: boolean }[] = [
  {
    name: 'Fractal vendor id 2466 matches (any OS)',
    info: { path: '/dev/cu.usbmodem14201', vendorId: '2466', productId: '8014' },
    matches: true,
  },
  {
    name: 'Windows "FM3 Communications Port" friendly name matches',
    info: { path: 'COM5', friendlyName: 'FM3 Communications Port (COM5)' },
    matches: true,
  },
  {
    name: 'Fractal manufacturer string matches',
    info: { path: '/dev/ttyACM0', manufacturer: 'Fractal Audio Systems' },
    matches: true,
  },
  {
    name: 'bare usbmodem with NO metadata does NOT auto-match (explicit-path escape hatch instead)',
    info: { path: '/dev/cu.usbmodem11101' },
    matches: false,
  },
  {
    name: 'Arduino CDC device does not match',
    info: { path: 'COM7', friendlyName: 'Arduino Uno (COM7)', vendorId: '2341' },
    matches: false,
  },
];

for (const c of cases) {
  const reason = matchFractalSerialPort(c.info);
  check(c.name, (reason !== undefined) === c.matches, `got ${reason ?? 'no match'}`);
}

if (failures > 0) {
  console.error(`\nverify-serial-framer: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nverify-serial-framer: all checks passed.');
