/**
 * Modern Fractal family, DeviceReader (get_param / get_params).
 *
 * Reads go through the gen-3 fn=0x1F block bulk-read: poll the block, collect
 * its 0x74/0x75(xN)/0x76 state-broadcast burst, and index the POSITIONAL 0x75
 * body. This is the only gen-3 read whose wire shape is byte-confirmed on
 * hardware (FM9 capture 2026-06-03); the fn=0x01 sub=0x09 per-param GET was
 * never observed on the wire, and the sub=0x01 info-GET is a descriptor query,
 * not a value read.
 *
 * ⚠️ The 0x75 body is NOT a flat paramId-indexed vector. It is CHANNEL-BLOCKED:
 * four contiguous copies of every paramId slot (channels A–D), so
 *   broadcast_index = channel × stride + paramId,  stride = itemCount / 4.
 * FM9 capture 2026-06-04 (amp Balance, catalog paramId 2) changed only index
 * 149 = 1×147 + 2 (channel B), with the channel-A copy at index 2 unchanged;
 * itemCount matches exactly (DISTORT 588 = 147×4, REVERB 292 = 73×4), validated
 * by a 5-refuter adversarial pass. The old code indexed `values[paramId]`, which
 * silently read CHANNEL A only; `projectParam` below resolves the requested
 * channel (or refuses when a param differs across channels and none is given).
 * See axe-fx-iii/SYSEX-MAP.md "gen-3 state-broadcast is channel-blocked".
 *
 * Community beta: the burst shape is confirmed on FM9 (front-panel-driven and
 * as the answer to a poll), but our SERVER issuing the poll and reading the reply
 * has not been confirmed end-to-end on hardware. Reads that get no burst time out
 * with a beta-flavored hint rather than asserting a value.
 */
import type {
  DeviceReader,
  DispatchCtx,
  ReadResult,
  BatchReadResult,
  ParamQuery,
  PresetSnapshot,
  PresetSnapshotSlot,
  GetPresetOptions,
  PresetBinaryDump,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import type { ModernFractalCodec, Gen3BlockBulkRead } from 'fractal-midi/axe-fx-iii';
import { buildRequestPresetDump, parseGen3StateBroadcastHead } from 'fractal-midi/axe-fx-iii';
import { parsePresetDump, extractPresetName } from './presetDump.js';
import type { ModernCatalog } from './catalog.js';

/**
 * Send the fn=0x1F poll for `effectId` and collect the 0x74/0x75/0x76 burst.
 *
 * Subscribes BEFORE sending so the device's reply (the burst lands ~1 ms after
 * the poll, often within a single USB callback frame) cannot outrace listener
 * registration. Gates on the 0x74 head's blockId matching `effectId` so an
 * unrelated front-panel broadcast for another block does not corrupt the read.
 *
 * Throws DispatchError('no_ack') when no head arrives within the window, and
 * when the burst is truncated (fewer values than the head advertised), so a
 * partial dump is never silently treated as a complete read.
 */
async function collectBlockBulkRead(
  ctx: DispatchCtx,
  codec: ModernFractalCodec,
  effectId: number,
  deviceLabel: string,
  timeoutMs: number,
): Promise<Gen3BlockBulkRead> {
  const frames: number[][] = [];
  let headSeen = false;
  let nackSeen = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });
  const unsubscribe = ctx.conn.onMessage((bytes) => {
    if (codec.isGen3BroadcastFrame(bytes, 0x74)) {
      if (headSeen) return; // already have our head; ignore duplicate / other blocks
      const { blockId } = parseGen3StateBroadcastHead(bytes);
      if (blockId !== effectId) return; // unrelated broadcast (e.g. a front-panel edit)
      headSeen = true;
      frames.push([...bytes]);
    } else if (codec.isGen3BroadcastFrame(bytes, 0x75)) {
      if (!headSeen) return; // body before our head; drop
      frames.push([...bytes]);
    } else if (codec.isGen3BroadcastFrame(bytes, 0x76)) {
      if (!headSeen) return; // end before our head; drop
      frames.push([...bytes]);
      resolveDone();
    } else if (!headSeen && codec.isMultipurposeResponse(bytes)) {
      // The device NACKs a poll for an UNPLACED block with a fn=0x64
      // multipurpose response instead of a burst. Resolve immediately so a
      // get_preset poll loop does not pay the full timeout for every empty
      // block (turning ~40 empty blocks from ~32s of timeouts into ~2s).
      nackSeen = true;
      resolveDone();
    }
  });
  // The timer always resolves (never rejects), so control returns to the
  // post-await integrity checks below and the no_ack DispatchError they build
  // is the single error surface. A head with no 0x76 (lost end frame) still
  // resolves here; the truncation check catches genuinely incomplete bursts.
  const timer = setTimeout(resolveDone, timeoutMs);
  try {
    ctx.conn.send(codec.buildBlockBulkReadPoll(effectId));
    await done;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  if (!headSeen) {
    throw new DispatchError(
      'no_ack',
      deviceLabel,
      nackSeen
        ? `get_param: ${deviceLabel} answered the fn=0x1F poll for effect ID ${effectId} with a ` +
          `multipurpose NACK, which means the block is not placed in the active preset.`
        : `get_param: no fn=0x74/0x75/0x76 state-broadcast burst from ${deviceLabel} within ${timeoutMs}ms ` +
          `in answer to the fn=0x1F poll for effect ID ${effectId}. Likely causes: the block is not placed ` +
          `in the active preset (gen-3 rejects a poll for an empty block with a multipurpose NACK, not a ` +
          `burst), or the gen-3 poll-to-burst read path is not yet confirmed on this hardware (community beta).`,
    );
  }
  const bulk = codec.assembleGen3BlockBulkRead(frames);
  if (bulk.values.length < bulk.itemCount) {
    throw new DispatchError(
      'no_ack',
      deviceLabel,
      `get_param: truncated state-broadcast burst from ${deviceLabel} for effect ID ${effectId}: ` +
        `the 0x74 head advertised ${bulk.itemCount} params but only ${bulk.values.length} arrived ` +
        `(a 0x75 body frame was lost). Refusing to report a partial dump as a complete read; retry.`,
    );
  }
  return bulk;
}

