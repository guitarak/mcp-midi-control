/**
 * FM9 device-true enum overrides (read-leg {broadcast ordinal -> name}).
 *
 * The gen-3 family shares one effect codec, but the amp model roster (the
 * DISTORT block's type selector) is device-specific: FM9 amp ordinals do NOT
 * match the III/FM3 or AM4 tables, so the family-shared overlay deliberately
 * leaves DISTORT_TYPE numeric. These points were captured from real FM9
 * hardware (fw 11.00) and verified: each label was read off the
 * `fn=0x1F -> 0x75` block bulk-read (record[paramId]) while the matching
 * `fn=0x01 sub=0x1a` poll reported the same current-value name, and the names
 * match the tester's own notes. See
 * `docs/_private/FM9-CAPTURE-RECEIVE+SWEEP-2026-06-04.md` and the cookbook
 * entry `gen3-enum-label-septet-stream`.
 *
 * PARTIAL by construction: only the amp models the tester actually selected
 * are bound. The catalog's decode labels these ordinals and passes every
 * other ordinal through as a raw number; it never fabricates a name. The full
 * roster needs a Type-dropdown capture (or an editor-binary roster mine).
 *
 * READ-LEG ONLY. These are broadcast ordinals, NOT the typed-SET raw enum id
 * (a different number for the same name), so set-by-name stays gated. Do not
 * reuse an ordinal here as a SET value.
 */
export const FM9_ENUM_OVERRIDES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  // DISTORT block = the gen-3 AMP (effect id 58), paramId 10 = amp model.
  DISTORT_TYPE: {
    65: 'SV Bass 2',
    179: 'Texas Star Clean',
    264: 'SV Bass 1',
  },

  // DISTORT block, paramId 43 = voicing selector. Ordinals from the
  // fn=0x1F->0x75 block bulk-read + sub=0x1a current-value label poll,
  // FM9 hw fw 11.00. READ-LEG ONLY (broadcast ordinals, not SET raw-ids).
  // Source: FM9-CAPTURE-RECEIVE+SWEEP-2026-06-04.
  DISTORT_FBTYPE: {
    0: 'BASSGUY',
    39: 'TX STAR',
    53: 'FAS CLASSIC',
  },

  // FUZZ block = the gen-3 Drive/Fuzz pedal (effect id 118), paramId 0.
  // Ordinals from sub=0x09 SET echo (Blues OD, Drive TYPE change) and
  // fn=0x1F->0x75 block bulk-read (Blackglass 7K, appeared via re-poll).
  // FM9 hw fw 11.00. READ-LEG ONLY.
  // Blues OD: high confidence (byte-confirmed SET frame + cross-check).
  // Blackglass 7K: medium confidence (fn=0x1F re-poll only, no captured SET).
  // Source: FM9-CAPTURE3-DECODE-2026-06-03 + FM9-CAPTURE-RECEIVE+SWEEP-2026-06-04.
  FUZZ_TYPE: {
    15: 'Blues OD',
    36: 'Blackglass 7K',
  },

  // FILTER block (effect id 114), paramId 0.
  // Ordinal from sub=0x1a current-value label poll, hand-reproduced.
  // FM9 hw fw 11.00. READ-LEG ONLY.
  // Source: FM9-CAPTURE-RECEIVE+SWEEP-2026-06-04.
  FILTER_TYPE: {
    6: 'Peaking',
  },
};
