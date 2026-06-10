/**
 * Cross-device enum coverage gate — gen-3 (III / FM3 / FM9) column.
 *
 * The `CROSS_DEVICE_ENUMS` concept table (packages/core/src/protocol-generic/
 * cross-device-enums.ts) maps one amp/drive/reverb model across AM4, Axe-Fx II,
 * and the gen-3 family. `translate_preset` and the apply_preset enum-alias
 * resolver read the `axeFxIII` column for `axe-fx-iii` / `fm3` / `fm9` ports.
 *
 * This gate enforces that every populated `axeFxIII` value is a REAL gen-3
 * enum label, so a translation can't emit a model name the device doesn't
 * carry (the "silent wrong model" risk). It also enforces the deliberate
 * capture-blocked boundary: families with no device-true gen-3 vocabulary
 * (amp, and any block not listed below) MUST keep `axeFxIII: null` until a
 * getBlockString roster sweep binds their names. A non-null value there is a
 * FAILURE — it would be unvalidated and unwritable (numeric passthrough).
 *
 * Validated vocabularies (per the 2026-06-03 FM9 capture, fw 11.00):
 *   - reverb.type → AM4 REVERB_TYPES (BYTE-ANCHORED: gen-3 ordinals 1/16/45
 *     confirmed == REVERB_TYPES). High confidence.
 *   - drive.type  → AM4 DRIVE_TYPES (2 capture points — ordinals 15/36 —
 *     match DRIVE_TYPES; the gen-3 drive/fuzz selector reuses the table at
 *     observed ordinals). Medium confidence.
 *
 * Capture-blocked (must stay null):
 *   - amp.type → gen-3 amp ordinals exceed AM4 AMP_TYPES and the names
 *     disagree (FM9 has its own larger roster). Needs a getBlockString
 *     amp-roster sweep before any value is trustworthy.
 *
 * Also asserts the resolver round-trips: an AM4 / II model name resolves to
 * the gen-3 canonical string for a gen-3 port.
 *
 * Run: `npx tsx scripts/verify-enum-coverage.ts`
 * Status: offline, pure-data, no hardware required.
 */

import {
  CROSS_DEVICE_ENUMS,
  resolveEnumAlias,
  type CrossDeviceEnumRow,
} from '../packages/core/src/protocol-generic/cross-device-enums.js';
import { TYPE_BINARY_IDS } from '@mcp-midi-control/fractal-modern/gen3BodyTables.js';

// Per-block gen-3 enum vocabulary, validated against the DEVICE-TRUE roster
// (fractal-modern TYPE_BINARY_IDS — the file-stored names the decoder emits,
// byte-validated across 384 III factory presets and corroborated by FM9
// hardware SET echoes). This is the authority: the prior gate validated gen-3
// names against AM4's REVERB_TYPES/DRIVE_TYPES (comma form), which let a
// wrong-form axeFxIII value ("Room, Small" vs the device's "Small Room") pass.
// A block ABSENT here is capture-blocked and must keep axeFxIII null.
const GEN3_VOCAB: Readonly<Record<string, ReadonlySet<string>>> = {
  reverb: new Set(Object.values(TYPE_BINARY_IDS.Reverb)),
  drive: new Set(Object.values(TYPE_BINARY_IDS.Drive)),
};

let failures = 0;
let populated = 0;
let deferred = 0;
function fail(msg: string): void {
  failures++;
  console.log(`  ✗ FAIL — ${msg}`);
}

function main(): void {
  for (const [conceptKey, row] of Object.entries(CROSS_DEVICE_ENUMS) as [string, CrossDeviceEnumRow][]) {
    const vocab = GEN3_VOCAB[row.block];

    if (row.axeFxIII === null) {
      deferred++;
      // Capture-blocked families SHOULD be null — nothing to assert.
      continue;
    }

    populated++;

    // A populated value in a block with no validated gen-3 vocabulary is a
    // hard failure: it can't be validated and shouldn't have been added.
    if (vocab === undefined) {
      fail(
        `"${conceptKey}" (block="${row.block}") has axeFxIII="${row.axeFxIII}" but ${row.block} has ` +
        `no validated gen-3 vocabulary — it is capture-blocked and must stay null until a ` +
        `getBlockString roster sweep binds its names.`,
      );
      continue;
    }

    // Populated value MUST be a real member of the gen-3 vocabulary.
    if (!vocab.has(row.axeFxIII)) {
      fail(
        `"${conceptKey}" axeFxIII="${row.axeFxIII}" is not a member of the gen-3 ${row.block} ` +
        `vocabulary (likely a typo or a name gen-3 doesn't carry).`,
      );
      continue;
    }

    // Resolver round-trip: the AM4 name (and the II name) must resolve to the
    // gen-3 canonical string for every gen-3 port.
    for (const port of ['axe-fx-iii', 'fm3', 'fm9']) {
      for (const sourceName of [row.am4, row.axeFxII]) {
        if (sourceName === null) continue;
        const resolved = resolveEnumAlias(port, row.block, row.paramName, sourceName);
        if (resolved.canonical !== row.axeFxIII) {
          fail(
            `resolveEnumAlias(${port}, ${row.block}, ${row.paramName}, "${sourceName}") returned ` +
            `"${resolved.canonical}", expected "${row.axeFxIII}".`,
          );
        }
      }
    }
  }

  // Guard: amp rows are the bulk of the table and the highest misroute risk.
  // Assert NONE are populated (capture-blocked invariant). If a future
  // contributor binds the amp roster, they update GEN3_VOCAB + this guard
  // together, deliberately.
  const ampRows = Object.values(CROSS_DEVICE_ENUMS).filter((r) => r.block === 'amp');
  const ampPopulated = ampRows.filter((r) => r.axeFxIII !== null);
  if (ampPopulated.length > 0) {
    fail(
      `${ampPopulated.length} amp row(s) have a non-null axeFxIII, but gen-3 amp names are ` +
      `capture-blocked (no device-true roster). Keep amp axeFxIII null until the getBlockString ` +
      `amp-roster sweep lands, then add 'amp' to GEN3_VOCAB.`,
    );
  }

  console.log('');
  console.log(`────────────────────────────────────────`);
  console.log(`gen-3 enum column: ${populated} populated (validated), ${deferred} deferred (null).`);
  console.log(failures === 0 ? 'verify-enum-coverage: all checks passed' : `${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
