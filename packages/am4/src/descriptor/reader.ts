/**
 * AM4 DeviceDescriptor — `DeviceReader` implementation.
 *
 * 4 read operations:
 *   - `getParam` — single-value read via `sendReadAndParse` with optional
 *     pre-read channel switch (so callers can target A/B/C/D without a
 *     separate switch call).
 *   - `getParams` — batch wrapper around `getParam`; collects errors per
 *     entry instead of throwing.
 *   - `scanLocations` — readPresetName loop across a contiguous range,
 *     returning name + is_empty per slot.
 *   - `lookupLineage` — Fractal-authored lineage lookup against the
 *     shared corpus (amps / drives / reverbs / delays).
 *
 * All wire-side I/O is delegated to `sendReadAndParse` / `readPresetName`
 * from `@/server/shared/readOps.js`; the runLineageLookup pipeline is
 * file-only.
 */

import type {
  BlockLayoutSnapshot,
  DeviceReader,
  DispatchCtx,
  PresetSnapshot,
  PresetSnapshotSlot,
  PresetSlotSpec,
  ReadResult,
  ScannedLocation,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  BLOCK_NAMES_BY_VALUE,
  BLOCK_SLOT_PID_HIGH_BASE,
  BLOCK_SLOT_PID_LOW,
  BLOCK_TYPE_VALUES,
  KNOWN_PARAMS,
  buildBlockLayoutSnapshot,
  buildReadParam,
  decode as am4Decode,
  isReadResponseLong,
  parseLongReadBypassFlag,
  READ_TYPE_LONG,
  type BlockTypeName,
  type Param,
  type ParamKey,
} from 'fractal-midi/am4';
import { formatLocationDisplay } from 'fractal-midi/am4';
import { readAllParams, READ_RESPONSE_TIMEOUT_MS, readPresetName, sendReadAndParse, sendReadAndParseRaw } from '../shared/readOps.js';
import {
  CHANNEL_BLOCKS,
  channelLetter,
  switchBlockChannel,
} from '../shared/channels.js';
import {
  LINEAGE_BLOCKS,
  formatLineageRecord,
  loadLineage,
  runLineageLookup,
} from 'fractal-midi/shared';
import { formatLoudnessAppendix } from '@mcp-midi-control/core/fractal-shared/loudness.js';
import { TYPE_APPLICABILITY } from 'fractal-midi/am4';
import { checkApplicability } from 'fractal-midi/am4';
import {
  AMP_TYPES,
  COMPRESSOR_TYPES,
  DELAY_TYPES,
  DRIVE_TYPES,
  REVERB_TYPES,
} from 'fractal-midi/am4';

import { parseAm4Location } from './schema.js';

/**
 * Per-block pidLow list, derived once from KNOWN_PARAMS. Most blocks
 * have a single pidLow (e.g. drive = 0x76); amp spans two (0x3a tone
 * stack + 0x3e cab section). Used by `getPreset` to know which chunks
 * to read for each placed slot.
 */
const PID_LOWS_BY_BLOCK: ReadonlyMap<string, readonly number[]> = (() => {
  const acc = new Map<string, Set<number>>();
  for (const param of Object.values(KNOWN_PARAMS)) {
    const p = param as Param;
    if (!acc.has(p.block)) acc.set(p.block, new Set());
    acc.get(p.block)!.add(p.pidLow);
  }
  const out = new Map<string, readonly number[]>();
  for (const [block, set] of acc) out.set(block, [...set].sort((a, b) => a - b));
  return out;
})();

function pidLowsForBlock(blockType: string): readonly number[] {
  return PID_LOWS_BY_BLOCK.get(blockType) ?? [];
}

const SCENE_STATE_PID_LOW = 0x00ce;
const SCENE_STATE_PID_HIGH = 0x000d;
const BYPASS_STATE_PID_HIGH = 0x0003;

