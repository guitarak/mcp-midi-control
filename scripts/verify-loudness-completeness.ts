/**
 * P4a gated test: loudness corpus completeness (Scene-too-loud class).
 *
 * Failure class this guards: `lookup_lineage` names an amp model, the
 * agent reaches for it to build a scene, but the loudness corpus has no
 * leveling data for it. The agent then guesses the master / level and the
 * scene lands much louder (or quieter) than the others. This is the
 * "Scene-too-loud" trap.
 *
 * Property asserted (real, bidirectional, non-tautological):
 *
 *   1. Forward (completeness). Enumerate EVERY amp model name the Axe-Fx
 *      II lineage corpus can return from a `lookup_lineage` call. For each,
 *      run the SAME production accessor the lineage formatter uses
 *      (`formatLoudnessAppendix(am4Name ?? axefx2Name)`) and require it to
 *      emit a loudness line, OR require the name to be on the explicit
 *      OMISSION_ALLOWLIST below. A corpus amp that is neither covered nor
 *      allowlisted FAILS the gate.
 *
 *   2. Reverse (no stale allowlist). Every entry on the allowlist must
 *      actually be a corpus-nameable amp that STILL lacks loudness data.
 *      If loudness data is later added for an allowlisted amp, the stale
 *      allowlist entry FAILS the gate so the omission record stays honest.
 *
 * The allowlist is the documented coverage boundary, not a wishlist. The
 * loudness corpus is a hand-curated +/- 3 dB leveling table
 * (packages/core/.../lineage/loudness.json), deliberately scoped to a
 * subset of the ~259 extracted II amp lineage records. Pinning the exact
 * uncovered set here means any NEW amp record (or any amp that changes its
 * cross-device name) trips the gate until someone consciously either adds
 * loudness data or extends this allowlist with a reason. That forced
 * triage on every corpus change is the Scene-too-loud guard.
 *
 * Corpus + accessor locations (studied from verify-loudness-lookup.ts and
 * verify-lineage-resources.ts):
 *   - loudness accessor: @mcp-midi-control/core/fractal-shared/loudness.js
 *     (formatLoudnessAppendix is the exact path the II lineage formatter
 *     calls; see packages/fractal-gen2/src/lineageLookup.ts).
 *   - II amp lineage records: loaded via loadAxeFxIILineage('amp') from
 *     @mcp-midi-control/fractal-gen2/lineageLookup.js. These ARE the names
 *     lookup_lineage can return (forward / reverse / structured all draw
 *     from this same record set).
 *
 * Run: npx tsx scripts/verify-loudness-completeness.ts
 * (run `npm run build` first; imports resolve from built workspace dist.)
 */

import { formatLoudnessAppendix } from '@mcp-midi-control/core/fractal-shared/loudness.js';
import {
  loadAxeFxIILineage,
  type AxeFxIILineageRecord,
} from '@mcp-midi-control/fractal-gen2/lineageLookup.js';

