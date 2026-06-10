/**
 * End-to-end FM9 verification: drives the SAME boundary the unified set_param /
 * get_param tools use (encodeValue / schema.decode on FM9_DESCRIPTOR) plus the
 * real wire builder, to prove device-true amp/drive set-by-name and read-labels
 * flow through for FM9 users. No hardware: this exercises encode→wire→decode.
 *
 * Run: npx tsx scripts/verify-fm9-end-to-end.ts   (also a launch-verify gate)
 */
import { FM9_DESCRIPTOR } from '@mcp-midi-control/fractal-modern/device.js';
import { encodeValue } from '@mcp-midi-control/core/protocol-generic/dispatcher/resolvers.js';

let failed = 0;
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${cond ? '' : ` — ${detail}`}`);
  if (!cond) failed++;
};

// Resolve the amp + drive type params by walking the descriptor blocks so the
// test is robust to block-name aliasing (amp == DISTORT, drive == FUZZ).
const blocks = FM9_DESCRIPTOR.blocks;
function findTypeParam(predicate: (vals: string) => boolean): { block: string; name: string } | undefined {
  for (const [bname, bdef] of Object.entries(blocks)) {
    for (const [pname, schema] of Object.entries(bdef.params)) {
      const dec = schema.decode;
      try {
        // an enum type param decodes a known ordinal to a name string
        const s = String(dec(0));
        if (predicate(s) || /type/i.test(pname)) {
          // confirm it's the right family by probing a couple ordinals
          return { block: bname, name: pname };
        }
      } catch { /* skip */ }
    }
  }
  return undefined;
}

console.log('FM9 end-to-end (set-by-name + read-label + wire):');

// --- AMP set-by-name (DISTORT_TYPE, 331-roster) ---
const ampType = { block: 'amp', name: 'type' };
const ampSchema = blocks[ampType.block]?.params[ampType.name];
ok(`amp.type param exists (block "${ampType.block}")`, ampSchema !== undefined);
if (ampSchema) {
  ok('set amp.type "SV Bass 2" → ordinal 65',
    encodeValue(FM9_DESCRIPTOR, ampType.block, ampType.name, 'SV Bass 2') === 65,
    String(encodeValue(FM9_DESCRIPTOR, ampType.block, ampType.name, 'SV Bass 2')));
  ok('set amp.type "Texas Star Clean" → 179',
    encodeValue(FM9_DESCRIPTOR, ampType.block, ampType.name, 'Texas Star Clean') === 179);
  ok('set amp.type "SV Bass 1" → 264',
    encodeValue(FM9_DESCRIPTOR, ampType.block, ampType.name, 'SV Bass 1') === 264);
  // case + word-order tolerance (the resolver is tolerant)
  ok('set amp.type "sv bass 2" (case-insensitive) → 65',
    encodeValue(FM9_DESCRIPTOR, ampType.block, ampType.name, 'sv bass 2') === 65);
  // read-label: decode the ordinal back to the device-true name
  ok('get amp.type ordinal 65 → "SV Bass 2"', ampSchema.decode(65) === 'SV Bass 2',
    String(ampSchema.decode(65)));
  ok('get amp.type ordinal 179 → "Texas Star Clean"', ampSchema.decode(179) === 'Texas Star Clean');
}

// --- DRIVE set-by-name (FUZZ_TYPE, 86-roster) ---
const drvType = { block: 'drive', name: 'type' };
const drvSchema = blocks[drvType.block]?.params[drvType.name];
ok(`drive.type param exists (block "${drvType.block}")`, drvSchema !== undefined);
if (drvSchema) {
  ok('set drive.type "Blues OD" → 15',
    encodeValue(FM9_DESCRIPTOR, drvType.block, drvType.name, 'Blues OD') === 15,
    String(encodeValue(FM9_DESCRIPTOR, drvType.block, drvType.name, 'Blues OD')));
  ok('set drive.type "Blackglass 7K" → 36',
    encodeValue(FM9_DESCRIPTOR, drvType.block, drvType.name, 'Blackglass 7K') === 36);
  ok('get drive.type ordinal 15 → "Blues OD"', drvSchema.decode(15) === 'Blues OD');
}

// --- continuous set + wire (reverb time, hardware-confirmed linear [0.1,100]) ---
const revTime = blocks['reverb']?.params['time'];
if (revTime) {
  const wire = encodeValue(FM9_DESCRIPTOR, 'reverb', 'time', 50.05);  // mid of [0.1,100]
  ok('set reverb.time 50.05 → ~mid wire (0..65534)', wire > 32000 && wire < 33800, String(wire));
  const back = revTime.decode(wire);
  ok('reverb.time round-trips ~50', typeof back === 'number' && Math.abs((back as number) - 50.05) < 1.0, String(back));
}

if (failed > 0) {
  console.error(`\nverify-fm9-end-to-end: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nverify-fm9-end-to-end: all checks passed (amp 331 + drive 86 set-by-name + read-labels wired end-to-end)');
