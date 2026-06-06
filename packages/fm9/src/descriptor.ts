/**
 * Fractal FM9 DeviceDescriptor — catalog stage (step 2 of 3).
 *
 * Foundation (step 1, hardware-verified 2026-06-06): model byte 0x12,
 * III-family envelope/checksum, switch_preset (bank in CC0),
 * switch_scene (0x0C), QUERY PATCH NAME (0x0D), STATUS DUMP (0x13).
 *
 * This stage adds the FM9-Edit-mined block/param catalog
 * (`fractal-midi/fm9` blockTypes + params; see those files for the
 * mining provenance and the Amp→DISTORT / Drive→FUZZ family
 * corrections) and wires the READ surface:
 *
 *   - list_params / describe_device : catalog-driven blocks schema
 *   - get_param / get_params        : fn=0x01 GET (read-only; GET wire
 *                                     shape is a family-shared
 *                                     hypothesis — no public capture
 *                                     on III or FM9)
 *   - get_preset                    : STATUS_DUMP (hardware-verified) +
 *                                     QUERY PATCH NAME + GET SCENE →
 *                                     PresetSnapshot (placements,
 *                                     bypass, channels; param values
 *                                     omitted until calibration)
 *
 * WRITES STAY GATED: set_param / set_params / apply_preset refuse
 * with a structured error until the calibration step delivers
 * display↔wire conversion. `supports_save` stays false.
 *
 * Encode/decode is PASSTHROUGH (raw 0..65534 wire integers in display
 * position) — no calibration claims are made; every ParamSchema's
 * unit comes from the catalog (III-derived display conventions).
 */