let failed = 0;
let passed = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  OK    ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `. ${detail}` : ''}`);
  }
}

/**
 * The cross-device key the loudness accessor is fed by the lineage
 * formatter: AM4 display name when present, else the II display name.
 * Mirrors packages/fractal-gen2/src/lineageLookup.ts formatAxeFxIILineageRecord.
 */
function loudnessKeyFor(rec: AxeFxIILineageRecord): string {
  return rec.am4Name && rec.am4Name.length > 0 ? rec.am4Name : rec.axefx2Name;
}

/**
 * EXPLICIT OMISSION ALLOWLIST (documented boundary, not a wishlist).
 *
 * These amp model names ARE returnable by lookup_lineage but have no
 * entry in the hand-curated loudness corpus. The corpus targets the
 * commonly-used clean / crunch / lead platforms; the names below are
 * mostly deep-cut channel variants, boutique one-offs, bass amps, and
 * FAS-internal voicings that the leveling table does not yet cover.
 *
 * Adding a NEW amp to the lineage corpus will (correctly) fail this gate
 * until you either add loudness data for it or add it here with intent.
 * Removing loudness data for a covered amp will also fail until you add
 * it here. Keep this list sorted and exact: it is the asserted contract.
 */
const OMISSION_ALLOWLIST: readonly string[] = [
  '1959SLP Jumped',
  '1987X Jumped',
  '1987X Normal',
  '1987X Treble',
  '5153 100W Blue',
  '5153 100W Green',
  '5153 100W Red',
  '5153 50W Blue',
  '59 BASSGUY RI JUMPED',
  '5F1 Tweed EC Champlifier',
  '5F8 Tweed Bright',
  '65 Bassguy Bass',
  '65 Bassguy Normal',
  '6G12 Concert',
  '6G4 Super',
  'AC-20 12AX7 B',
  'AC-20 12AX7 T',
  'AC-20 EF86 B',
  'AC-20 EF86 T',
  'ANGLE SEVERE 1',
  'ANGLE SEVERE 2',
  'Atomica High',
  'Atomica Low',
  'Band-Commander',
  'Big Hair',
  'BLANKNSHP LEEDS',
  'Bludojai Clean',
  'BLUDOJAI LD 2',
  'BLUDOJAI LEAD PAB',
  'Bogfish Brown',
  'Bogfish Strato',
  'BOUTIQUE 1',
  'BOUTIQUE 2',
  'BRIT 800 #34',
  'Brit 800 Mod',
  'Brit AFS100 1',
  'Brit AFS100 2',
  'Brit Brown',
  'Brit JM45 Jumped',
  'BRIT JVM OD1 GREEN',
  'BRIT JVM OD1 RED',
  'BRIT JVM OD2 GREEN',
  'BRIT JVM OD2 ORANGE',
  'BRIT JVM OD2 RED',
  'BRIT PRE',
  'BUTTERY',
  'CA OD-2',
  'CA TRIPTIK CLN',
  'CA TRIPTIK CLSC',
  'CA TRIPTIK MDRN',
  'CA TUCANA CLN',
  'CA TUCANA LEAD',
  'CA3+ Clean',
  'CA3+ Lead',
  'CA3+ Rhythm',
  'CALI LEGGY',
  'CAMERON CCV 1A',
  'CAMERON CCV 1B',
  'CAMERON CCV 2A',
  'CAMERON CCV 2B',
  'CAMERON CCV 2C',
  'CAMERON CCV 2D',
  'CAPT HOOK 1A',
  'CAPT HOOK 1B',
  'CAPT HOOK 2A',
  'CAPT HOOK 2B',
  'CAPT HOOK 3A',
  'CAPT HOOK 3B',
  'CAR ROAMER',
  'CITRUS A30 DRTY',
  'Citrus Bass 200',
  'Class-A 30W Bright',
  'Class-A 30W Hot',
  'Comet 60',
  'Comet Concourse',
  'CORNCOB M50',
  'Das Metall',
  'Deluxe Verb Normal',
  'Dirty Shirley 2',
  'Div/13 CJ',
  'DIV/13 CJ BOOST',
  'DIV/13 FT37 HIGH',
  'DIV/13 FT37 LOW',
  'DIZZY V4 BLUE 3',
  'DIZZY V4 BLUE 4',
  'Dizzy V4 Silver 2',
  'Dizzy V4 Silver 3',
  'Dizzy V4 Silver 4',
  'DOUBLE VERB SF',
  "DWEEZIL'S B-MAN",
  'Euro Blue',
  'EURO BLUE MODERN',
  'EURO RED MODERN',
  'FAS Bass',
  'FAS Brootalz',
  'FAS Brown',
  'FAS Class-A',
  'FAS Crunch',
  'FAS Hot Rod',
  'FAS Lead 1',
  'FAS Lead 2',
  'FAS Modern',
  'FAS Modern II',
  'FAS Modern III',
  'FAS Rhythm',
  'FAS Wreck',
  'Fox ODS',
  'FOX ODS DEEP',
  'FRIEDMAN BE V1',
  'FRIEDMAN BE V1 FAT',
  'FRIEDMAN HBE V1',
  'FRIEDMAN HBE V1 FAT',
  'FRYETTE D60 L',
  'FRYETTE D60 M',
  'Gibtone Scout',
  'Herbie CH2-',
  'Herbie CH2+',
  'Herbie CH3',
  'HIPOWER BRILLNT',
  'Hipower Jumped',
  'Hot Kitty',
  'Jazz 120',
  'JMPre-1 OD1',
  'JMPRE-1 OD1 BS',
  'JMPre-1 OD2',
  'JMPRE-1 OD2 BS',
  'JR Blues',
  'JR BLUES FAT',
  'JS410 CRUNCH ORANGE',
  'JS410 CRUNCH RED',
  'JS410 LEAD ORANGE',
  'JS410 LEAD RED',
  'LEGATO 100',
  'Matchbox D-30',
  'MR Z HWY 66',
  'Mr Z MZ-38',
  'Mr Z MZ-8',
  'Nuclear-Tone',
  'ODS-100 Clean',
  'ODS-100 FORD 1',
  'ODS-100 FORD 2',
  'ODS-100 FORD MD',
  'ODS-100 HRM',
  'ODS-100 HRM MID',
  'Plexi 100W 1970',
  'Plexi 100W Jumped',
  'Plexi 100W Normal',
  'Plexi 50W 6550',
  'Plexi 50W High 1',
  'Plexi 50W High 2',
  'Plexi 50W Jumped',
  'PRINCE TONE',
  'PRINCE TONE NR',
  'PRINCE TONE REV',
  'PVH 6160 BLOCK',
  'PVH 6160+ RHY',
  'PVH 6160+ RHY B',
  'Recto1 Orange Modern',
  'RECTO1 ORG VNTG',
  'Recto1 Red',
  'Recto2 Orange Vintage',
  'Recto2 Red Vintage',
  'Ruby Rocket',
  'RUBY ROCKET BRIGHT',
  'Shiver Clean',
  'Shiver Lead',
  'Solo 100 Clean',
  'Solo 100 Rhythm',
  'Solo 88 Clean',
  'Solo 88 Lead',
  'Solo 88 Rhythm',
  'Solo 99 Clean',
  'Solo 99 Lead',
  'Spawn Nitrous 1',
  'Spawn Nitrous 2',
  'SPAWN ROD OD1-1',
  'SPAWN ROD OD1-2',
  'SPAWN ROD OD1-3',
  'SPAWN ROD OD2-1',
  'SPAWN ROD OD2-2',
  'SPAWN ROD OD2-3',
  'Suhr Badger 18',
  'Suhr Badger 30',
  'Super Verb Normal',
  'Super Verb Vibrato',
  'Supremo Trem',
  'SV Bass 1',
  'Texas Star Clean',
  'Texas Star Lead',
  'THORDENDAL MODERN',
  'THORDENDAL VINT',
  'Tremolo Lux',
  'Tube Pre',
  'TWO STONE J35 1',
  'TWO STONE J35 2',
  'USA BASS 400 1',
  'USA BASS 400 2',
  'USA CLEAN',
  'USA IIC+ BRT/DP',
  'USA LEAD',
  'USA LEAD +',
  'USA LEAD BRT',
  'USA LEAD BRT +',
  'USA MK IIC+ BRIGHT',
  'USA MK IIC+ DEEP',
  'USA MK IIC++',
  'USA Pre LD1 Red',
  'USA PRE LD2 GRN',
  'USA Pre LD2 Red',
  'USA Pre LD2 Yellow',
  'USA RHYTHM',
  'USA SUB BLUES',
  'Vibra-King',
  'VIBRA-KING FAT',
  'Vibrato Lux',
  'VIBRATO VERB',
  'Vibrato Verb AA',
  'Vibrato Verb AB',
  'VIBRATO VERB CS',
  'Wrecker Express',
  'Wrecker Liverpool',
  'Wrecker Rocket',
];

const allowSet = new Set(OMISSION_ALLOWLIST.map((n) => n.trim().toLowerCase()));

console.log('Loading Axe-Fx II amp lineage corpus (lookup_lineage source)');
const ampRecords = loadAxeFxIILineage('amp');

// Sanity: the corpus must be non-trivially populated, otherwise the
// completeness loop below would vacuously pass.
check(
  `amp lineage corpus is non-empty, got ${ampRecords.length} records`,
  ampRecords.length > 50,
  ampRecords.length <= 50 ? 'corpus too small; loudness table did not load or lineage data is missing' : undefined,
);

// Sanity: the loudness accessor itself resolves the corpus reference amp.
// If this fails, formatLoudnessAppendix returns '' for everything and the
// completeness check would be a false-green (every amp "missing" but all
// allowlisted). This pins the accessor as live before we trust it.
check(
  'loudness accessor live: reference amp "Double Verb Normal" emits a loudness line',
  formatLoudnessAppendix('Double Verb Normal').includes('relative_loudness_dB'),
  'formatLoudnessAppendix returned no loudness for the corpus reference amp; loudness.json failed to load',
);

// ── Forward completeness ────────────────────────────────────────────
console.log('\nForward completeness: every corpus amp has loudness OR is allowlisted');
const uncoveredAndUnlisted: string[] = [];
const coveredCount = { n: 0 };
const allowedHitNames = new Set<string>();

for (const rec of ampRecords) {
  const namedKey = loudnessKeyFor(rec);
  const hasLoudness = formatLoudnessAppendix(namedKey).length > 0;
  if (hasLoudness) {
    coveredCount.n++;
    continue;
  }
  if (allowSet.has(namedKey.trim().toLowerCase())) {
    allowedHitNames.add(namedKey.trim().toLowerCase());
    continue;
  }
  uncoveredAndUnlisted.push(namedKey);
}

check(
  `every corpus amp is covered or allowlisted (covered=${coveredCount.n}, allowlisted-hit=${allowedHitNames.size})`,
  uncoveredAndUnlisted.length === 0,
  uncoveredAndUnlisted.length === 0
    ? undefined
    : `${uncoveredAndUnlisted.length} amp(s) returnable by lookup_lineage have NO loudness entry and are NOT allowlisted ` +
      `(Scene-too-loud risk). Add loudness data to packages/core/src/fractal-shared/lineage/loudness.json ` +
      `OR add to OMISSION_ALLOWLIST with a reason: [${uncoveredAndUnlisted.slice(0, 25).join(', ')}` +
      `${uncoveredAndUnlisted.length > 25 ? `, ...+${uncoveredAndUnlisted.length - 25} more` : ''}]`,
);

// ── Reverse: no stale allowlist entries ─────────────────────────────
// Every allowlist entry must (a) be a name the corpus actually returns
// and (b) still lack loudness. A stale entry means either the amp was
// removed from the corpus or loudness data was added; in both cases the
// allowlist must shrink so the omission record stays truthful.
console.log('\nReverse: allowlist has no stale entries');
const corpusNamedKeys = new Set(ampRecords.map((r) => loudnessKeyFor(r).trim().toLowerCase()));

const staleNotInCorpus: string[] = [];
const staleNowCovered: string[] = [];
for (const name of OMISSION_ALLOWLIST) {
  const key = name.trim().toLowerCase();
  if (!corpusNamedKeys.has(key)) {
    staleNotInCorpus.push(name);
    continue;
  }
  if (formatLoudnessAppendix(name).length > 0) {
    staleNowCovered.push(name);
  }
}

check(
  `every allowlist entry is still a corpus-nameable amp (${OMISSION_ALLOWLIST.length} entries)`,
  staleNotInCorpus.length === 0,
  staleNotInCorpus.length === 0
    ? undefined
    : `${staleNotInCorpus.length} allowlist entry/entries no longer appear in the lineage corpus; remove them: [${staleNotInCorpus.join(', ')}]`,
);

check(
  'no allowlist entry has since gained loudness data (stale allowlisting)',
  staleNowCovered.length === 0,
  staleNowCovered.length === 0
    ? undefined
    : `${staleNowCovered.length} allowlist entry/entries now HAVE loudness data; remove from OMISSION_ALLOWLIST: [${staleNowCovered.join(', ')}]`,
);

// Allowlist hygiene: no duplicate entries (a dup would mask a real miss).
check(
  'allowlist has no duplicate entries',
  allowSet.size === OMISSION_ALLOWLIST.length,
  allowSet.size === OMISSION_ALLOWLIST.length
    ? undefined
    : `allowlist has ${OMISSION_ALLOWLIST.length - allowSet.size} duplicate name(s)`,
);

console.log(
  `\n${failed === 0 ? 'all cases pass' : `${failed} case(s) failed`}. ` +
    `(${passed} OK, ${failed} FAIL; ${ampRecords.length} amps scanned, ${coveredCount.n} covered, ${allowedHitNames.size} allowlisted)`,
);
if (failed > 0) process.exit(1);
