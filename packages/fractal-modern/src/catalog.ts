/**
 * Modern Fractal family — per-device block roster + parameter catalog.
 *
 * `createModernCatalog` builds a device's `blocks` map + resolve helpers
 * from THREE inputs:
 *   - `blocks`          the block roster (the III's `AXE_FX_III_BLOCKS`;
 *                       effect IDs are shared across the gen-3 family per
 *                       tysonlt `AxeEffectEnum.h`, so all devices reuse it).
 *   - `paramsByFamily`  the per-family param table. THIS is device-specific:
 *                       the Axe-Fx III, FM3, and FM9 each pass their OWN
 *                       table, because paramIds are firmware-specific
 *                       ordinals (reusing the III's mis-addresses FM3 13.4%
 *                       / FM9 24% of the symbols they share with the III, see
 *                       cookbook `_negative/gen3-paramid-reuse-across-model-bytes`).
 *   - `resolveEffectId` block-name -> effect ID (shared; the III's).
 *
 * The III passes the III catalog and, with `dropEmptyMappedBlocks: false`,
 * gets byte-identical output to the pre-factory module. That invariant is
 * enforced by `scripts/verify-axe-fx-iii-identity.ts` (in preflight), which
 * snapshots the III's catalog + describe_device surface and fails on any drift.
 * FM3/FM9 pass their device-true tables + `dropEmptyMappedBlocks: true`
 * so blocks whose mapped family has zero device params (e.g. DYNDIST, absent
 * on the floor units) drop off the describe_device surface.
 */
