/**
 * Gen-3 enum set-by-name resolver (BK-093 write leg). SCAFFOLD.
 *
 * The gen-3 enum "two-leg" problem: the broadcast / GET wire carries an
 * ORDINAL index that joins to the enum vocabulary (the READ leg, fully
 * decoded offline via the enum overlay), but a TYPED SET wants a different
 * RAW enum id that has NOT been captured on any device. Until one FM9
 * `getBlockString` sweep maps ordinal → raw-id per enum param, set-by-name
 * stays gated (`enum_display_only` in the catalog → the dispatcher refuses
 * a name-string value with `capability_not_supported`).
 *
 * This module is the DROP-IN SEAM for that capture. It resolves a name in
 * two hops:
 *
 *   name  ──(enum overlay, offline)──▶  ordinal  ──(capture-pending table)──▶  raw-id
 *
 * Today the second hop's table (`GEN3_ENUM_ORDINAL_TO_RAW_ID`) is EMPTY, so
 * every matched name resolves to `capture_pending` and NO untested wire byte
 * is ever produced; the gate is preserved exactly. When the getBlockString
 * sweep lands, populate the table (per param symbol: ordinal → raw-id) and
 * the resolver starts returning `resolved`. Wiring this into the catalog's
 * enum encode closure is then the single follow-up that unlocks the write
 * leg; emitting the resolved raw-id only ever happens for table-backed
 * (i.e. capture-verified) entries.
 *
 * Pure data + offline lookup. No MIDI I/O. Reverse-maps the same enum
 * vocabularies the READ leg uses, so a name the device labels on read is the
 * exact name accepted here.
 */

import { resolveEnumValues, resolveEffectTypeEnum } from './enumOverlay.js';

/**
 * Ordinal → raw-id map for one enum param, keyed by the firmware symbol name
 * (e.g. `REVERB_TYPE`). The inner key is the broadcast/GET ORDINAL (what the
 * READ leg decodes); the value is the RAW enum id a typed SET must carry.
 *
 * EMPTY until the FM9 `getBlockString` sweep populates it. Per-symbol, not
 * per-device: the gen-3 family shares one effect codec, so a symbol's
 * ordinal→raw-id mapping is expected to be shared (validate per device as
 * captures arrive; split by device only if a divergence is observed).
 */
export type Gen3EnumRawIdTable = Readonly<Record<string, Readonly<Record<number, number>>>>;

/**
 * Ordinal → raw-id table, populated per (symbol, ordinal) from FM9 hardware
 * captures. ONLY write-OBSERVED points belong here — each value below is a
 * raw enum id seen in a real FM9-Edit SET frame, so emitting it is a
 * hardware-confirmed write (never a guess). Names matched against AM4
 * REVERB_TYPES. An ordinal absent here resolves `capture_pending`, so its
 * set-by-name stays gated and no untested byte is emitted.
 *
 * Provenance (FM9 fw 11.00):
 *   - REVERB_TYPE ordinal 16 ("Spring, Medium") → 524: byte-EXACT in the
 *     capture-2 editor SET frame (`fm9-reverb-type-medroom-to-medspring`),
 *     equals buildSetParameter(effectId=66, paramId=10, value=524).
 *   - REVERB_TYPE ordinal 45 ("Hall, Music") → 529: write-observed in the
 *     capture-3 enum sweep (`fm9-capture3-enum-sweep`).
 * Drive/Fuzz (eff 118) raw point added: 523→ord 15 "Blues OD" — the
 * FUZZ_TYPE read-leg overlay (AM4 DRIVE_TYPES, byte-anchored at ordinal 15
 * and 36 from FM9 hw captures) now resolves the ordinal, so name→raw-id
 * resolves end-to-end for Blues OD.
 */
export const GEN3_ENUM_ORDINAL_TO_RAW_ID: Gen3EnumRawIdTable = Object.freeze({
  REVERB_TYPE: Object.freeze({ 16: 524, 45: 529 }),
  // FUZZ_TYPE = gen-3 drive/fuzz pedal type selector (eff=118, pid=0).
  // raw-id 523 for Blues OD: byte-exact from FM9 capture 3 (sub=0x09 SET frame
  // for effectId=118 paramId=0 value=523, echo confirmed name="Blues OD").
  // AM4 DRIVE_TYPES ordinal 15 = "Blues OD" — same label, byte-anchored.
  FUZZ_TYPE: Object.freeze({ 15: 523 }),
});

/** Resolution outcome for a name → raw-id lookup. */
export type Gen3EnumRawIdResolution =
  /** Name matched an ordinal AND the table has its raw-id: safe to SET. */
  | { status: 'resolved'; ordinal: number; rawId: number; matchedLabel: string }
  /** Name matched an ordinal but the raw-id table isn't populated yet: stay gated. */
  | { status: 'capture_pending'; ordinal: number; matchedLabel: string }
  /** The param has no enum vocabulary at all (not an enum param). */
  | { status: 'no_enum' }
  /** The name didn't match any label in this param's vocabulary. */
  | { status: 'unknown_name'; suggestions: readonly string[] };