async function readBypassState(
  conn: import('@mcp-midi-control/core/midi/transport.js').MidiConnection,
  blockType: string,
): Promise<boolean | undefined> {
  const pidLow = BLOCK_TYPE_VALUES[blockType as BlockTypeName];
  if (pidLow === undefined || pidLow === BLOCK_TYPE_VALUES.none) return undefined;
  try {
    const readBytes = buildReadParam(
      { pidLow, pidHigh: BYPASS_STATE_PID_HIGH },
      READ_TYPE_LONG,
    );
    const respPromise = conn.receiveSysExMatching(
      (resp) => isReadResponseLong(readBytes, resp),
      READ_RESPONSE_TIMEOUT_MS,
    );
    conn.send(readBytes);
    const resp = await respPromise;
    return parseLongReadBypassFlag(resp);
  } catch {
    return undefined;
  }
}

/**
 * Decode one chunk u16 to its display value. Mirrors the per-paramId
 * `get_param` decode path:
 *   - enum: look up `enumValues[wire]`, fall back to raw int
 *   - non-enum: internal = u16 / 65534 (Q16 → [0..1]), then `am4Decode`
 *     applies the per-unit scale (knob_0_10 / percent / log10-ratio / etc.)
 *
 * Wire-encoding rule cited in `[[am4-fn1f-atomic-read]]` cookbook entry.
 */
function decodeChunkValue(param: Param, wire: number): number | string {
  if (param.unit === 'enum') {
    const enumValues = param.enumValues as Record<number, string> | undefined;
    return enumValues?.[wire] ?? wire;
  }
  const internal = wire / 65534;
  return am4Decode(param, internal);
}

/**
 * Map a lineage block type → its wire-index enum array. Used by the
 * lineage applicability annotation to look up the wire index from the
 * `am4Name` field on the record.
 *
 * Returns undefined for block types that don't have a type enum (most
 * filter / modulation blocks — those records exist but applicability
 * filtering wouldn't add value).
 */
function typeEnumFor(blockType: string): readonly string[] | undefined {
  switch (blockType) {
    case 'amp':        return AMP_TYPES;
    case 'drive':      return DRIVE_TYPES;
    case 'reverb':     return REVERB_TYPES;
    case 'delay':      return DELAY_TYPES;
    case 'compressor': return COMPRESSOR_TYPES;
    default:           return undefined;
  }
}

/**
 * Tone-building knobs typically displayed on each block's front-panel
 * "main page" — the ones a tone-builder reaches for first. We surface
 * applicability for these in the lookup_lineage annotation to keep the
 * output focused on what the agent needs to decide whether to write a
 * param. The full applicability matrix for every internal param is
 * available via list_params.
 */
const FRONT_PANEL_PARAMS: Record<string, readonly string[]> = {
  amp:        ['type', 'gain', 'bass', 'mid', 'treble', 'presence', 'master', 'level', 'depth'],
  drive:      ['type', 'drive', 'tone', 'level', 'mix'],
  reverb:     ['type', 'mix', 'time', 'predelay', 'size', 'low_cut', 'high_cut'],
  delay:      ['type', 'time', 'tempo', 'feedback', 'mix', 'low_cut', 'high_cut'],
  compressor: ['type', 'amount', 'attack', 'release', 'level'],
};

/**
 * For a single lineage record, return a human-readable summary of which
 * front-panel knobs apply on this specific block-type wire index. Lets
 * the agent reason about "does this amp have a master?" without a
 * separate list_params call — the answer is right next to the
 * basedOn / lineage data the lookup already returns.
 *
 * Returns `undefined` when applicability annotation isn't meaningful
 * (block type without a type enum, or am4Name not found in the enum).
 */
function formatApplicableKnobs(blockType: string, am4Name: string): string | undefined {
  const enumValues = typeEnumFor(blockType);
  if (enumValues === undefined) return undefined;
  const wireIndex = enumValues.indexOf(am4Name);
  if (wireIndex < 0) return undefined;
  const knobs = FRONT_PANEL_PARAMS[blockType];
  if (knobs === undefined) return undefined;

  const applies: string[] = [];
  const doesNotApply: string[] = [];
  for (const knob of knobs) {
    const key = `${blockType}.${knob}`;
    if (!(key in TYPE_APPLICABILITY)) continue;
    const result = checkApplicability(key, {
      currentTypes: { [blockType]: wireIndex },
    });
    if (result.applicable === true) applies.push(knob);
    else if (result.applicable === false) doesNotApply.push(knob);
    // 'unknown' → omit; we can't make a strong claim either way.
  }
  if (applies.length === 0 && doesNotApply.length === 0) return undefined;

  const lines: string[] = [];
  if (applies.length > 0) {
    lines.push(`frontPanelKnobs: ${applies.join(', ')}`);
  }
  if (doesNotApply.length > 0) {
    lines.push(
      `notExposed: ${doesNotApply.join(', ')}  ` +
      `(real-amp parity — these knobs do NOT exist on this model; the AM4 silently no-ops writes to them; ` +
      `do not include in apply_preset / set_params calls when this type is active)`,
    );
  }
  return lines.join('\n');
}