import type {
  BlockSchema,
  ParamSchema,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { formatUnknownParamError } from '@mcp-midi-control/core/protocol-generic/dispatcher/errorFormat.js';
import {
  type AxeFxIIIBlock,
  resolveEnumValues,
  resolveEffectTypeEnum,
  resolveGen3EnumNameToRawId,
} from 'fractal-midi/axe-fx-iii';
import { type Param as AxeFxIIIParam } from 'fractal-midi/axe-fx-iii';
import { displayToWire, wireToDisplay } from 'fractal-midi/axe-fx-ii';

export type { AxeFxIIIBlock, AxeFxIIIParam };

/** The resolved per-device catalog the factory wires into reader/writer. */
export interface ModernCatalog {
  /** `describe_device` block roster (slug -> BlockSchema). */
  blocks: Readonly<Record<string, BlockSchema>>;
  resolveBlockOrThrow(
    slug: string,
    deviceLabel: string,
    instance?: number,
  ): { block: AxeFxIIIBlock; effectId: number };
  resolveParamOrThrow(
    slug: string,
    name: string,
    deviceLabel: string,
  ): { family: string; param: AxeFxIIIParam };
  /**
   * Resolve a (block, param) and coerce a DISPLAY value to its wire integer via
   * the param's schema `encode` closure — the same closure `set_param` runs at
   * the dispatcher boundary (`encodeValue`). `apply_preset` must call this so a
   * spec value like `treble: 5.5` becomes a wire int instead of reaching
   * `packValue16` raw (which rejects non-integers). Calibrated knobs map through
   * the display range; enums resolve name→raw-id (or pass a numeric through);
   * uncalibrated params still require a raw wire int, surfacing a clear error.
   */
  encodeParamOrThrow(
    slug: string,
    name: string,
    value: number | string,
    deviceLabel: string,
  ): number;
}

// ── Block-slug ↔ catalog-family mapping ────────────────────────────
//
// AxeFxIIIBlock entries use 3-letter groupCodes (CMP, REV, DLY, etc.);
// the PARAMS catalog families are spelled-out (COMP, REVERB, DELAY).
// Keep the mapping explicit so missing entries fail loud instead of
// silently producing empty BlockSchemas.

const GROUP_TO_FAMILY: Readonly<Record<string, string>> = Object.freeze({
  CMP: 'COMP',
  GEQ: 'GEQ',
  PEQ: 'PEQ',
  AMP: 'DISTORT',  // gen-3 amp tone-stack + power section (ID_DISTORT1=58)
  CAB: 'CABINET',
  REV: 'REVERB',
  DLY: 'DELAY',
  MTD: 'MULTITAP',
  CHO: 'CHORUS',
  FLG: 'FLANGER',
  ROT: 'ROTARY',
  PHA: 'PHASER',
  WAH: 'WAH',
  FRM: 'FORMANT',
  PTR: 'TREMOLO',
  PIT: 'PITCH',
  FIL: 'FILTER',
  FUZ: 'FUZZ',
  ENH: 'ENHANCER',
  MIX: 'MIXER',
  SYN: 'SYNTH',
  VOC: 'VOCODER',
  MGD: 'MEGATAP',
  XOV: 'CROSSOVER',
  GAT: 'GATE',
  RNG: 'RINGMOD',
  MBC: 'MULTICOMP',
  TTD: 'TENTAP',
  RES: 'RESONATOR',
  VOL: 'VOLUME',
  PLX: 'PLEX',
  SND: 'FDBKSEND',
  RTN: 'FDBKRET',
  LPR: 'LOOPER',
  TMA: 'TONEMATCH',
  RTA: 'RTA',
  MUX: 'MULTIPLEXER',
  IRP: 'IRPLAYER',
  IN: 'INPUT',
  OUT: 'OUTPUT',
  SMI: 'MIDIBLOCK',
  FC: 'FC',
  PFC: 'PRESET',
  DYD: 'DYNDIST',
  // Blocks with NO catalog family: NAM (post-v1.13 addition), CTR
  // (Controllers), TUN (Tuner), IRC (IR Capture utility), GBK (Global
  // Block), SHT (Shunt). These get empty params and set_param refuses
  // with "no params catalogued for <block>". (AMP now maps to DISTORT.)
});

export function blockSlug(b: AxeFxIIIBlock): string {
  return b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ── Param schema builders ──────────────────────────────────────────
//
// Display-first where the catalog carries a calibrated range. A gen-3
// param that has BOTH `displayMin` and `displayMax` (AM4 symbol-name join
// at catalog-generation time) gets encode/decode wired through the proven
// Axe-Fx II resolver (`displayToWire` / `wireToDisplay`, linear or log10)
// over the 16-bit 0..65534 field: callers pass the panel reading (0..10
// knob, dB, ms, Hz) and the wire integer is derived here. This is the same
// 16-bit-linear-wire model the II uses for both linear and log10 display
// scales.
//
// Params WITHOUT a calibrated range (most `unit: 'unverified'` entries) and
// enum params keep PASSTHROUGH encode/decode: callers move the raw 16-bit
// wire integer and the same integer reaches the wire. As FM3/FM9 ranges are
// filled in (A7 overlay), more params cross from passthrough to display-first
// automatically.

export function stripFamilyPrefix(family: string, paramName: string): string {
  const prefix = `${family}_`;
  if (paramName.startsWith(prefix)) {
    return paramName.slice(prefix.length).toLowerCase();
  }
  return paramName.toLowerCase();
}

function humanize(snake: string): string {
  return snake
    .split('_')
    .filter((s) => s.length > 0)
    .map((s) => s[0].toUpperCase() + s.slice(1).toLowerCase())
    .join(' ');
}

function makePassthroughEncode(family: string, paramKey: string): ParamSchema['encode'] {
  return (value: number | string): number => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(
        `${family}.${paramKey}: expected a number (raw wire 0..65534), got "${value}". ` +
          'This param has no calibrated display range; pass the 16-bit wire integer directly.',
      );
    }
    if (!Number.isInteger(num) || num < 0 || num > 65534) {
      throw new Error(
        `${family}.${paramKey} expects wire 0..65534 (uncalibrated): ${num}`,
      );
    }
    return num;
  };
}