/** Inter-frame quiet window that terminates the tail-less edit-buffer burst. */
const EDIT_BUFFER_QUIET_MS = 250;

/**
 * Send the fn=0x43 REQUEST_EDIT_BUFFER_DUMP and collect the reply: a 0x51 head
 * + a homogeneous run of 0x52 body frames. The gen-3 edit-buffer dump has NO
 * tail frame (unlike the stored dump's 0x79), so the burst is terminated by
 * "read until quiet": once the head has arrived, each new dump frame re-arms an
 * inter-frame timer, and the burst is complete when no new dump frame lands
 * within `EDIT_BUFFER_QUIET_MS` (or when a non-dump inbound frame arrives).
 * This reads only what the device sends, so it emits no speculative bytes and
 * cannot truncate early (it stops only when the 0x52 frames stop).
 *
 * Subscribes BEFORE the caller sends so the burst can't outrace the listener.
 * Rejects if no 0x51 head arrives within `headTimeoutMs`, or if a head arrives
 * with no 0x52 body (a malformed / empty dump).
 */
function collectEditBufferDump(
  ctx: DispatchCtx,
  codec: ModernFractalCodec,
  headTimeoutMs: number,
): Promise<number[][]> {
  return new Promise<number[][]>((resolve, reject) => {
    const frames: number[][] = [];
    let headSeen = false;
    let settled = false;
    let interTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(headTimer);
      if (interTimer !== undefined) clearTimeout(interTimer);
      unsubscribe();
      if (!headSeen) {
        reject(new Error(`no 0x51 edit-buffer dump head within ${headTimeoutMs}ms`));
      } else if (frames.length < 2) {
        reject(new Error('edit-buffer dump head arrived with no 0x52 body frames'));
      } else {
        resolve(frames);
      }
    };
    const armQuietTimer = (): void => {
      if (interTimer !== undefined) clearTimeout(interTimer);
      interTimer = setTimeout(finish, EDIT_BUFFER_QUIET_MS);
    };
    const unsubscribe = ctx.conn.onMessage((bytes) => {
      if (codec.isEditBufferDumpHead(bytes)) {
        if (headSeen) return; // ignore an unexpected second head
        headSeen = true;
        clearTimeout(headTimer); // initial-head guard satisfied
        frames.push([...bytes]);
        armQuietTimer();
      } else if (headSeen && codec.isEditBufferDumpBody(bytes)) {
        frames.push([...bytes]);
        armQuietTimer();
      } else if (headSeen) {
        finish(); // a non-dump inbound frame after the burst started ends it
      }
      // Frames before the head are ignored (stray broadcasts).
    });
    const headTimer = setTimeout(finish, headTimeoutMs);
  });
}

