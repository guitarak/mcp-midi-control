#!/usr/bin/env tsx
/**
 * P4c-enum-completeness: Axe-Fx II enum-registration completeness gate.
 *
 * Goal: a param the device exposes as a select / enum must NOT silently
 * ship as a non-enum (controlType 'unknown' or 'knob' with NO enumValues),
 * which would let the wire integer leak to the user as a raw number instead
 * of a named choice (e.g. drive-type "Triode" decoding to "3").
 *
 * Source of truth: a COMMITTED allowlist of (block, paramId, name) pairs
 * known to be selects. The committed dumps that could seed this list
 * (samples/captured/decoded/ii-amp-enum-dump.json, the Axe-Edit label
 * catalog) are gitignored and absent on a fresh clone, so this gate does
 * NOT depend on them. The allowlist below is the durable source of truth.
 *
 * Two tiers:
 *
 *   REQUIRED_ENUMS: already-registered selects. Each MUST resolve in
 *     KNOWN_PARAMS as controlType 'select' WITH a non-empty enumValues
 *     table. These are the positive controls: if a future regen drops the
 *     enumValues off amp.tone_stack, or flips it back to 'unknown', this
 *     gate goes red. A FAIL here means a real enum regressed.
 *
 *   PENDING_ENUMS: the 4 undecoded amp deep-param enums (cliptype2 p18,
 *     drivetype p30, fbtype p37, version p82). The device exposes these as
 *     selects but their enum vocabularies are not yet decoded, so they ship
 *     NOT-yet-a-proper-select. While each is still in its unregistered shape
 *     this gate emits a WARNING (not a hard fail) so the build stays green
 *     until registration lands. Two ways a pending entry turns into a hard
 *     FAIL:
 *       (a) Partial registration: controlType became 'select' but
 *           enumValues is still missing / empty (a half-done registration
 *           that WOULD leak, exactly the bug this gate guards), OR the
 *           reverse (enumValues present but controlType not 'select').
 *       (b) Deadline: after PENDING_DEADLINE the warning flips to a fail so
 *           "pending" cannot quietly become "forgotten."
 *
 * Run: npx tsx scripts/verify-enum-completeness.ts
 * Status: offline, no hardware, no MIDI.
 */

import { KNOWN_PARAMS } from 'fractal-midi/axe-fx-ii';

// ── Tunables ─────────────────────────────────────────────────────────

// After this date a still-unregistered PENDING_ENUMS entry becomes a hard
// FAIL instead of a warning. Keeps "pending registration" honest: the gate
// will not let the 4 amp deep-param enums drift forever as raw-wire leaks.
const PENDING_DEADLINE = new Date('2026-08-31T00:00:00Z');

// ── Committed source-of-truth allowlist ─────────────────────────────
//
// (block, paramId) pairs the Axe-Fx II device exposes as a select / enum.
// paramId is the load-bearing identity (the registry key uses the snake
// name, which can be renamed; paramId is the wire address and does not
// move). `name` is carried for human-readable failure messages only.

interface EnumExpectation {
  readonly block: string;
  readonly paramId: number;
  readonly name: string;
}

// Already-registered selects. Positive controls: these MUST be select +
// non-empty enumValues right now. A failure here is a genuine regression.
const REQUIRED_ENUMS: readonly EnumExpectation[] = [
  { block: 'amp', paramId: 0, name: 'effect_type' },     // AMP_EFFECT_TYPE_VALUES
  { block: 'amp', paramId: 14, name: 'tone_location' },  // AMP_TONE_LOCATION_VALUES
  { block: 'amp', paramId: 15, name: 'input_select' },   // AMP_INPUT_SELECT_VALUES
  { block: 'amp', paramId: 23, name: 'bypass_mode' },    // AMP_BYPASS_MODE_VALUES
  { block: 'amp', paramId: 34, name: 'tone_stack' },     // AMP_TONE_STACK_VALUES
  // Promoted from PENDING_ENUMS 2026-05-29 — the 4 amp deep-param enums,
  // decoded via fn 0x28 SYSEX_GET_PARAM_STRINGS on the XL+ (Q8.02) and
  // registered as selects with hardware-dumped vocabularies in params.ts
  // (AMP_CLIPTYPE2/DRIVETYPE/FBTYPE/VERSION_VALUES). Now hard positive
  // controls: a regen that drops their enumValues fails this gate.
  { block: 'amp', paramId: 18, name: 'cliptype2' },      // AMP_CLIPTYPE2_VALUES
  { block: 'amp', paramId: 30, name: 'drivetype' },      // AMP_DRIVETYPE_VALUES
  { block: 'amp', paramId: 37, name: 'fbtype' },         // AMP_FBTYPE_VALUES
  { block: 'amp', paramId: 82, name: 'version' },        // AMP_VERSION_VALUES
];

// The 4 undecoded amp deep-param enums. The device exposes each as a
// select but the enum vocabulary is not yet decoded, so each currently
// ships NOT-yet-a-proper-select (cliptype2/drivetype/fbtype as 'unknown',
// version as 'knob'). Each is a WARNING until registered, subject to the
// deadline + partial-registration fail rules above.
//
// All previously-pending amp deep-param enums (cliptype2 p18, drivetype
// p30, fbtype p37, version p82) were decoded via fn 0x28 and registered
// 2026-05-29; they now live in REQUIRED_ENUMS as hard positive controls.
// This list is intentionally empty — it stays as the documented home for
// the next "device exposes a select we haven't decoded yet" entry, with
// the warning/deadline machinery below ready to use.
const PENDING_ENUMS: readonly EnumExpectation[] = [];