/**
 * Encode closure for a gen-3 enum param. A NUMBER is the raw write-leg wire
 * id (caller's responsibility — passthrough). A STRING name is resolved to
 * its device-true write-leg raw id via the captured ordinal→raw-id table:
 *   - `resolved`        → emit the hardware-confirmed raw id.
 *   - `capture_pending` → throw (the name is valid but its write id isn't
 *                         captured; the dispatcher gate normally refuses
 *                         these by name before reaching here via
 *                         `enum_settable_names`, so this is a backstop).
 *   - `unknown_name`    → throw → dispatcher reformats as "did you mean…?"
 *
 * Read ordinal ≠ write raw-id on gen-3 (a permutation), so this NEVER reuses
 * the decode ordinal as a wire value — only table-backed raw ids are emitted.
 */
function makeEnumEncode(
  family: string,
  paramKey: string,
  paramSymbol: string,
  settableNames: readonly string[],
): ParamSchema['encode'] {
  return (value: number | string): number => {
    // A number — or a NUMERIC STRING — is the raw write-leg wire id
    // (passthrough; caller's responsibility). The dispatcher gate already
    // lets numeric strings through, so mirror the passthrough encoder here
    // and only treat a NON-numeric string as an enum name.
    const asNum = typeof value === 'number' ? value : Number(value);
    if (typeof value === 'number' || (value.trim() !== '' && Number.isFinite(asNum))) {
      if (!Number.isInteger(asNum) || asNum < 0 || asNum > 65534) {
        throw new Error(
          `${family}.${paramKey} expects the raw write-leg wire id 0..65534 (or a capture-confirmed ` +
            `name): ${value}`,
        );
      }
      return asNum;
    }
    const res = resolveGen3EnumNameToRawId(paramSymbol, value);
    if (res.status === 'resolved') return res.rawId;
    if (res.status === 'capture_pending') {
      const list = settableNames.length > 0 ? settableNames.map((n) => `"${n}"`).join(', ') : '(none)';
      throw new Error(
        `"${res.matchedLabel}" is a valid ${paramKey} but its gen-3 write value isn't captured yet — ` +
          `set it on the device, or pass the raw wire id. Capture-confirmed names: ${list}.`,
      );
    }
    if (res.status === 'unknown_name') {
      throw new Error(`unknown ${paramKey} value "${value}"`);
    }
    throw new Error(`${family}.${paramKey}: "${value}" is not an enum value`);
  };
}

/** Resolved display↔wire calibration for one param, or undefined if none. */
interface CalibrationOpts {
  readonly displayMin: number;
  readonly displayMax: number;
  readonly displayScale: 'linear' | 'log10';
}

/**
 * Decide whether a param's catalog range yields a usable display↔wire
 * calibration. Requires a finite displayMin < displayMax; for log10 scaling
 * both bounds must be positive (the II resolver throws otherwise). Returns
 * undefined for anything that can't calibrate, so the caller falls back to
 * passthrough rather than emitting a closure that throws at call time.
 */
function resolveCalibration(param: AxeFxIIIParam): CalibrationOpts | undefined {
  const { displayMin, displayMax, scaling } = param;
  if (displayMin === undefined || displayMax === undefined) return undefined;
  if (!Number.isFinite(displayMin) || !Number.isFinite(displayMax)) return undefined;
  if (displayMin >= displayMax) return undefined;
  const displayScale: 'linear' | 'log10' = scaling === 'log10' ? 'log10' : 'linear';
  if (displayScale === 'log10' && (displayMin <= 0 || displayMax <= 0)) return undefined;
  return { displayMin, displayMax, displayScale };
}

/**
 * Round a decoded display value to the panel's natural resolution, stripping
 * the float noise the wire→display inverse leaves behind (7.0000305 → 7).
 * Mirrors the Axe-Fx II decode boundary; two decimals preserves every
 * observed panel resolution.
 */