/**
 * Send fn=0x03 REQUEST_PRESET_DUMP for `presetNum` and collect the
 * 0x77 head + 0x78 body frames + 0x79 tail. Wire-confirmed on FM9 fw 11.00
 * (capture 2026-06-04): host sends `F0 00 01 74 <model> 03 <hi> <lo> <cs> F7`,
 * device replies with one 0x77 (13 B), N x 0x78 body frames (3082 B each), and
 * one 0x79 tail (11 B). Frame count varies by device (FM9 = 8 chunks).
 *
 * Subscribes BEFORE sending so the burst cannot outrace the listener.
 * Rejects if no 0x77 head arrives within `timeoutMs`, or if the head arrives
 * with no 0x78 body frames.
 */
function collectStoredPresetDump(
  ctx: DispatchCtx,
  codec: ModernFractalCodec,
  presetNum: number,
  deviceLabel: string,
  timeoutMs: number,
): Promise<number[][]> {
  // fn bytes for the stored-preset dump triple.
  const FN_HEAD = 0x77;
  const FN_BODY = 0x78;
  const FN_TAIL = 0x79;
  const isHead = (b: number[]): boolean => b[5] === FN_HEAD;
  const isBody = (b: number[]): boolean => b[5] === FN_BODY;
  const isTail = (b: number[]): boolean => b[5] === FN_TAIL;

  return new Promise<number[][]>((resolve, reject) => {
    const frames: number[][] = [];
    let headSeen = false;
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(headTimer);
      unsubscribe();
      if (err !== undefined) {
        reject(err);
      } else if (!headSeen) {
        reject(new Error(`no fn=0x77 stored-preset dump head from ${deviceLabel} within ${timeoutMs}ms`));
      } else if (frames.length < 2) {
        reject(new Error(`stored-preset dump head arrived with no fn=0x78 body frames from ${deviceLabel}`));
      } else {
        resolve(frames);
      }
    };
    const unsubscribe = ctx.conn.onMessage((bytes) => {
      const arr = [...bytes];
      if (isHead(arr)) {
        if (headSeen) return; // unexpected second head; ignore
        headSeen = true;
        clearTimeout(headTimer);
        frames.push(arr);
      } else if (headSeen && isBody(arr)) {
        frames.push(arr);
      } else if (headSeen && isTail(arr)) {
        frames.push(arr);
        finish();
      } else if (headSeen && !isBody(arr) && !isTail(arr)) {
        // A non-dump inbound frame after the burst started ends it.
        finish();
      }
      // Frames before the head are ignored (stray broadcasts).
    });
    const headTimer = setTimeout(() => finish(), timeoutMs);
    // Send AFTER subscribing.
    ctx.conn.send(buildRequestPresetDump(presetNum, codec.modelByte));
  });
}