// ── Param-table view ────────────────────────────────────────────────

type ParamEntry = {
  block: string;
  paramId: number;
  name: string;
  controlType: string;
  enumValues?: Readonly<Record<number, string>>;
};

const ALL_PARAMS: ParamEntry[] = Object.values(
  KNOWN_PARAMS as Record<string, ParamEntry>,
);

function findParam(block: string, paramId: number): ParamEntry | undefined {
  return ALL_PARAMS.find((p) => p.block === block && p.paramId === paramId);
}

function enumCount(p: ParamEntry | undefined): number {
  if (!p || !p.enumValues) return 0;
  return Object.keys(p.enumValues).length;
}

function isProperSelect(p: ParamEntry | undefined): boolean {
  return p !== undefined && p.controlType === 'select' && enumCount(p) > 0;
}

// ── Harness ─────────────────────────────────────────────────────────

let failed = 0;
let passed = 0;
let warned = 0;

function pass(label: string): void {
  passed++;
  console.log(`  OK    ${label}`);
}

function fail(label: string, detail?: string): void {
  failed++;
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
}

function warn(label: string, detail?: string): void {
  warned++;
  console.warn(`  WARN  ${label}${detail ? `\n        ${detail}` : ''}`);
}

// ── Sanity: the allowlist names real params ─────────────────────────
//
// Guards the gate itself against rot. If a paramId in the allowlist no
// longer exists in KNOWN_PARAMS (block split, renumber), the assertions
// below would silently pass on `undefined`. Catch that here.

console.log('Allowlist integrity (every listed paramId exists in KNOWN_PARAMS):');
for (const e of [...REQUIRED_ENUMS, ...PENDING_ENUMS]) {
  const p = findParam(e.block, e.paramId);
  if (p === undefined) {
    fail(
      `${e.block}.${e.name} (p${e.paramId}) is present in KNOWN_PARAMS`,
      'allowlist references a paramId that no longer exists; update the allowlist',
    );
  } else {
    pass(`${e.block}.${e.name} (p${e.paramId}) present as "${p.name}"`);
  }
}

// ── REQUIRED: registered selects must stay proper selects ───────────

console.log('\nRequired enums (must be controlType select + non-empty enumValues):');
for (const e of REQUIRED_ENUMS) {
  const p = findParam(e.block, e.paramId);
  if (isProperSelect(p)) {
    pass(`${e.block}.${e.name} (p${e.paramId}) is select with ${enumCount(p)} values`);
  } else {
    fail(
      `${e.block}.${e.name} (p${e.paramId}) is select with non-empty enumValues`,
      `controlType=${p?.controlType ?? '<missing>'}, enumValues=${enumCount(p)} entries ` +
        '(a registered enum regressed to raw-wire; the user would see a number, not a name)',
    );
  }
}

// ── PENDING: undecoded amp deep-param enums ─────────────────────────

console.log('\nPending enums (undecoded amp deep-param selects):');
const pastDeadline = Date.now() >= PENDING_DEADLINE.getTime();

for (const e of PENDING_ENUMS) {
  const p = findParam(e.block, e.paramId);
  const proper = isProperSelect(p);
  const ct = p?.controlType ?? '<missing>';
  const n = enumCount(p);

  if (proper) {
    // Registration landed. Treat as a pass and remind the maintainer to
    // promote it to REQUIRED_ENUMS so it becomes a permanent positive
    // control instead of staying on the lenient pending tier.
    pass(
      `${e.block}.${e.name} (p${e.paramId}) is now registered (select, ${n} values) ` +
        ', promote it from PENDING_ENUMS to REQUIRED_ENUMS',
    );
    continue;
  }

  // Partial / inconsistent registration is ALWAYS a hard fail: either the
  // controlType flipped to select with no enumValues (would leak), or
  // enumValues were attached without setting controlType to select.
  const partial =
    (ct === 'select' && n === 0) || (ct !== 'select' && n > 0);
  if (partial) {
    fail(
      `${e.block}.${e.name} (p${e.paramId}) is half-registered`,
      `controlType=${ct}, enumValues=${n} entries. Finish registration ` +
        '(select REQUIRES a non-empty enumValues table or it leaks raw wire)',
    );
    continue;
  }

  // Clean unregistered state (e.g. controlType 'unknown'/'knob', no
  // enumValues). Warning, unless we are past the deadline.
  const detail =
    `controlType=${ct}, enumValues=${n} entries, enum vocabulary not yet decoded`;
  if (pastDeadline) {
    fail(
      `${e.block}.${e.name} (p${e.paramId}) STILL unregistered past ${PENDING_DEADLINE.toISOString().slice(0, 10)}`,
      detail + ' (pending deadline elapsed: decode + register, or extend PENDING_DEADLINE with justification)',
    );
  } else {
    warn(
      `${e.block}.${e.name} (p${e.paramId}) pending enum registration`,
      detail + ` (warning until ${PENDING_DEADLINE.toISOString().slice(0, 10)})`,
    );
  }
}

// ── Report ──────────────────────────────────────────────────────────

console.log(
  `\nverify-enum-completeness: ${passed} passed, ${warned} warning(s), ${failed} failure(s).`,
);
if (warned > 0 && failed === 0) {
  console.log(
    'Gate is GREEN with pending warnings. The 4 amp deep-param enums ' +
      '(cliptype2, drivetype, fbtype, version) are NOT yet registered as ' +
      'selects; registration is still pending. See TODO(enum-registration).',
  );
}
process.exit(failed === 0 ? 0 : 1);
