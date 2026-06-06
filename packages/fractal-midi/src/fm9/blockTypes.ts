/**
 * FM9 block-type catalog.
 *
 * Sources, in evidence order:
 *   1. **FM9-Edit BinaryData XML** (`__block_layout.xml` +
 *      `__amp_layout*.xml`, mined 2026-06-06 via
 *      `scripts/_research/mine-fm9edit-xml-labels.ts`; raw artifacts
 *      gitignored under samples/). The `<EditorControls name="...">`
 *      sections define which blocks FM9-Edit ships layouts for, and
 *      each section's parameterName prefixes bind the block to its
 *      catalog family.
 *   2. **Axe-Fx III v1.4 PDF Appendix 1 effect IDs** (family-shared;
 *      the FM9 foundation probe's STATUS_DUMP against real hardware
 *      returned IDs squarely in this ID space).
 *   3. **FM9 hardware STATUS_DUMP** (2026-06-06, preset 413): 23
 *      placed blocks decoded, corroborating the ID space and the
 *      family corrections below.
 *
 * ── THE BIG CORRECTION vs the Axe-Fx III package's mapping ─────────
 *
 * FM9-Edit's own layout files prove:
 *
 *   - The **AMP block's params are the `DISTORT` family** (all 122
 *     `DISTORT_*` parameterNames live in `__amp_layout*.xml`:
 *     DISTORT_TYPE, DISTORT_MASTER, DISTORT_PRESENCE, ...). So the
 *     v1.4 appendix's `ID_DISTORT` range (58..61) is the **Amp**
 *     block's effect-ID range. Hardware corroboration: preset 413
 *     STATUS_DUMP shows ID 58 active on channel B —
 *     the amp — while no other candidate amp ID exists in the dump.
 *   - The **DRIVE block's params are the `FUZZ` family** (the 42
 *     `FUZZ_*` parameterNames sit under the `Drive` EditorControls
 *     section). `ID_FUZZ` (118..121) is the **Drive** range.
 *     Hardware corroboration: 413's dump shows 118+119 placed,
 *     bypassed in the active scene (drives off in a solo scene).
 *
 * The III package maps DRV→DISTORT and leaves AMP family-less; that
 * mapping likely mis-binds on the III too (the III's own
 * `__amp_layout.xml` also carries DISTORT_* names — see the example
 * in `mine-axeedit3-xml-labels.ts`'s header). Fixing the III is out
 * of scope here; flagged for upstream.
 *
 * ── Open items (deferred, do NOT guess) ────────────────────────────
 *   - **Effects Loop** (FM9-specific block; FM9-Edit section
 *     `EffectsLoop`, zero params): no known effect ID. The 413
 *     STATUS_DUMP contains two otherwise-unmapped IDs, 200 and 201
 *     (channelCount=1). 200 collides with the III appendix's
 *     `ID_PRESET_FC`; 201 is beyond the appendix entirely. Candidate:
 *     FX Loop 1/2 in a live 4CM preset. Resolve via the FM9-Edit
 *     grid cross-check of preset 413, not by assumption.
 *   - **EQ Match** (FM9-Edit section `EQMatch`, zero params): the
 *     FM9's cousin of the III's Tone Match (TMA 170). No FM9
 *     corroboration for ID 170 → firstId null until verified.
 *   - Per-type instance MAXIMA on FM9 (how many of each block a
 *     preset may place) are not derivable from the XML; `instances`
 *     below describes the family-shared effect-ID RANGE, which is
 *     what ID→name resolution needs.
 */

/** Confidence tag for each catalog entry's `firstId`. */
export type ConfidenceTag =
  | 'iii-appendix-shared'    // ID from the III v1.4 Appendix 1 (family-shared ID space)
  | 'hardware-corroborated'  // additionally seen in an FM9 STATUS_DUMP capture
  | 'fm9-edit-asset'         // block exists per FM9-Edit assets; ID unconfirmed
  | 'pending';               // no ID source yet

export interface FM9Block {
  /** First-instance effect ID. `null` when no ID source exists yet. */
  firstId: number | null;
  /** Size of the family's effect-ID range (instance N = firstId + N - 1). */
  instances: number;
  /** Display name as shown in FM9-Edit. */
  name: string;
  /** Three-letter group code (kept parallel to the III catalog). */
  groupCode: string;
  /**
   * Param-catalog family symbol (`PARAMS_BY_FAMILY` key), bound via
   * FM9-Edit's per-section parameterName prefixes. `undefined` when
   * the block has no catalogued params (utility / paramless blocks).
   */
  family?: string;
  /** Confidence tag for this entry's `firstId`. */
  confidence: ConfidenceTag;
  /** False for blocks the third-party MIDI surface can't address. */
  addressable?: boolean;
}