/** Normalize an enum label for tolerant matching (case + whitespace). */
function normalizeLabel(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The normalized forms an enum label should match. The AM4 `cacheEnums` arrays
 * (the read-leg name source) use "Category, Modifier" order, e.g.
 * "Spring, Medium" / "Hall, Music"; natural phrasing reverses it,
 * "Medium Spring" / "Music Hall". We accept the canonical form, the
 * comma-stripped form, and (for single-comma labels) the comma-swapped form, so
 * either word order resolves. The caller tries exact match first, so this only
 * ever broadens, never overrides, a precise match.
 */
function enumLabelForms(s: string): Set<string> {
  const forms = new Set<string>();
  const n = normalizeLabel(s);
  forms.add(n);
  forms.add(normalizeLabel(n.replace(/,/g, ' ')));
  const ci = s.indexOf(',');
  if (ci >= 0 && s.indexOf(',', ci + 1) < 0) {
    forms.add(normalizeLabel(`${s.slice(ci + 1)} ${s.slice(0, ci)}`));
  }
  return forms;
}

/**
 * Look up the READ-leg enum vocabulary for a gen-3 param symbol. Prefers the
 * full overlay (the III, whose params are tagged `unit: 'enum'`); falls back
 * to the strict effect-type-only overlay (the FM3/FM9 device-true catalogs).
 * Returns the ordinal → label map, or undefined when the param is not an enum.
 */
function lookupVocabulary(paramSymbol: string): Readonly<Record<number, string>> | undefined {
  return (resolveEnumValues(paramSymbol) ?? resolveEffectTypeEnum(paramSymbol))?.values;
}

/**
 * Resolve an enum NAME to its broadcast/GET ORDINAL via the offline overlay.
 * Case/whitespace tolerant. Returns the ordinal + the canonical label it
 * matched, or undefined (with the available labels as suggestions) when no
 * label matches. Returns `noEnum: true` when the param carries no vocabulary.
 *
 * This is the fully-decoded half of the two-leg problem and is usable today
 * (e.g. for "did the user name a real value?" validation) independent of the
 * capture-pending raw-id table.
 */
export function resolveGen3EnumOrdinal(
  paramSymbol: string,
  name: string,
):
  | { noEnum: true }
  | { ordinal: number; matchedLabel: string }
  | { ordinal: undefined; suggestions: readonly string[] } {
  const vocab = lookupVocabulary(paramSymbol);
  if (vocab === undefined) return { noEnum: true };
  const target = normalizeLabel(name);
  const labels: string[] = [];
  // Pass 1: exact (case/whitespace) match — most precise, never ambiguous.
  for (const [ordStr, label] of Object.entries(vocab)) {
    labels.push(label);
    if (normalizeLabel(label) === target) {
      return { ordinal: Number(ordStr), matchedLabel: label };
    }
  }
  // Pass 2: category/modifier word-order tolerance (comma swap/strip), so
  // "Medium Spring" matches the array's canonical "Spring, Medium".
  const inputForms = enumLabelForms(name);
  for (const [ordStr, label] of Object.entries(vocab)) {
    const labelForms = enumLabelForms(label);
    for (const f of labelForms) {
      if (inputForms.has(f)) return { ordinal: Number(ordStr), matchedLabel: label };
    }
  }
  return { ordinal: undefined, suggestions: labels };
}

/**
 * Resolve an enum NAME to the RAW enum id a typed SET must carry, in two
 * hops (name → ordinal → raw-id). See the module header for the contract.
 *
 * Returns `capture_pending` (NOT an error) when the name is valid but the
 * raw-id table has no entry yet, so the dispatcher keeps the set-by-name gate
 * and emits nothing. Pass a populated `table` (defaults to the module's
 * capture-pending one) to exercise the resolved path in tests / once a
 * capture lands.
 */
export function resolveGen3EnumNameToRawId(
  paramSymbol: string,
  name: string,
  table: Gen3EnumRawIdTable = GEN3_ENUM_ORDINAL_TO_RAW_ID,
): Gen3EnumRawIdResolution {
  const ord = resolveGen3EnumOrdinal(paramSymbol, name);
  if ('noEnum' in ord) return { status: 'no_enum' };
  if (ord.ordinal === undefined) return { status: 'unknown_name', suggestions: ord.suggestions };
  const rawId = table[paramSymbol]?.[ord.ordinal];
  if (rawId === undefined) {
    return { status: 'capture_pending', ordinal: ord.ordinal, matchedLabel: ord.matchedLabel };
  }
  return { status: 'resolved', ordinal: ord.ordinal, rawId, matchedLabel: ord.matchedLabel };
}