function roundDisplay(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function makeCalibratedEncode(
  family: string,
  paramKey: string,
  cal: CalibrationOpts,
): ParamSchema['encode'] {
  return (value: number | string): number => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`${family}.${paramKey}: expected a number, got "${value}"`);
    }
    if (num < cal.displayMin || num > cal.displayMax) {
      throw new Error(
        `${family}.${paramKey} out of range [${cal.displayMin}..${cal.displayMax}]: ${num}`,
      );
    }
    return displayToWire(num, cal);
  };
}

function makeCalibratedDecode(cal: CalibrationOpts): ParamSchema['decode'] {
  return (wire: number): number => roundDisplay(wireToDisplay(wire, cal));
}

function buildParamSchema(
  family: string,
  param: AxeFxIIIParam,
  deviceEnumOverrides?: Readonly<Record<string, Readonly<Record<number, string>>>>,
): {
  key: string;
  schema: ParamSchema;
} {
  const key = stripFamilyPrefix(family, param.name);
  // Gen-3 read leg: if the param's firmware symbol has an enum vocabulary in
  // the shared overlay, attach the ordinal->label table so get_param /
  // get_preset / broadcast and list_params surface NAMES, not raw indices.
  // These are display-only: `enum_display_only` makes the dispatcher refuse
  // set-by-name (the typed-SET raw enum id is a different, uncaptured
  // encoding), while numeric wire values still pass through.
  //
  // Unit-aware to avoid over-matching: only a param the catalog actually tags
  // `unit: 'enum'` (the III) gets the FULL overlay (effect-type lists +
  // universal Fractal suffix conventions). The FM3/FM9 device-true catalogs
  // are all `unit: 'unverified'`, so for them we attach ONLY the byte-anchored
  // effect-type lists, never the broad suffix conventions that would wrongly
  // label + gate a continuous param sharing a suffix (_HOLD/_TEMPO/_SLOPE/...).
  const overlay = param.unit === 'enum'
    ? resolveEnumValues(param.name)
    : resolveEffectTypeEnum(param.name);
  // Per-device enum override: a device-true {ordinal -> name} table captured
  // from this specific model's hardware (e.g. the FM9 amp roster, which the
  // family-shared overlay deliberately leaves numeric because amp ordinals
  // differ per model). Takes precedence over the family overlay. Partial by
  // construction (only captured ordinals) — the decode below labels known
  // ordinals and passes unknown ones through as numbers. Read-leg only: these
  // are broadcast ordinals, NOT typed-SET raw ids, so set-by-name stays gated
  // (enum_display_only) until a raw-id is captured for the name.
  const deviceOverlayValues = deviceEnumOverrides?.[param.name];
  const enumValues = deviceOverlayValues ?? overlay?.values;

  // Display-first: a non-enum param with a calibrated range encodes/decodes
  // through the II resolver. Enum params stay display-only (raw wire in,
  // label out) — their typed-SET raw enum id is a different, uncaptured
  // encoding, so set-by-name is gated and numeric wire values pass through.
  const cal = enumValues === undefined ? resolveCalibration(param) : undefined;

  // Write leg: the subset of this enum's labels whose device-true raw id has
  // been captured (FM9 hardware) — those can be set BY NAME; everything else
  // stays gated. Empty for every enum without captured raw ids (the norm).
  const enumSettableNames =
    enumValues !== undefined
      ? Object.values(enumValues).filter(
          (label) => resolveGen3EnumNameToRawId(param.name, label).status === 'resolved',
        )
      : [];

  let encode: ParamSchema['encode'];
  let decode: ParamSchema['decode'];
  if (enumValues !== undefined) {
    encode = makeEnumEncode(family, key, param.name, enumSettableNames);
    decode = (wire: number): number | string => enumValues[wire] ?? wire;
  } else if (cal !== undefined) {
    encode = makeCalibratedEncode(family, key, cal);
    decode = makeCalibratedDecode(cal);
  } else {
    encode = makePassthroughEncode(family, key);
    decode = (wire: number): number => wire;
  }

  return {
    key,
    schema: {
      display_name: humanize(key),
      unit: param.unit,
      display_min: param.displayMin,
      display_max: param.displayMax,
      enum_values: enumValues,
      enum_display_only: enumValues !== undefined ? true : undefined,
      // A per-device override table is captured-partial (only some ordinals
      // named), so numeric ordinals outside it must pass through, not error.
      enum_partial: deviceOverlayValues !== undefined ? true : undefined,
      enum_settable_names: enumSettableNames.length > 0 ? enumSettableNames : undefined,
      encode,
      decode,
      parameter_name: param.name,
    },
  };
}