export const FM9_BLOCKS: readonly FM9Block[] = [
  // Utilities + I/O
  { firstId: 2,    instances: 1, name: 'Controllers',          groupCode: 'CTR', family: 'CONTROLLERS', confidence: 'iii-appendix-shared', addressable: false },
  { firstId: 35,   instances: 1, name: 'Tuner',                groupCode: 'TUN',                        confidence: 'iii-appendix-shared' },
  { firstId: 36,   instances: 1, name: 'IR Capture',           groupCode: 'IRC',                        confidence: 'iii-appendix-shared' },
  { firstId: 37,   instances: 5, name: 'Input',                groupCode: 'IN',  family: 'INPUT',       confidence: 'hardware-corroborated' },
  { firstId: 42,   instances: 4, name: 'Output',               groupCode: 'OUT', family: 'OUTPUT',      confidence: 'hardware-corroborated' },

  // Signal-chain blocks
  { firstId: 46,   instances: 4, name: 'Compressor',           groupCode: 'CMP', family: 'COMP',        confidence: 'hardware-corroborated' },
  { firstId: 50,   instances: 4, name: 'Graphic EQ',           groupCode: 'GEQ', family: 'GEQ',         confidence: 'iii-appendix-shared' },
  { firstId: 54,   instances: 4, name: 'Parametric EQ',        groupCode: 'PEQ', family: 'PEQ',         confidence: 'hardware-corroborated' },
  // AMP = ID_DISTORT range + DISTORT family. See header.
  { firstId: 58,   instances: 4, name: 'Amp',                  groupCode: 'AMP', family: 'DISTORT',     confidence: 'hardware-corroborated' },
  { firstId: 62,   instances: 4, name: 'Cab',                  groupCode: 'CAB', family: 'CABINET',     confidence: 'hardware-corroborated' },
  { firstId: 66,   instances: 4, name: 'Reverb',               groupCode: 'REV', family: 'REVERB',      confidence: 'hardware-corroborated' },
  { firstId: 70,   instances: 4, name: 'Delay',                groupCode: 'DLY', family: 'DELAY',       confidence: 'hardware-corroborated' },
  { firstId: 74,   instances: 4, name: 'Multitap Delay',       groupCode: 'MTD', family: 'MULTITAP',    confidence: 'iii-appendix-shared' },
  { firstId: 78,   instances: 4, name: 'Chorus',               groupCode: 'CHO', family: 'CHORUS',      confidence: 'hardware-corroborated' },
  { firstId: 82,   instances: 4, name: 'Flanger',              groupCode: 'FLG', family: 'FLANGER',     confidence: 'iii-appendix-shared' },
  { firstId: 86,   instances: 4, name: 'Rotary',               groupCode: 'ROT', family: 'ROTARY',      confidence: 'iii-appendix-shared' },
  { firstId: 90,   instances: 4, name: 'Phaser',               groupCode: 'PHA', family: 'PHASER',      confidence: 'hardware-corroborated' },
  { firstId: 94,   instances: 4, name: 'Wah',                  groupCode: 'WAH', family: 'WAH',         confidence: 'hardware-corroborated' },
  { firstId: 98,   instances: 4, name: 'Formant',              groupCode: 'FRM', family: 'FORMANT',     confidence: 'iii-appendix-shared' },
  { firstId: 102,  instances: 4, name: 'Volume/Pan',           groupCode: 'VOL', family: 'VOLUME',      confidence: 'hardware-corroborated' },
  { firstId: 106,  instances: 4, name: 'Tremolo',              groupCode: 'PTR', family: 'TREMOLO',     confidence: 'hardware-corroborated' },
  { firstId: 110,  instances: 4, name: 'Pitch',                groupCode: 'PIT', family: 'PITCH',       confidence: 'iii-appendix-shared' },
  { firstId: 114,  instances: 4, name: 'Filter',               groupCode: 'FIL', family: 'FILTER',      confidence: 'iii-appendix-shared' },
  // DRIVE = ID_FUZZ range + FUZZ family. See header.
  { firstId: 118,  instances: 4, name: 'Drive',                groupCode: 'DRV', family: 'FUZZ',        confidence: 'hardware-corroborated' },
  { firstId: 122,  instances: 4, name: 'Enhancer',             groupCode: 'ENH', family: 'ENHANCER',    confidence: 'iii-appendix-shared' },
  { firstId: 126,  instances: 4, name: 'Mixer',                groupCode: 'MIX', family: 'MIXER',       confidence: 'iii-appendix-shared' },
  { firstId: 130,  instances: 4, name: 'Synth',                groupCode: 'SYN', family: 'SYNTH',       confidence: 'iii-appendix-shared' },
  { firstId: 134,  instances: 4, name: 'Vocoder',              groupCode: 'VOC', family: 'VOCODER',     confidence: 'fm9-edit-asset' },
  { firstId: 138,  instances: 4, name: 'Megatap Delay',        groupCode: 'MGD', family: 'MEGATAP',     confidence: 'iii-appendix-shared' },
  { firstId: 142,  instances: 4, name: 'Crossover',            groupCode: 'XOV', family: 'CROSSOVER',   confidence: 'iii-appendix-shared' },
  { firstId: 146,  instances: 4, name: 'Gate/Expander',        groupCode: 'GAT', family: 'GATE',        confidence: 'iii-appendix-shared' },
  { firstId: 150,  instances: 4, name: 'Ring Modulator',       groupCode: 'RNG', family: 'RINGMOD',     confidence: 'iii-appendix-shared' },
  { firstId: 154,  instances: 4, name: 'Multiband Compressor', groupCode: 'MBC', family: 'MULTICOMP',   confidence: 'iii-appendix-shared' },
  { firstId: 158,  instances: 4, name: 'Ten-Tap Delay',        groupCode: 'TTD', family: 'TENTAP',      confidence: 'iii-appendix-shared' },
  { firstId: 162,  instances: 4, name: 'Resonator',            groupCode: 'RES', family: 'RESONATOR',   confidence: 'iii-appendix-shared' },
  // FM9 ships one looper; the appendix reserves 166..169.
  { firstId: 166,  instances: 1, name: 'Looper',               groupCode: 'LPR', family: 'LOOPER',      confidence: 'hardware-corroborated' },
  { firstId: 174,  instances: 4, name: 'Real-Time Analyzer',   groupCode: 'RTA', family: 'RTA',         confidence: 'fm9-edit-asset' },
  { firstId: 178,  instances: 4, name: 'Plex Delay',           groupCode: 'PLX', family: 'PLEX',        confidence: 'iii-appendix-shared' },
  // Send has no FM9-Edit params (no FDBKSEND prefix in the FM9 XML).
  { firstId: 182,  instances: 4, name: 'Send',                 groupCode: 'SND',                        confidence: 'hardware-corroborated' },
  { firstId: 186,  instances: 4, name: 'Return',               groupCode: 'RTN', family: 'FDBKRET',     confidence: 'hardware-corroborated' },
  { firstId: 190,  instances: 1, name: 'Scene MIDI',           groupCode: 'SMI', family: 'MIDIBLOCK',   confidence: 'iii-appendix-shared', addressable: false },
  { firstId: 191,  instances: 4, name: 'Multiplexer',          groupCode: 'MUX', family: 'MULTIPLEXER', confidence: 'iii-appendix-shared' },
  { firstId: 195,  instances: 4, name: 'IR Player',            groupCode: 'IRP', family: 'IRPLAYER',    confidence: 'fm9-edit-asset' },
  { firstId: 199,  instances: 1, name: 'Foot Controller',      groupCode: 'FC',  family: 'FC',          confidence: 'iii-appendix-shared', addressable: false },

  // ── Open items (see header; do not guess IDs) ──────────────────
  // STATUS_DUMP IDs 200 + 201 (channelCount=1) are unmapped. 200 is
  // the III appendix's ID_PRESET_FC; 201 is past the appendix. The
  // FM9-Edit grid cross-check of preset 413 resolves what they are.
  { firstId: null, instances: 2, name: 'Effects Loop',         groupCode: 'EFL',                        confidence: 'pending' },
  { firstId: null, instances: 1, name: 'EQ Match',             groupCode: 'EQM',                        confidence: 'pending' },
] as const;