import type {
  DeviceDescriptor,
  DeviceReader,
  DeviceWriter,
  DispatchCtx,
  BlockSchema,
  ParamSchema,
  ReadResult,
  BatchReadResult,
  BatchWriteResult,
  ParamQuery,
  WriteOp,
  WriteResult,
  LocationRef,
  PresetSnapshot,
  PresetSnapshotSlot,
  GetPresetOptions,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { formatUnknownParamError } from '@mcp-midi-control/core/protocol-generic/dispatcher/errorFormat.js';

import {
  FM9_BLOCKS,
  resolveBlockByEffectId,
  resolveEffectId,
  type FM9Block,
  PARAMS_BY_FAMILY,
  FM9_DISPLAY_LABELS,
  type Param as FM9Param,
  buildGetParameter,
  buildSetParameter,
  isGetParameterResponse,
  parseGetParameterResponse,
  buildQueryPatchName,
  buildGetScene,
  buildSetScene,
  buildStatusDump,
  buildSwitchPresetPC,
  describeMultipurposeResultCode,
  isMultipurposeResponse,
  isQueryPatchNameResponse,
  isSetGetParameterResponse,
  isSetGetSceneResponse,
  isStatusDumpResponse,
  parseMultipurposeResponse,
  parseQueryPatchNameResponse,
  parseSceneResponse,
  parseSetGetParameterResponse,
  parseStatusDumpResponse,
} from 'fractal-midi/fm9';

const DEVICE_LABEL = 'Fractal FM9';

/** Wire response window — same budget the III descriptor uses. */
const GET_RESPONSE_TIMEOUT_MS = 800;

/**
 * Banner appended to FM9 responses. Foundation ops are
 * hardware-verified; the catalog read surface is mined-but-uncalibrated.
 */
const FOUNDATION_WARNING = [
  'fm9 catalog stage. Model byte (0x12), preset/scene switch, and',
  'QUERY PATCH NAME / STATUS DUMP framing are hardware-verified',
  '(2026-06-06). The block/param catalog is mined from FM9-Edit with',
  'III-shared paramId addressing; param VALUES are raw uncalibrated',
  'wire integers (0..65534). Writes are gated until calibration.',
].join(' ');

/** Structured refusal for the gated write surface. */
function writesGated(op: string): DispatchError {
  return new DispatchError(
    'capability_not_supported',
    DEVICE_LABEL,
    `fm9 ${op}: parameter writes are gated until the FM9 calibration step. ` +
      'The catalog (paramId addressing) is III-shared and unverified for writes; ' +
      'shipping uncalibrated writes risks audible misroutes.',
    {
      retry_action:
        'Read-only tools are live: get_param, get_params, get_preset, list_params, ' +
        'describe_device, plus switch_preset / switch_scene. Param writes arrive ' +
        'with the calibration step.',
    },
  );
}

// ── Blocks schema from the mined catalog ───────────────────────────

function blockSlug(b: FM9Block): string {
  return b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function stripFamilyPrefix(family: string, paramName: string): string {
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
          'FM9 display→wire calibration is pending; pass the 16-bit wire integer directly.',
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

function makePassthroughDecode(): ParamSchema['decode'] {
  return (wire: number): number => wire;
}

function buildParamSchema(family: string, param: FM9Param): {
  key: string;
  schema: ParamSchema;
} {
  const key = stripFamilyPrefix(family, param.name);
  // Prefer FM9-Edit's own UI label when the mine has one.
  const fm9Label = FM9_DISPLAY_LABELS[param.name];
  return {
    key,
    schema: {
      display_name: fm9Label ?? humanize(key),
      unit: param.unit,
      display_min: param.displayMin,
      display_max: param.displayMax,
      encode: makePassthroughEncode(family, key),
      decode: makePassthroughDecode(),
      parameter_name: param.name,
    },
  };
}

/**
 * Build the `blocks` map for `describe_device`. Each FM9_BLOCKS entry
 * becomes one BlockSchema slug; per-block params come from
 * PARAMS_BY_FAMILY[block.family]. Blocks without a family (Send,
 * Effects Loop, EQ Match, Tuner, IR Capture) get an empty params map —
 * list_params still surfaces the block; set_param/get_param refuse
 * with a clean "no params catalogued" error.
 */
function buildBlocks(): Record<string, BlockSchema> {
  const out: Record<string, BlockSchema> = {};
  for (const b of FM9_BLOCKS) {
    const slug = blockSlug(b);
    const params: Record<string, ParamSchema> = {};
    const aliases: Record<string, string> = {};
    if (b.family !== undefined) {
      const catalogEntries = PARAMS_BY_FAMILY[b.family] ?? [];
      for (const p of catalogEntries) {
        // Skip firmware-internal sentinels (paramId >= 0x3fff aren't
        // wire-addressable; see the III catalog header).
        if (p.paramId >= 0x3fff) continue;
        const { key, schema } = buildParamSchema(b.family, p);
        // First wins on key collision (e.g. FLANGER_TYPE vs
        // FLANGER_OLD_TYPE both → "type"); current symbols come first
        // per dispatcher-case order.
        if (!(key in params)) {
          params[key] = schema;
          if (p.name.toLowerCase() !== key) {
            aliases[p.name.toLowerCase()] = key;
          }
        }
      }
    }
    out[slug] = {
      display_name: b.name,
      params,
      aliases: Object.keys(aliases).length > 0 ? aliases : undefined,
    };
  }
  return out;
}

const BLOCK_SLUG_TO_BLOCK: Readonly<Record<string, FM9Block>> = (() => {
  const map: Record<string, FM9Block> = {};
  for (const b of FM9_BLOCKS) map[blockSlug(b)] = b;
  return Object.freeze(map);
})();

// ── Resolution helpers ─────────────────────────────────────────────

function resolveBlockOrThrow(slug: string, instance = 1): { block: FM9Block; effectId: number } {
  const block = BLOCK_SLUG_TO_BLOCK[slug];
  if (block === undefined) {
    throw new DispatchError(
      'unknown_block',
      DEVICE_LABEL,
      `Block slug '${slug}' is not registered on ${DEVICE_LABEL}.`,
    );
  }
  let effectId: number;
  try {
    effectId = resolveEffectId(block.name, instance);
  } catch (err) {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      err instanceof Error ? err.message : String(err),
    );
  }
  return { block, effectId };
}

function resolveParamOrThrow(slug: string, name: string): {
  family: string;
  param: FM9Param;
} {
  const block = BLOCK_SLUG_TO_BLOCK[slug];
  const family = block?.family;
  if (block === undefined || family === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `Block '${slug}' has no parameter catalog on ${DEVICE_LABEL}` +
        (block ? ` (FM9-Edit ships no params for ${block.name})` : '') +
        '. get_param / set_param refuse for these.',
    );
  }
  const catalogEntries = PARAMS_BY_FAMILY[family] ?? [];
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
    DEVICE_LABEL,
    formatUnknownParamError({
      deviceName: DEVICE_LABEL,
      block: slug,
      badParam: name,
      knownNames,
    }) + ` (family ${family})`,
  );
}