// ── Per-device catalog factory ─────────────────────────────────────

export function createModernCatalog(opts: {
  blocks: readonly AxeFxIIIBlock[];
  paramsByFamily: Readonly<Record<string, readonly AxeFxIIIParam[]>>;
  resolveEffectId: (name: string, instance?: number) => number;
  /**
   * When true, a block whose groupCode maps to a catalog family that has
   * ZERO params on this device drops off the `blocks` surface (device-true
   * roster: e.g. FM3/FM9 lack DYNDIST, so the Dynamic Distortion block drops;
   * blocks whose tables the editor still ships, like TONEMATCH, are kept).
   * The III passes false so its surface is unchanged (byte-identity anchor).
   * Structural blocks with no mapped family (AMP, Shunt, Tuner, ...) are kept.
   */
  dropEmptyMappedBlocks?: boolean;
  /**
   * Per-device enum override tables, keyed by param firmware symbol name then
   * broadcast ordinal -> display name. Device-true points captured from THIS
   * model's hardware (e.g. FM9 amp models). Layered over the family-shared
   * overlay in `buildParamSchema`; partial tables are fine (unknown ordinals
   * pass through numerically). Omit for devices with no captured overrides.
   */
  deviceEnumOverrides?: Readonly<Record<string, Readonly<Record<number, string>>>>;
  /**
   * Block slugs (lower-case) the physical device does NOT expose, dropped
   * unconditionally even when their mapped family carries params. The mined
   * catalog is shared across the gen-3 editor family, so a device-true table
   * can list params for a block a given unit lacks (VP4 carries DISTORT /
   * CABINET params from the shared editor binary but has no amp/cab blocks).
   * `dropEmptyMappedBlocks` only removes EMPTY families, so non-empty-but-
   * absent blocks need this explicit list.
   */
  excludeBlocks?: readonly string[];
}): ModernCatalog {
  const { blocks, paramsByFamily, resolveEffectId, dropEmptyMappedBlocks = false, deviceEnumOverrides, excludeBlocks } = opts;
  const excluded = new Set((excludeBlocks ?? []).map((s) => s.toLowerCase()));

  const slugToFamily: Record<string, string> = {};
  const slugToBlock: Record<string, AxeFxIIIBlock> = {};
  for (const b of blocks) {
    const slug = blockSlug(b);
    if (excluded.has(slug)) continue; // device lacks this block (e.g. VP4 amp/cab)
    slugToBlock[slug] = b;
    const family = GROUP_TO_FAMILY[b.groupCode];
    if (family !== undefined) slugToFamily[slug] = family;
  }

  const blockSchemas: Record<string, BlockSchema> = {};
  for (const b of blocks) {
    const slug = blockSlug(b);
    if (excluded.has(slug)) continue; // keep consistent with slugToBlock above
    const family = GROUP_TO_FAMILY[b.groupCode];
    const params: Record<string, ParamSchema> = {};
    const aliases: Record<string, string> = {};
    if (family !== undefined) {
      const catalogEntries = paramsByFamily[family] ?? [];
      for (const p of catalogEntries) {
        // Skip firmware-internal sentinels (paramId >= 0x3fff are *_SET_ALL /
        // *_VAL_ALL — documentary only, not wire-addressable).
        if (p.paramId >= 0x3fff) continue;
        const { key, schema } = buildParamSchema(family, p, deviceEnumOverrides);
        // First wins on key collision (e.g. FLANGER_TYPE vs FLANGER_OLD_TYPE).
        if (!(key in params)) {
          params[key] = schema;
          if (p.name.toLowerCase() !== key) {
            aliases[p.name.toLowerCase()] = key;
          }
        }
      }
      // Device-true roster: a mapped family with zero wire-addressable
      // params means this device doesn't ship the block — drop it.
      if (dropEmptyMappedBlocks && Object.keys(params).length === 0) continue;
    }
    blockSchemas[slug] = {
      display_name: b.name,
      params,
      aliases: Object.keys(aliases).length > 0 ? aliases : undefined,
    };
  }
  const frozenBlocks = Object.freeze(blockSchemas);

  function resolveBlockOrThrow(
    slug: string,
    deviceLabel: string,
    instance?: number,
  ): { block: AxeFxIIIBlock; effectId: number } {
    const block = slugToBlock[slug];
    if (block === undefined) {
      throw new DispatchError(
        'unknown_block',
        deviceLabel,
        `Block slug '${slug}' is not registered on ${deviceLabel}.`,
      );
    }
    let effectId: number;
    try {
      // `resolveEffectId` returns block.firstId + (instance - 1) and range-
      // checks against block.instances; gen-3 amp/reverb/delay carry 2..4
      // instances, so instance 2 addresses the second block (e.g. Amp 2 =
      // effect id 59). Default 1 keeps single-instance callers unchanged.
      effectId = resolveEffectId(block.name, instance ?? 1);
    } catch (err) {
      throw new DispatchError(
        'capability_not_supported',
        deviceLabel,
        err instanceof Error ? err.message : String(err),
      );
    }
    return { block, effectId };
  }

  function resolveParamOrThrow(
    slug: string,
    name: string,
    deviceLabel: string,
  ): { family: string; param: AxeFxIIIParam } {
    const family = slugToFamily[slug];
    if (family === undefined) {
      throw new DispatchError(
        'capability_not_supported',
        deviceLabel,
        `Block '${slug}' has no parameter catalog on ${deviceLabel}. The modern ` +
          `Fractal groupCode-to-family map has no entry for this block (likely ` +
          `NAM / Tuner / Global Block / Shunt). set_param / get_param refuse for these.`,
      );
    }
    const catalogEntries = paramsByFamily[family] ?? [];
    for (const p of catalogEntries) {
      if (stripFamilyPrefix(family, p.name) === name && p.paramId < 0x3fff) {
        return { family, param: p };
      }
    }
    const knownNames: string[] = [];
    for (const p of catalogEntries) {
      if (p.paramId < 0x3fff) {
        const stripped = stripFamilyPrefix(family, p.name);
        if (!knownNames.includes(stripped)) knownNames.push(stripped);
      }
    }
    throw new DispatchError(
      'unknown_param',
      deviceLabel,
      formatUnknownParamError({
        deviceName: deviceLabel,
        block: slug,
        badParam: name,
        knownNames,
      }) + ` (family ${family})`,
    );
  }

  /**
   * Resolve + display→wire encode in one step, so apply_preset coerces spec
   * values the same way set_param's `encodeValue` boundary does. Resolves the
   * param (clean error on unknown name), then runs the catalog schema's encode
   * closure (the schema lives at `blocks[slug].params[<stripped key>]`).
   */
  function encodeParamOrThrow(
    slug: string,
    name: string,
    value: number | string,
    deviceLabel: string,
  ): number {
    const { family, param } = resolveParamOrThrow(slug, name, deviceLabel);
    const key = stripFamilyPrefix(family, param.name);
    const schema = blockSchemas[slug]?.params[key];
    if (schema === undefined) {
      // resolveParamOrThrow succeeded, so this is unreachable in practice;
      // fall back to a numeric passthrough rather than crashing.
      const n = typeof value === 'number' ? value : Number(value);
      return n;
    }
    return schema.encode(value);
  }

  return { blocks: frozenBlocks, resolveBlockOrThrow, resolveParamOrThrow, encodeParamOrThrow };
}