// ── Lookups ────────────────────────────────────────────────────────

const NAMES_BY_LOWER: Map<string, FM9Block> = new Map(
  FM9_BLOCKS.map((b) => [b.name.toLowerCase(), b] as const),
);

/** Resolve a display name (case-insensitive) to its block entry. */
export function resolveBlock(name: string): FM9Block | undefined {
  return NAMES_BY_LOWER.get(name.toLowerCase());
}

/**
 * Resolve a block name + 1-based instance to its wire effect ID.
 * Throws when the block is unknown, has no confirmed ID, or the
 * instance is out of the family's ID range.
 */
export function resolveEffectId(name: string, instance: number): number {
  const block = resolveBlock(name);
  if (block === undefined) {
    throw new Error(`resolveEffectId: unknown FM9 block '${name}'`);
  }
  if (block.firstId === null) {
    throw new Error(
      `resolveEffectId: FM9 block '${block.name}' has no confirmed effect ID ` +
        `(confidence: ${block.confidence}).`,
    );
  }
  if (!Number.isInteger(instance) || instance < 1 || instance > block.instances) {
    throw new Error(
      `resolveEffectId: instance ${instance} out of range for '${block.name}' ` +
        `(1..${block.instances}).`,
    );
  }
  return block.firstId + (instance - 1);
}

/**
 * Resolve a wire effect ID (e.g. from a STATUS_DUMP triple) back to
 * its block + 1-based instance. Returns undefined for IDs outside
 * every known range (callers surface those as unknown-block entries
 * rather than dropping them).
 */
export function resolveBlockByEffectId(
  effectId: number,
): { block: FM9Block; instance: number } | undefined {
  for (const b of FM9_BLOCKS) {
    if (b.firstId === null) continue;
    if (effectId >= b.firstId && effectId < b.firstId + b.instances) {
      return { block: b, instance: effectId - b.firstId + 1 };
    }
  }
  return undefined;
}