/** Coerce a LocationRef (string | number) to an integer preset 0..511. */
function parseLocation(location: LocationRef): number {
  const n = typeof location === 'number' ? location : Number(location);
  if (!Number.isInteger(n) || n < 0 || n > 511) {
    throw new DispatchError(
      'bad_location',
      DEVICE_LABEL,
      `fm9: preset location '${location}' is invalid (expected integer 0..511).`,
    );
  }
  return n;
}

function formatErrorCode(report: { resultCode: number; description?: string }): string {
  const hex = `0x${report.resultCode.toString(16).padStart(2, '0')}`;
  return report.description !== undefined ? `${report.description} (${hex})` : `unknown result code ${hex}`;
}

async function sendAndWatchForError(
  ctx: DispatchCtx,
  bytes: number[],
  windowMs = 50,
): Promise<{ resultCode: number; description?: string } | undefined> {
  const watchPromise = ctx.conn.receiveSysExMatching(
    isMultipurposeResponse,
    windowMs,
  );
  ctx.conn.send(bytes);
  try {
    const frame = await watchPromise;
    const parsed = parseMultipurposeResponse(frame);
    return {
      resultCode: parsed.resultCode,
      description: describeMultipurposeResultCode(parsed.resultCode),
    };
  } catch {
    return undefined;
  }
}

// ── Reader ─────────────────────────────────────────────────────────

