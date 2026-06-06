/**
 * End-to-end smoke for the gen-1 device descriptor: descriptor -> schema
 * encode/decode -> writer.buildSetParam, plus the reader-throws contract.
 * Confirms the unified surface can drive gen-1 (no MIDI hardware needed).
 *
 *   npx tsx scripts/_research/smoke-gen1-descriptor.ts
 */
import { AXEFXGEN1_DESCRIPTOR as D } from '@mcp-midi-control/axe-fx-gen1/descriptor.js';

function assert(c: boolean, m: string): void {
  if (!c) throw new Error('SMOKE FAIL: ' + m);
}

const blocks = Object.keys(D.blocks);
assert(blocks.length >= 30, `expected >=30 blocks, got ${blocks.length}`);
assert(!!D.blocks['amp'], 'no amp block');

// Enum encode/decode: Amp TYPE "PLEXI 1" is doc ordinal 8.
const ampType = D.blocks['amp'].params['type'];
assert(ampType.encode('PLEXI 1') === 8, `amp.type encode('PLEXI 1') => ${ampType.encode('PLEXI 1')} (want 8)`);
assert(ampType.decode(8) === 'PLEXI 1', `amp.type decode(8) => ${ampType.decode(8)}`);

// Linear continuous: Amp Drive 0..10 -> wire 0..254. 5.0 => 127.
const ampDrive = D.blocks['amp'].params['drive'];
assert(ampDrive.encode(5) === 127, `amp.drive encode(5) => ${ampDrive.encode(5)} (want 127)`);

// Writer end-to-end: buildSetParam('amp','type', 8) matches the codec envelope.
// Amp 1 blockId 106 (0A 06), paramId 0 (00 00), value 8 (08 00).
const bytes = D.writer.buildSetParam('amp', 'type', 8);
const expected = [0xf0, 0x00, 0x01, 0x74, 0x01, 0x02, 0x0a, 0x06, 0x00, 0x00, 0x08, 0x00, 0x01, 0xf7];
assert(JSON.stringify(bytes) === JSON.stringify(expected), `buildSetParam bytes ${bytes.map((b) => b.toString(16)).join(' ')}`);

// Reader contract: get_param refuses (no read-back on gen-1).
let threw = false;
try {
  await D.reader.getParam({} as never, 'amp', 'type');
} catch (e) {
  threw = /not supported/i.test((e as Error).message);
}
assert(threw, 'reader.getParam should refuse with capability_not_supported');

// Capabilities sanity.
assert(D.capabilities.support_tier === 'community-beta', 'support_tier');
assert(D.capabilities.has_scenes === false && D.capabilities.has_channels === false, 'gen-1 has no scenes/channels');

console.log(`SMOKE PASS: ${blocks.length} blocks, enum+linear encode/decode, writer envelope, reader-refuses, caps OK.`);