export function makeReader(opts: {
  codec: ModernFractalCodec;
  catalog: ModernCatalog;
  deviceLabel: string;
  getResponseTimeoutMs: number;
  /** Channel names in wire-index order (A,B,C,D). Index i == channel i. */
  channelNames: readonly string[];
}): DeviceReader {
  const { codec, catalog, deviceLabel, getResponseTimeoutMs, channelNames } = opts;
  const { resolveBlockOrThrow, resolveParamOrThrow } = catalog;

  // The gen-3 0x75 state-broadcast is CHANNEL-BLOCKED: the body packs four
  // contiguous copies of every paramId slot (channel-major), so
  //   broadcast_index = channel × stride + paramId,  stride = itemCount / 4.
  // FM9 capture 2026-06-04 (amp Balance, paramId 2) changed only index 149 =
  // 1×147 + 2 (channel B); the channel-A copy at index 2 stayed constant. The
  // ×4 is the A–D channels (0x13 STATUS_DUMP, dd bits 3:1). itemCount matches
  // exactly: DISTORT 588 = 147×4, REVERB 292 = 73×4. Indexing values[paramId]
  // (the old code) therefore only read CHANNEL A; this projects the requested
  // channel instead. See axe-fx-iii/SYSEX-MAP.md.
  const NUM_CHANNELS = 4;

  /** Per-channel stride of a bulk dump, or a single flat channel when the dump
   *  isn't 4-channel-blocked (so non-conforming blocks degrade safely). */
  function strideOf(bulk: Gen3BlockBulkRead): { stride: number; channels: number } {
    if (bulk.itemCount > 0 && bulk.itemCount % NUM_CHANNELS === 0
        && bulk.values.length >= bulk.itemCount) {
      return { stride: bulk.itemCount / NUM_CHANNELS, channels: NUM_CHANNELS };
    }
    return { stride: bulk.values.length, channels: 1 };
  }

  /** Normalize a channel arg (already a 0-based index from the dispatcher, but
   *  tolerate a name string) to a channel index, or undefined if unspecified. */
  function channelArgToIndex(channel?: string | number): number | undefined {
    if (channel === undefined) return undefined;
    if (typeof channel === 'number') {
      return Number.isInteger(channel) && channel >= 0 ? channel : undefined;
    }
    const idx = channelNames.findIndex((c) => c.toUpperCase() === channel.toUpperCase());
    return idx >= 0 ? idx : undefined;
  }

  /**
   * Project one param out of a (possibly cached) whole-block bulk dump, honoring
   * the channel-blocked broadcast layout (index = channel × stride + paramId).
   *
   * Channel selection:
   *  - explicit `channel` arg → read that channel's copy (always correct);
   *  - no channel + the param is identical across all channels → return it
   *    (the common case: channel only differs for params the user varied);
   *  - no channel + the copies differ → refuse and list every channel's value,
   *    so the caller can re-ask with a channel rather than get a silent guess.
   */
  function projectParam(
    blockSlug: string,
    name: string,
    param: { paramId: number; unit: string },
    bulk: Gen3BlockBulkRead,
    channel?: string | number,
  ): ReadResult {
    const { stride, channels } = strideOf(bulk);
    if (param.paramId >= stride) {
      throw new DispatchError(
        'no_ack',
        deviceLabel,
        `get_param: ${blockSlug}.${name} (paramId ${param.paramId}) is past the end of the ` +
          `${stride}-param block dump from ${deviceLabel} (head advertised ${bulk.itemCount} = ` +
          `${channels}×${stride}). The block may have paged a shorter dump than its catalog, or the ` +
          `param is not exposed by the active block type.`,
      );
    }
    const schema = catalog.blocks[blockSlug]?.params[name];
    const decode = (w: number): number | string => (schema !== undefined ? schema.decode(w) : w);
    const copyAt = (c: number): number => bulk.values[c * stride + param.paramId];

    let wire: number;
    const want = channelArgToIndex(channel);
    if (channels === 1) {
      wire = copyAt(0);
    } else if (want !== undefined) {
      if (want >= channels) {
        throw new DispatchError(
          'bad_channel',
          deviceLabel,
          `get_param: channel index ${want} is out of range for ${blockSlug}.${name} ` +
            `(this block broadcasts ${channels} channels: ${channelNames.slice(0, channels).join('/')}).`,
        );
      }
      wire = copyAt(want);
    } else {
      const copies = Array.from({ length: channels }, (_, c) => copyAt(c));
      if (copies.every((v) => v === copies[0])) {
        wire = copies[0]; // channel-invariant — no channel needed
      } else {
        const shown = copies
          .map((v, c) => `${channelNames[c] ?? c}=${decode(v)}`)
          .join(', ');
        throw new DispatchError(
          'bad_channel',
          deviceLabel,
          `get_param: ${blockSlug}.${name} differs across channels (${shown}). The gen-3 state ` +
            `broadcast holds one value per channel; specify which channel to read ` +
            `(e.g. channel "${channelNames[0]}").`,
          { valid_options: channelNames.slice(0, channels) as string[] },
        );
      }
    }
    // Label/decode via the catalog's ParamSchema (enum read leg from the S1
    // overlay; raw passthrough otherwise). Fall back to raw wire if absent.
    return {
      block: blockSlug,
      name,
      wire_value: wire,
      display_value: decode(wire),
      unit: param.unit,
    };
  }

  const reader: DeviceReader = {
    async getParam(
      ctx: DispatchCtx,
      blockSlugIn: string,
      name: string,
      channel?: string | number,
      instance?: number,
    ): Promise<ReadResult> {
      const { effectId } = resolveBlockOrThrow(blockSlugIn, deviceLabel, instance);
      const { param } = resolveParamOrThrow(blockSlugIn, name, deviceLabel);
      const bulk = await collectBlockBulkRead(ctx, codec, effectId, deviceLabel, getResponseTimeoutMs);
      return projectParam(blockSlugIn, name, param, bulk, channel);
    },

    // Structured (non-byte-exact) whole-preset snapshot via the fn=0x1F poll
    // loop: poll every catalogued block; the ones that answer with a burst are
    // placed (unplaced blocks NACK fast, so the loop is ~1-2s, not ~30s of
    // timeouts). This is a BLOCK INVENTORY, not a positioned grid read: gen-3
    // has no decoded grid-read, so slot indices are sequential placeholders,
    // not row/col, and the snapshot is not round-trippable through
    // apply_preset by position. Community beta, server-driven poll not yet
    // hardware-confirmed end to end.
    async getPreset(ctx: DispatchCtx, _options?: GetPresetOptions): Promise<PresetSnapshot> {
      const readStartedMs = Date.now();
      // Short per-block cap: a real burst lands in ~1ms and an unplaced block
      // NACKs nearly as fast; this only bounds a block that neither answers.
      const POLL_TIMEOUT_MS = Math.min(250, getResponseTimeoutMs);
      const slots: PresetSnapshotSlot[] = [];
      const warnings: string[] = [];
      let placedIndex = 0;
      for (const slug of Object.keys(catalog.blocks)) {
        let effectId: number;
        try {
          ({ effectId } = resolveBlockOrThrow(slug, deviceLabel));
        } catch {
          continue; // block exposes no effect id; not pollable
        }
        let bulk;
        try {
          bulk = await collectBlockBulkRead(ctx, codec, effectId, deviceLabel, POLL_TIMEOUT_MS);
        } catch {
          continue; // not placed (NACK) or no answer
        }
        placedIndex++;
        const blockParams = catalog.blocks[slug].params;
        const params: Record<string, number | string> = {};
        // The 0x75 broadcast is channel-blocked (index = channel × stride + paramId);
        // a whole-preset snapshot reads the CHANNEL-A copy (paramId < stride) for each
        // param. Per-channel values for a specific channel come from get_param with a
        // channel arg; channel-A is the stable, documented default here.
        const { stride } = strideOf(bulk);
        for (const key of Object.keys(blockParams)) {
          let paramId: number;
          try {
            paramId = resolveParamOrThrow(slug, key, deviceLabel).param.paramId;
          } catch {
            continue;
          }
          if (paramId < stride) {
            params[key] = blockParams[key].decode(bulk.values[paramId]);
          }
        }
        // slot is a sequential placeholder (no grid position is read on gen-3).
        slots.push({ slot: placedIndex, block_type: slug, params });
      }
      warnings.push(
        'gen-3 get_preset is a block inventory, not a positioned grid read: slot indices are ' +
          'sequential placeholders (no decoded grid read), so the snapshot is not round-trippable ' +
          'through apply_preset by position. Per-channel params are reported as their channel-A ' +
          'copy (use get_param with a channel arg for a specific channel). Enum params read back ' +
          'as ordinal labels; uncalibrated continuous params read back as raw wire values. ' +
          'Community beta: the server-driven fn=0x1F poll is not yet hardware-confirmed end to end.',
      );
      return {
        name: undefined,
        slots,
        read_warnings: warnings,
        _meta: {
          device: deviceLabel,
          read_at_ms: readStartedMs,
          active_scene_only: true,
          routing_omitted: true,
          channel_state_omitted: true,
          read_duration_ms: Date.now() - readStartedMs,
        },
      };
    },

    // Byte-exact backup of the ACTIVE working buffer via the gen-3 edit-buffer
    // dump (fn=0x43 → 0x51 head + 0x52 body run, no tail). Backs export_preset.
    // The frames are concatenated verbatim into a .syx the user can keep; the
    // inner layout is treated as opaque (a blob round-trips regardless). The
    // request is FM9-confirmed (no args); III/FM3/VP4 share the gen-3 codec but
    // are not yet hardware-confirmed for this path, so a device that does not
    // answer times out with a beta-flavored no_ack rather than a partial dump.
    async dumpActivePresetBinary(ctx: DispatchCtx): Promise<PresetBinaryDump> {
      // Subscribe before sending so the burst can't outrace the listener.
      const framesPromise = collectEditBufferDump(ctx, codec, getResponseTimeoutMs);
      ctx.conn.send(codec.buildRequestEditBufferDump());
      let frames: number[][];
      try {
        frames = await framesPromise;
      } catch (err) {
        throw new DispatchError(
          'no_ack',
          deviceLabel,
          `export_preset: no edit-buffer dump from ${deviceLabel}. ${err instanceof Error ? err.message : String(err)}. ` +
            `The gen-3 edit-buffer dump (fn=0x43) is FM9-confirmed; III/FM3/VP4 share the gen-3 codec but are not yet ` +
            `hardware-confirmed for this path. Check the device is connected and an editor isn't holding the port ` +
            `(try reconnect_midi).`,
        );
      }
      // Flatten the frames into the verbatim .syx byte stream (opaque blob).
      const flat: number[] = [];
      for (const f of frames) for (const b of f) flat.push(b);
      const bytes = Uint8Array.from(flat);
      return {
        bytes,
        byte_length: bytes.length,
        frame_count: frames.length,
        format: 'fractal-modern-edit-buffer-dump',
        source: 'active working buffer (gen-3 edit-buffer dump, fn=0x43)',
      };
    },

    // Byte-exact backup of a STORED preset via the gen-3 stored-preset dump
    // (fn=0x03 request -> 0x77 head + 0x78 body run + 0x79 tail). Wire-confirmed
    // on FM9 fw 11.00 (capture 2026-06-04): host sends REQUEST_PRESET_DUMP and
    // the device replies with the same 0x77/0x78/0x79 chain used for file export.
    // The frames are concatenated verbatim; the inner layout is treated as opaque.
    async dumpStoredPresetBinary(location: number, ctx: DispatchCtx): Promise<PresetBinaryDump> {
      let frames: number[][];
      try {
        frames = await collectStoredPresetDump(ctx, codec, location, deviceLabel, getResponseTimeoutMs);
      } catch (err) {
        throw new DispatchError(
          'no_ack',
          deviceLabel,
          `export_preset: no stored-preset dump from ${deviceLabel} for preset ${location}. ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `The gen-3 stored-preset dump (fn=0x03) is FM9-confirmed; III/FM3/VP4 share the gen-3 codec ` +
            `but are not yet hardware-confirmed for this path. Check the preset number is valid and ` +
            `the device is connected (try reconnect_midi).`,
        );
      }
      // Flatten the frames into the verbatim .syx byte stream (opaque blob).
      const flat: number[] = [];
      for (const f of frames) for (const b of f) flat.push(b);
      const bytes = Uint8Array.from(flat);
      // Try to extract the preset name from the dump for the filename.
      let name: string | undefined;
      try {
        const parsed = parsePresetDump(bytes, 0, codec.modelByte);
        const extracted = extractPresetName(parsed);
        if (extracted.length > 0) name = extracted;
      } catch {
        // Name extraction is best-effort; a corrupt header is not a fatal error.
      }
      return {
        bytes,
        byte_length: bytes.length,
        frame_count: frames.length,
        format: 'fractal-modern-stored-preset-dump',
        source: `stored preset location ${location}`,
        name,
      };
    },

    async getParams(
      ctx: DispatchCtx,
      queries: readonly ParamQuery[],
    ): Promise<BatchReadResult> {
      const reads: ReadResult[] = [];
      const failed: number[] = [];
      const errors: Record<number, string> = {};
      // One bulk read per distinct block: a batch over several params of the
      // same block polls the device once, not once per param. Failures are
      // cached too, so a batch over several DISTINCT dead blocks does not pay a
      // full timeout per query (only once per distinct effectId).
      const cache = new Map<number, { bulk?: Gen3BlockBulkRead; err?: string }>();
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        try {
          const { effectId } = resolveBlockOrThrow(q.block, deviceLabel, q.instance);
          const { param } = resolveParamOrThrow(q.block, q.name, deviceLabel);
          let entry = cache.get(effectId);
          if (entry === undefined) {
            try {
              entry = { bulk: await collectBlockBulkRead(ctx, codec, effectId, deviceLabel, getResponseTimeoutMs) };
            } catch (pollErr) {
              entry = { err: pollErr instanceof Error ? pollErr.message : String(pollErr) };
            }
            cache.set(effectId, entry);
          }
          if (entry.err !== undefined) throw new DispatchError('no_ack', deviceLabel, entry.err);
          reads.push(projectParam(q.block, q.name, param, entry.bulk!, q.channel));
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
  };
  return reader;
}