const reader: DeviceReader = {
  /**
   * fn=0x01 GET — read-only. The GET wire shape is a family-shared
   * hypothesis (no public capture on III or FM9); a timeout surfaces
   * a structured error naming the fallback (get_preset / STATUS_DUMP).
   */
  async getParam(
    ctx: DispatchCtx,
    blockSlugIn: string,
    name: string,
    _channel?: string | number,
    instance?: number,
  ): Promise<ReadResult> {
    const { effectId } = resolveBlockOrThrow(blockSlugIn, instance ?? 1);
    const { param } = resolveParamOrThrow(blockSlugIn, name);
    const requestBytes = buildGetParameter(effectId, param.paramId);
    const responsePromise = ctx.conn.receiveSysExMatching(
      isSetGetParameterResponse,
      GET_RESPONSE_TIMEOUT_MS,
    );
    ctx.conn.send(requestBytes);
    let response: number[];
    try {
      response = await responsePromise;
    } catch (err) {
      throw new DispatchError(
        'no_ack',
        DEVICE_LABEL,
        `get_param: no fn=0x01 response from ${DEVICE_LABEL} within ${GET_RESPONSE_TIMEOUT_MS}ms: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `The fn=0x01 GET shape is a family-shared hypothesis (unverified on FM9 ` +
          `hardware); the firmware may not implement it, or block '${blockSlugIn}' ` +
          `(effect ID ${effectId}) isn't placed in the active preset. ` +
          'Fallback: get_preset reads placements/bypass/channels via the ' +
          'hardware-verified STATUS_DUMP.',
      );
    }
    // HARDWARE-DECODED (2026-06-06): the FM9 answers GETs with a
    // 60-byte frame carrying the param's internal IEEE float AND the
    // device's own display string. Prefer that parser; fall back to
    // the short set-echo shape.
    if (isGetParameterResponse(response)) {
      const parsed = parseGetParameterResponse(response);
      return {
        block: blockSlugIn,
        name,
        wire_value: parsed.valueBits,
        // The device's own display text — ground truth #2. ⚠️ The
        // NAME→paramId binding is III-derived and observed to diverge
        // on FM9 (calibration pending); trust the string, treat the
        // name as approximate.
        display_value: parsed.displayString,
        unit: param.unit,
        raw_response: response,
      };
    }
    const parsed = parseSetGetParameterResponse(response);
    return {
      block: blockSlugIn,
      name,
      wire_value: parsed.value,
      display_value: parsed.value,
      unit: param.unit,
      raw_response: response,
    };
  },

  async getParams(
    ctx: DispatchCtx,
    queries: readonly ParamQuery[],
  ): Promise<BatchReadResult> {
    const reads: ReadResult[] = [];
    const failed: number[] = [];
    const errors: Record<number, string> = {};
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        reads.push(await reader.getParam(ctx, q.block, q.name, q.channel, q.instance));
      } catch (err) {
        failed.push(i);
        errors[i] = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      reads,
      failed_indices: failed,
      errors: failed.length > 0 ? errors : undefined,
    };
  },

  /**
   * Atomic read of the active preset's structure via the
   * hardware-verified STATUS_DUMP (fn 0x13), plus QUERY PATCH NAME
   * (preset number + name) and GET SCENE (active scene).
   *
   * v1 scope: block placements + per-block bypass/channel for the
   * ACTIVE scene. Param VALUES are omitted (uncalibrated; a per-param
   * fn=0x01 sweep would cost N×50 ms with an unverified GET shape).
   * Grid coordinates are not in the dump — slots are reported as
   * ordinal indices in dump order.
   */
  async getPreset(
    ctx: DispatchCtx,
    _options?: GetPresetOptions,
  ): Promise<PresetSnapshot> {
    const startedAt = Date.now();
    const warnings: string[] = [];

    // 1. STATUS_DUMP — placements + bypass + channel.
    const dumpPromise = ctx.conn.receiveSysExMatching(
      isStatusDumpResponse,
      GET_RESPONSE_TIMEOUT_MS * 2,
    );
    ctx.conn.send(buildStatusDump());
    let dump: number[];
    try {
      dump = await dumpPromise;
    } catch (err) {
      throw new DispatchError(
        'no_ack',
        DEVICE_LABEL,
        `get_preset: no STATUS_DUMP response within ${GET_RESPONSE_TIMEOUT_MS * 2}ms ` +
          `(${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    const entries = parseStatusDumpResponse(dump);

    // 2. Preset number + name.
    let name: string | undefined;
    try {
      const namePromise = ctx.conn.receiveSysExMatching(
        isQueryPatchNameResponse,
        GET_RESPONSE_TIMEOUT_MS,
      );
      ctx.conn.send(buildQueryPatchName('current'));
      const parsed = parseQueryPatchNameResponse(await namePromise);
      name = `${parsed.presetNumber}: ${parsed.name}`;
    } catch {
      warnings.push('QUERY PATCH NAME timed out; preset name omitted.');
    }

    // 3. Active scene.
    let activeScene: number | undefined;
    try {
      const scenePromise = ctx.conn.receiveSysExMatching(
        isSetGetSceneResponse,
        GET_RESPONSE_TIMEOUT_MS,
      );
      ctx.conn.send(buildGetScene());
      activeScene = parseSceneResponse(await scenePromise).scene + 1; // display 1..8
    } catch {
      warnings.push('GET SCENE timed out; active scene omitted.');
    }

    let nonGridFiltered = 0;
    const slots: PresetSnapshotSlot[] = [];
    for (const e of entries) {
      const resolved = resolveBlockByEffectId(e.effectId);
      if (resolved === undefined) {
        warnings.push(
          `effect ID ${e.effectId} (0x${e.effectId.toString(16)}) is outside every ` +
            'known FM9 block range — reported as unknown block. Candidates per ' +
            'blockTypes.ts: Effects Loop / EQ Match (IDs unconfirmed).',
        );
        slots.push({
          slot: slots.length,
          block_type: `unknown_0x${e.effectId.toString(16)}`,
          bypassed: e.bypassed,
        });
        continue;
      }
      const { block, instance } = resolved;
      // Non-addressable entities (Preset FC 200/201, Controllers,
      // Scene MIDI, FC) ride in the STATUS_DUMP but are NOT grid
      // blocks — FM9-Edit's grid doesn't show them (cross-checked
      // against preset 413, 2026-06-06). Filter them from slots.
      if (block.addressable === false) {
        nonGridFiltered += 1;
        continue;
      }
      // Per the PresetSnapshotSlot convention, the active channel
      // letter rides as the `params` nesting key (empty record —
      // param VALUES are omitted until calibration). channelCount
      // 0/1 means the block has no channel concept; those slots get
      // no params nest and no channel_status.
      if (e.channelCount > 1) {
        slots.push({
          slot: slots.length,
          block_type: blockSlug(block),
          instance,
          bypassed: e.bypassed,
          params: { [String.fromCharCode(65 + e.channel)]: {} },
          channel_status: 'active' as const,
        });
      } else {
        slots.push({
          slot: slots.length,
          block_type: blockSlug(block),
          instance,
          bypassed: e.bypassed,
        });
      }
    }
    if (nonGridFiltered > 0) {
      warnings.push(
        `${nonGridFiltered} non-grid per-preset entit${nonGridFiltered === 1 ? 'y' : 'ies'} ` +
          '(Preset FC config) reported by STATUS_DUMP were omitted from slots.',
      );
    }

    warnings.push(
      'Slot numbers are STATUS_DUMP ordinals, not grid coordinates (the dump ' +
        'carries no row/col). Param values omitted: FM9 calibration pending.',
    );

    return {
      name,
      slots,
      active_scene: activeScene,
      read_warnings: warnings,
      _meta: {
        device: DEVICE_LABEL,
        read_at_ms: startedAt,
        active_scene_only: true,
        routing_omitted: true,
        channel_state_omitted: false,
        read_duration_ms: Date.now() - startedAt,
      },
    };
  },
};

// ── Writer ─────────────────────────────────────────────────────────

const writer: DeviceWriter = {
  /**
   * Pure builder (no I/O) — resolves the catalog addressing and
   * returns the 23-byte fn=0x01 SET envelope. Exists for goldens and
   * the upcoming calibration pass; the EXECUTE path (setParam) stays
   * gated.
   */
  buildSetParam(block: string, name: string, wireValue: number): number[] {
    const { effectId } = resolveBlockOrThrow(block);
    const { param } = resolveParamOrThrow(block, name);
    return buildSetParameter(effectId, param.paramId, wireValue);
  },

  buildSwitchPreset(location: LocationRef): number[] {
    const n = parseLocation(location);
    return buildSwitchPresetPC(n);
  },

  buildSwitchScene(scene: number): number[] {
    return buildSetScene(scene - 1);
  },

  async setParam(): Promise<WriteResult> {
    throw writesGated('set_param');
  },

  async setParams(_ctx: DispatchCtx, _ops: readonly WriteOp[]): Promise<BatchWriteResult> {
    throw writesGated('set_params');
  },

  async switchPreset(
    ctx: DispatchCtx,
    location: LocationRef,
  ): Promise<WriteResult> {
    const n = parseLocation(location);
    const bytes = buildSwitchPresetPC(n);
    // HARDWARE-VERIFIED (FM9 foundation probe, 2026-06-06): Windows'
    // WinMM backend rejects the concatenated CC0+CC32+PC blob; send
    // the three channel messages separately.
    ctx.conn.send(bytes.slice(0, 3)); // CC 0  (Bank Select — FM9 reads this)
    ctx.conn.send(bytes.slice(3, 6)); // CC 32 (ignored by FM9)
    ctx.conn.send(bytes.slice(6, 8)); // Program Change
    let verified: { presetNumber: number; name: string } | undefined;
    try {
      const responsePromise = ctx.conn.receiveSysExMatching(
        isQueryPatchNameResponse,
        GET_RESPONSE_TIMEOUT_MS,
      );
      ctx.conn.send(buildQueryPatchName('current'));
      verified = parseQueryPatchNameResponse(await responsePromise);
    } catch {
      verified = undefined;
    }
    if (verified !== undefined) {
      return {
        op: 'switch_preset',
        target: String(n),
        acked: verified.presetNumber === n,
        display_value: `${verified.presetNumber}: ${verified.name}`,
        info:
          `fm9 switch_preset: device reports active preset ${verified.presetNumber} ` +
          `("${verified.name}") after the Program Change.`,
        warning: verified.presetNumber === n ? FOUNDATION_WARNING :
          `Device reports preset ${verified.presetNumber}, not the requested ${n} — ` +
          'the Program Change may have been ignored (check the FM9 MIDI channel). ' +
          FOUNDATION_WARNING,
      };
    }
    return {
      op: 'switch_preset',
      target: String(n),
      acked: true,
      display_value: String(n),
      warning:
        'fm9 switch_preset: sent MIDI Program Change + Bank Select on channel 1. ' +
        'No QUERY PATCH NAME response came back within the window, so the switch ' +
        'is unconfirmed — check the front panel. ' + FOUNDATION_WARNING,
    };
  },

  async switchScene(ctx: DispatchCtx, scene: number): Promise<WriteResult> {
    if (!Number.isInteger(scene) || scene < 1 || scene > 8) {
      throw new DispatchError(
        'value_out_of_range',
        DEVICE_LABEL,
        `fm9 switchScene: scene ${scene} out of range. ` +
          'The FM9 has 8 scenes per preset (1..8 display, 0..7 wire).',
      );
    }
    const bytes = buildSetScene(scene - 1);
    const errorReport = await sendAndWatchForError(ctx, bytes, 100);
    if (errorReport !== undefined) {
      return {
        op: 'switch_scene',
        target: String(scene),
        acked: false,
        warning:
          `FM9 rejected switch_scene (function 0x0C) via 0x64 MULTIPURPOSE_RESPONSE: ` +
          `${formatErrorCode(errorReport)}. ` + FOUNDATION_WARNING,
      };
    }
    return {
      op: 'switch_scene',
      target: String(scene),
      acked: true,
      info:
        'fm9 switch_scene: function 0x0C sent; no rejection frame came back. ' +
        'Hardware-verified op (2026-06-06): the FM9 echoes the new scene and the ' +
        'front panel follows.',
      warning: FOUNDATION_WARNING,
    };
  },
};

// ── Curated top-N first-page knob list per block ───────────────────
//
// Keys are FM9 canonical spellings (family prefix stripped). Amp uses
// the DISTORT family; Drive uses FUZZ — see blockTypes.ts header.
// Validated by scripts/verify-fm9-scaffold.ts against the built schema.

const FM9_BLOCK_PARAMS_SUMMARY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  amp: ['type', 'drive', 'bass', 'mid', 'treble', 'master', 'presence', 'level'],
  drive: ['type', 'drive', 'tone', 'mix', 'level'],
  reverb: ['type', 'mix', 'time', 'predelay', 'size', 'hicut', 'level'],
  delay: ['type', 'time', 'feed', 'mix', 'locut', 'hicut', 'level'],
  chorus: ['type', 'rate', 'depth', 'mix', 'level'],
  flanger: ['type', 'rate', 'depth', 'feedback', 'mix', 'level'],
  phaser: ['type', 'rate', 'depth', 'feedback', 'mix', 'level'],
  wah: ['type', 'fstart', 'fstop', 'q', 'control', 'level'],
  compressor: ['type', 'thresh', 'ratio', 'attack', 'release', 'level', 'mix'],
  pitch: ['type', 'pitchmode', 'harm1', 'harm2', 'key', 'scale', 'mix', 'level'],
  cab: ['level', 'air', 'airfreq', 'bass', 'hicut'],
});

// ── Descriptor ─────────────────────────────────────────────────────

export const FM9_DESCRIPTOR: DeviceDescriptor = {
  id: 'fm9',
  display_name: 'Fractal FM9',
  preset_class: 'layout',
  connection_label: 'fm9',
  port_match: [
    // /fm-?9/i — matches "FM9 MIDI Out", "Fractal Audio FM9", "FM-9", etc.
    // Must register BEFORE AM4's /Fractal/i catch-all.
    { pattern: /fm-?9/i },
  ],
  capabilities: {
    slot_model: 'grid',
    // 6×14: measured from FM9-Edit's GridUnitSkin (fieldGrid
    // 1264×366 px; blockSpacing 91×60; block 55×41 → exactly 14
    // columns × 6 rows) and VISUALLY CONFIRMED in FM9-Edit
    // (2026-06-06). docs/FRACTAL-PRESET-SCHEMA.md's 4×14 figure is
    // wrong for current FM9 firmware.
    grid: { rows: 6, cols: 14 },
    has_scenes: true,
    // 8 scenes per FM9-Edit's own Scene 1..Scene 8 controller rows +
    // hardware-verified scene switching.
    scene_count: 8,
    has_channels: true,
    channel_names: ['A', 'B', 'C', 'D'],
    preset_location_format: /^(?:\d{1,3})$/,
    supports_save: false,           // gated until the calibration/write step
    supports_lineage: false,
    atomic_read: true,              // get_preset via STATUS_DUMP (hardware-verified)
  },
  canonical_terms: {
    block: 'block',
    slot: 'grid cell (row 1..6, col 1..14)',
    preset: 'preset',
    scene: 'scene 1..8',
    channel: 'channel A/B/C/D',
    location: 'preset slot 0..511 (integer)',
  },
  blocks: buildBlocks(),
  reader,
  writer,
  block_params_summary: FM9_BLOCK_PARAMS_SUMMARY,
  agent_guidance: {
    foundation_status: [
      'FM9 catalog stage. Hardware-verified (2026-06-06): model byte 0x12,',
      'switch_preset (bank in CC0), switch_scene, QUERY PATCH NAME, STATUS',
      'DUMP. Catalog: 44 families / FM9-Edit-mined block roster; the Amp',
      'block uses the DISTORT param family and the Drive block uses FUZZ.',
      'READS are live: get_preset (placements/bypass/channels via STATUS',
      'DUMP), get_param (fn=0x01 GET, family-shared hypothesis), list_params.',
      'WRITES are gated until calibration: set_param / set_params /',
      'apply_preset / save_preset refuse with a structured error. Param',
      'values move as raw uncalibrated wire integers 0..65534.',
    ].join(' '),
    state_anchoring: [
      'Call get_preset first: it returns the placed blocks with per-block',
      'bypass + channel for the active scene in one ~150 ms round-trip',
      '(hardware-verified STATUS_DUMP). get_param works (fn=0x01 GET,',
      'hardware-decoded 2026-06-06; read-only, does not write) and returns',
      'the device\'s OWN display string plus the internal float. CAVEAT:',
      'the name-to-paramId mapping is III-derived and observed to diverge',
      'on FM9 (a "master" read returned a bypass-style "ENGAGED" string).',
      'Trust the returned display string\'s semantics; treat the param NAME',
      'as approximate until the calibration pass rebinds ids per family.',
    ].join(' '),
  },
};