// ── Reader adapter ──────────────────────────────────────────────────
//
// `getParam` wraps the existing `sendReadAndParse` + `decode` pipeline
// from the legacy `am4_get_param` handler. The dispatcher pre-resolves
// the canonical (block, name); this method does the wire round-trip
// and returns the display value. Optional channel switch happens
// before the read so callers can target A/B/C/D explicitly without
// a separate switch tool call.

export const reader: DeviceReader = {
  async getParam(
    ctx: DispatchCtx,
    block: string,
    name: string,
    channel?: string | number,
  ): Promise<ReadResult> {
    const key = `${block}.${name}` as ParamKey;
    const param: Param = KNOWN_PARAMS[key];
    if (channel !== undefined && CHANNEL_BLOCKS.has(block)) {
      await switchBlockChannel(ctx.conn, block, channel);
    }
    const { parsed, raw_response } = await sendReadAndParseRaw(ctx.conn, param.pidLow, param.pidHigh);
    const wire = param.unit === 'enum'
      ? parsed.asUInt32LE()
      : parsed.asInternalFloat();
    const display = param.unit === 'enum'
      ? ((param.enumValues as Record<number, string> | undefined)?.[Math.round(wire)] ?? Math.round(wire))
      : am4Decode(param, wire);
    return {
      block,
      name,
      wire_value: wire,
      display_value: display,
      unit: param.unit,
      raw_response,
    };
  },

  async getParams(ctx: DispatchCtx, queries) {
    const reads: ReadResult[] = [];
    const failed_indices: number[] = [];
    const errors: Record<number, string> = {};
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        reads.push(await reader.getParam(ctx, q.block, q.name, q.channel));
      } catch (err) {
        failed_indices.push(i);
        errors[i] = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      reads,
      failed_indices,
      errors: failed_indices.length > 0 ? errors : undefined,
    };
  },

  async getBlockLayoutSnapshot(ctx: DispatchCtx): Promise<BlockLayoutSnapshot> {
    // 4 slot-register reads → block-type names per slot. Identical wire
    // shape to the `am4_get_block_layout` tool (HW-044); kept duplicated
    // rather than refactored to delegate because the tool surface returns
    // formatted text while this method returns structured data.
    const slots: BlockTypeName[] = [];
    for (const position of [1, 2, 3, 4] as const) {
      const pidHigh = BLOCK_SLOT_PID_HIGH_BASE + (position - 1);
      const parsed = await sendReadAndParse(ctx.conn, BLOCK_SLOT_PID_LOW, pidHigh);
      const u32 = parsed.asUInt32LE();
      slots.push(BLOCK_NAMES_BY_VALUE[u32] ?? ('none' as BlockTypeName));
    }
    return buildBlockLayoutSnapshot([slots[0], slots[1], slots[2], slots[3]]);
  },

  async getPreset(ctx: DispatchCtx, options?: { include_channel_state?: boolean }): Promise<PresetSnapshot> {
    // Default OFF, matching II. Reading the non-active channels (B/C/D) is
    // NOT cheap: fn 0x1F is active-channel-only, so each extra channel costs
    // one per-param fn 0x02 GET for every registered param of the block
    // (amp=206, delay=86, reverb=68, drive=38). A 4-channel-block preset is
    // ~1182 serial GETs plus channel switches: ~6 s warm, up to ~60 s cold,
    // far over the conversational tool budget. The common get_preset use is
    // "what is on the device," which the active-channel fn 0x1F dump answers
    // in ~0.3 s. Note the ACTIVE channel is always attributed regardless of
    // this flag (the channel-selector read below is gated by CHANNEL_BLOCKS,
    // not by this flag), so channel-bearing blocks still return
    // params_by_channel:{<active>} + channel_status:'active' on the default
    // path. Callers that need the full A/B/C/D nested shape pass
    // include_channel_state: true and pay the latency knowingly. (This used
    // to default ON "to match II", but II defaults OFF, so OFF is symmetric.)
    const includeChannelState = options?.include_channel_state ?? false;
    // Server-side timer around the SysEx read loop — surfaced as
    // _meta.read_duration_ms (client-independent; alpha.17 finding).
    const readStartedMs = Date.now();

    // 1. Block layout (4 slot reads).
    const layoutSlots: BlockTypeName[] = [];
    for (const position of [1, 2, 3, 4] as const) {
      const pidHigh = BLOCK_SLOT_PID_HIGH_BASE + (position - 1);
      const parsed = await sendReadAndParse(ctx.conn, BLOCK_SLOT_PID_LOW, pidHigh);
      const u32 = parsed.asUInt32LE();
      layoutSlots.push(BLOCK_NAMES_BY_VALUE[u32] ?? ('none' as BlockTypeName));
    }

    // 2. Per placed slot: chunk-based read via fn 0x1F + bypass read +
    //    optional per-channel reads. Performance: ~50 ms per pidLow chunk,
    //    ~50 ms per bypass read, ~50 ms per extra channel switch+read.
    const slots: PresetSnapshotSlot[] = [];
    const errors: string[] = [];
    let totalPlaced = 0;
    for (let slotIdx = 0; slotIdx < 4; slotIdx++) {
      const blockType = layoutSlots[slotIdx];
      if (blockType === 'none') continue;
      totalPlaced++;

      try {
        const pidLows = pidLowsForBlock(blockType);
        if (pidLows.length === 0) {
          errors.push(`slot ${slotIdx + 1} (${blockType}): no documented params`);
          continue;
        }
        const chunks = new Map<number, number[]>();
        for (const pidLow of pidLows) {
          const triple = await readAllParams(ctx.conn, pidLow);
          chunks.set(pidLow, triple.values);
        }

        const flatParams: Record<string, number | string> = {};
        for (const [, param] of Object.entries(KNOWN_PARAMS)) {
          const p = param as Param;
          if (p.block !== blockType) continue;
          const chunk = chunks.get(p.pidLow);
          if (chunk === undefined || p.pidHigh >= chunk.length) continue;
          const wire = chunk[p.pidHigh];
          flatParams[p.name] = decodeChunkValue(p, wire);
        }

        const bypassed = await readBypassState(ctx.conn, blockType);

        let activeChannel: string | undefined;
        // When the channel-param read fails or returns an out-of-range
        // wire value, capture WHY so the response includes a diagnostic
        // line. Bug C in the alpha.13 report: amp returned
        // channel_status="unknown" while delay/reverb worked, and the
        // silent catch hid the root cause from agents. Surfacing the
        // reason lets the founder pin the actual failure mode (response
        // shape mismatch, out-of-range decode, wire encoding wrong) on
        // hardware without another full debug cycle.
        let channelReadFailureReason: string | undefined;
        if (CHANNEL_BLOCKS.has(blockType)) {
          try {
            const channelKey = `${blockType}.channel` as ParamKey;
            const channelParam = KNOWN_PARAMS[channelKey] as Param | undefined;
            if (channelParam === undefined) {
              channelReadFailureReason = `no '${blockType}.channel' param registered in the codec`;
            } else {
              const parsed = await sendReadAndParse(ctx.conn, channelParam.pidLow, channelParam.pidHigh);
              const wire = parsed.asUInt32LE();
              const enumValues = channelParam.enumValues as Record<number, string> | undefined;
              const name = enumValues?.[wire];
              if (typeof name === 'string') {
                activeChannel = name;
              } else {
                // Try interpreting the 4 raw payload bytes as an IEEE 754
                // float32 — the SYSEX-MAP §6a row for amp.channel
                // (pidLow=0x003A, pidHigh=0x07D2) notes the value is "enum
                // int 0..3 packed as float32". delay/reverb at the same
                // pidHigh appear to work via asUInt32LE; amp may differ
                // (the 2026-05-28 alpha.13 desktop session caught amp
                // returning channel_status='unknown' while delay/reverb
                // returned 'all_channels'). Try the float interpretation
                // as a fallback before giving up.
                const floatView = new DataView(parsed.rawValue.buffer, parsed.rawValue.byteOffset, 4);
                const asFloat = floatView.getFloat32(0, true);
                const rounded = Math.round(asFloat);
                if (Number.isFinite(asFloat) && rounded >= 0 && rounded <= 3) {
                  const floatName = enumValues?.[rounded];
                  if (typeof floatName === 'string') {
                    activeChannel = floatName;
                  } else {
                    channelReadFailureReason =
                      `${blockType}.channel float read ${asFloat} (rounded ${rounded}) ` +
                      `not in enumValues (have ${Object.keys(enumValues ?? {}).join(',')})`;
                  }
                } else {
                  channelReadFailureReason =
                    `${blockType}.channel wire ${wire} (0x${wire.toString(16)}) ` +
                    `not in enumValues (have ${Object.keys(enumValues ?? {}).join(',')}); ` +
                    `float32 interpretation = ${asFloat}`;
                }
              }
            }
          } catch (err) {
            channelReadFailureReason = err instanceof Error ? err.message : String(err);
          }
        }

        // Shape decision — must match II reader and AM4 delay/reverb so the
        // response is consistent across every channel-bearing block on every
        // device. Channel blocks ALWAYS surface params under params_by_channel,
        // even when the active channel can't be determined (key 'A' default,
        // channel_status='unknown' tells the agent the attribution is best-
        // effort). Non-channel blocks use flat `params`. The earlier mixed
        // shape (amp: flat+unknown vs delay: by-channel+active in the same
        // response) confused agents during state-anchoring round-trips.
        let params: PresetSlotSpec['params'];
        let paramsByChannel: PresetSlotSpec['params_by_channel'];
        let channelStatus: PresetSnapshotSlot['channel_status'];
        if (!CHANNEL_BLOCKS.has(blockType)) {
          params = flatParams;
        } else if (activeChannel !== undefined && includeChannelState) {
          // Read other channels by switching + per-param GETs.
          //
          // The active-channel data above came from fn 0x1F (atomic chunk
          // read, ~50 ms per pidLow). That envelope is NOT channel-aware:
          // it always returns the active-scene channel's data regardless
          // of any prior `switchBlockChannel` write. Confirmed in the
          // 2026-05-28 alpha.13 desktop session — `get_preset` returned
          // channel A's data 4× for every channel-bearing block, while
          // `get_params({channel:"B"})` (which uses sendReadAndParse / fn
          // 0x02 GET, which IS channel-aware) returned the correct B
          // state. Bug B in the alpha.13 report.
          //
          // The fix: for non-active channels, swap the chunk read for
          // per-param fn 0x02 reads, which respect the prior channel
          // switch. The cost is wall-clock — ~50 ms per param × ~10-30
          // params per block × up to 3 non-active channels. A four-block
          // preset can take several seconds. Callers chasing minimum
          // latency can opt out with include_channel_state: false.
          const allChannelParams: Record<string, Record<string, number | string>> = {
            [activeChannel]: flatParams,
          };
          // Pre-collect the param objects for this block so we don't walk
          // KNOWN_PARAMS for every channel.
          const blockParams: Param[] = [];
          for (const [, paramAny] of Object.entries(KNOWN_PARAMS)) {
            const p = paramAny as Param;
            if (p.block === blockType) blockParams.push(p);
          }
          const channelNames = ['A', 'B', 'C', 'D'];
          for (const ch of channelNames) {
            if (ch === activeChannel) continue;
            try {
              await switchBlockChannel(ctx.conn, blockType, ch);
              const chParams: Record<string, number | string> = {};
              for (const p of blockParams) {
                // Skip the channel selector itself — reading it via fn 0x02
                // returns the channel index, not a per-channel value.
                if (p.name === 'channel') continue;
                try {
                  const parsed = await sendReadAndParse(ctx.conn, p.pidLow, p.pidHigh);
                  const wire = p.unit === 'enum'
                    ? parsed.asUInt32LE()
                    : parsed.asInternalFloat();
                  const display = p.unit === 'enum'
                    ? ((p.enumValues as Record<number, string> | undefined)?.[Math.round(wire)] ?? Math.round(wire))
                    : am4Decode(p, wire);
                  chParams[p.name] = display;
                } catch {
                  // Skip params that fail to read (e.g. type-gated knobs
                  // that aren't currently exposed on this channel's type).
                }
              }
              allChannelParams[ch] = chParams;
            } catch {
              // Skip channels that fail to switch.
            }
          }
          await switchBlockChannel(ctx.conn, blockType, activeChannel).catch(() => {});
          paramsByChannel = allChannelParams;
          channelStatus = Object.keys(allChannelParams).length === 4
            ? 'all_channels'
            : 'active';
        } else if (activeChannel !== undefined) {
          paramsByChannel = { [activeChannel]: flatParams };
          channelStatus = 'active';
        } else {
          // Channel-bearing block but active channel read failed (out-of-range
          // wire value, USB hiccup, etc). Keep the by-channel shape under 'A'
          // as a best-effort key so callers see the same envelope as the
          // active-known path. channel_status='unknown' signals that the key
          // is a fallback, not a hardware-confirmed read.
          paramsByChannel = { A: flatParams };
          channelStatus = 'unknown';
          if (channelReadFailureReason !== undefined) {
            errors.push(
              `slot ${slotIdx + 1} (${blockType}): channel-state read failed → ${channelReadFailureReason}. ` +
              `channel_status='unknown' is a fallback; per-channel params B/C/D are NOT included in this response.`,
            );
          }
        }

        slots.push({
          slot: (slotIdx + 1) as 1 | 2 | 3 | 4,
          block_type: blockType,
          id: blockType,
          ...(bypassed !== undefined ? { bypassed } : {}),
          ...(params !== undefined ? { params } : {}),
          ...(paramsByChannel !== undefined ? { params_by_channel: paramsByChannel } : {}),
          channel_status: channelStatus,
        });
      } catch (err) {
        errors.push(`slot ${slotIdx + 1} (${blockType}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (errors.length === totalPlaced && totalPlaced > 0) {
      throw new DispatchError(
        'no_ack',
        'Fractal AM4',
        `get_preset: read failed on every placed block (${totalPlaced} blocks). First error: ${errors[0]}`,
      );
    }

    // Active scene read (best-effort, non-blocking on failure).
    let activeScene: number | undefined;
    try {
      const parsed = await sendReadAndParse(ctx.conn, SCENE_STATE_PID_LOW, SCENE_STATE_PID_HIGH);
      const sceneIndex = parsed.asUInt32LE();
      if (sceneIndex >= 0 && sceneIndex <= 3) activeScene = sceneIndex + 1;
    } catch {
      activeScene = undefined;
    }

    const hasChannelBearing = layoutSlots.some((b) => CHANNEL_BLOCKS.has(b));
    const channelStateHint = (!includeChannelState && hasChannelBearing)
      ? 'Only the active channel is included. Pass include_channel_state:true to get_preset for the full per-channel read (A/B/C/D; slower: a per-param read per channel on channel-bearing blocks).'
      : undefined;
    return {
      slots,
      active_scene: activeScene,
      ...(errors.length > 0 ? { read_warnings: errors } : {}),
      _meta: {
        device: 'Fractal AM4',
        read_at_ms: Date.now(),
        active_scene_only: true,
        routing_omitted: true,
        channel_state_omitted: !includeChannelState && hasChannelBearing,
        both_channels_read: includeChannelState,
        read_duration_ms: Date.now() - readStartedMs,
        ...(channelStateHint !== undefined ? { channel_state_hint: channelStateHint } : {}),
      },
    };
  },

  async scanLocations(ctx, from, to) {
    const fromIdx = parseAm4Location(from);
    const toIdx = parseAm4Location(to);
    if (fromIdx > toIdx) {
      throw new DispatchError(
        'bad_location',
        'Fractal AM4',
        `Scan range invalid: ${from} (idx ${fromIdx}) is after ${to} (idx ${toIdx}). Pass from <= to.`,
      );
    }
    const scanned: ScannedLocation[] = [];
    let failed_at: string | undefined;
    let failed_reason: string | undefined;
    for (let i = fromIdx; i <= toIdx; i++) {
      try {
        const parsed = await readPresetName(ctx.conn, i);
        scanned.push({
          location: formatLocationDisplay(i),
          name: parsed.name,
          is_empty: parsed.isEmpty,
        });
      } catch (err) {
        failed_at = formatLocationDisplay(i);
        failed_reason = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    return { scanned, failed_at, failed_reason };
  },

  lookupLineage(query) {
    const blockType = query.block_type;
    if (!LINEAGE_BLOCKS.includes(blockType as typeof LINEAGE_BLOCKS[number])) {
      return {
        ok: false,
        text: `Block type '${blockType}' has no Fractal-authored lineage corpus. Valid: ${LINEAGE_BLOCKS.join(', ')}.`,
      };
    }
    const result = runLineageLookup({
      block_type: blockType as typeof LINEAGE_BLOCKS[number],
      name: query.name,
      real_gear: query.real_gear,
      manufacturer: query.manufacturer,
      model: query.model,
    });
    if (!result.found) {
      const detail = result.shape === 'structured'
        ? [
            query.manufacturer && `manufacturer="${query.manufacturer}"`,
            query.model && `model="${query.model}"`,
          ].filter(Boolean).join(', ')
        : (query.name ?? query.real_gear ?? '(unknown query)');
      return {
        ok: false,
        text: `No ${blockType} lineage records match ${detail}. ${result.totalScanned} records scanned.`,
      };
    }
    const withQuotes = query.include_quotes ?? true;
    if (result.shape === 'forward') {
      const rec = result.hits[0].record;
      const baseText = formatLineageRecord(rec, withQuotes);
      const knobs = formatApplicableKnobs(blockType, rec.am4Name);
      const loudness = formatLoudnessAppendix(rec.am4Name);
      const parts = [baseText, knobs, loudness].filter((s): s is string => Boolean(s));
      return { ok: true, text: parts.join('\n') };
    }
    const blocks = result.hits.map((h) => {
      const am4Name = 'am4Name' in h ? h.am4Name : '?';
      const recordText = formatLineageRecord(h.record, withQuotes, 3);
      const knobs = formatApplicableKnobs(blockType, am4Name);
      const loudness = formatLoudnessAppendix(am4Name);
      const parts = [recordText, knobs, loudness].filter((s): s is string => Boolean(s));
      return `── ${am4Name} ──\n${parts.join('\n')}`;
    });
    return {
      ok: true,
      text: `${result.hits.length} ${blockType} match(es)${result.hits.length > 10 ? ' (showing top 10)' : ''}:\n\n${blocks.join('\n\n')}`,
    };
  },

  lineageCorpus() {
    // One text blob per block type containing every record in the
    // corpus, each formatted with `formatLineageRecord`. Includes the
    // applicable-knobs footer so the agent reading this resource gets
    // the same context-rich view as a `lookup_lineage` reverse hit.
    // include_quotes defaults to true (matching `lookupLineage`'s
    // default), with a tight per-record cap of 3 quotes so the corpus
    // blob stays under MCP resource size limits.
    const out: Record<string, string> = {};
    for (const blockType of LINEAGE_BLOCKS) {
      const records = loadLineage(blockType);
      if (records.length === 0) continue;
      const blocks = records.map((rec) => {
        const recordText = formatLineageRecord(rec, true, 3);
        const knobs = formatApplicableKnobs(blockType, rec.am4Name);
        const loudness = formatLoudnessAppendix(rec.am4Name);
        const parts = [recordText, knobs, loudness].filter((s): s is string => Boolean(s));
        return `── ${rec.am4Name} ──\n${parts.join('\n')}`;
      });
      out[blockType] = `${records.length} ${blockType} records:\n\n${blocks.join('\n\n')}`;
    }
    return out;
  },
};
