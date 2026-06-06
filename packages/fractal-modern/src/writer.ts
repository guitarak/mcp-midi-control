/**
 * Modern Fractal family — DeviceWriter.
 *
 * `makeWriter` binds the gen-3 codec (model byte) + the device shape
 * (grid dims, scene count, channel names, preset count) + the per-
 * response beta warning. Every emitted frame is a spec-documented or
 * III-capture-verified envelope with this device's model byte — never a
 * guessed wire shape (preference_axefx3_no_untested_wire_paths). The
 * device's 0x64 MULTIPURPOSE_RESPONSE error channel catches malformed
 * requests, which we surface inline rather than silently corrupting state.
 */
import type {
  DeviceWriter,
  DispatchCtx,
  BatchWriteResult,
  WriteOp,
  WriteResult,
  BlockChange,
  PresetSpec,
  LocationRef,
  SlotRef,
  RenameTarget,
  ApplyResult,
  ApplyPresetOptions,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { markDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import { resolveEffectId, parseGen3SetValueEcho, ROUTING_OP_CONNECT, ROUTING_OP_DISCONNECT, type ModernFractalCodec } from 'fractal-midi/axe-fx-iii';
import type { ModernCatalog } from './catalog.js';
import { makeGuard } from './guard.js';

/**
 * Hard ceiling on total wall-clock for one gen-3 apply_preset wire burst.
 * Each write waits up to its reject window (120-250 ms) for a 0x64; if the
 * device goes silent mid-burst those waits pile up, so apply_preset aborts
 * with a structured partial result rather than walking every remaining write.
 * Mirrors the AM4 apply budget (the v0.1.0 multi-minute-hang incident) and
 * shares its env override, MCP_APPLY_BUDGET_MS (tests set a tiny value).
 */
const GEN3_APPLY_BUDGET_MS = (() => {
  const env = Number(process.env.MCP_APPLY_BUDGET_MS);
  return Number.isFinite(env) && env > 0 ? env : 50_000;
})();

export interface WriterShape {
  id: string;
  /** Grid dimensions for grid-shaped devices; undefined for serial (VP4). */
  grid?: { rows: number; cols: number };
  /** Serial slot count for AM4-shape devices (VP4 = 4); undefined for grid. */
  slot_count?: number;
  scene_count: number;
  channel_names: readonly string[];
  preset_count: number;
  /** Whether STORE is spec-supported (false for III/FM3/FM9 → gate auto-save). */
  supportsSave: boolean;
  /**
   * When true, every device-state write refuses with a clear "untested on
   * hardware" message (VP4: param/block write path inferred-not-confirmed,
   * placement wire shape undecoded). Reads are unaffected. Defaults false.
   */
  writesGated?: boolean;
}

export function makeWriter(opts: {
  codec: ModernFractalCodec;
  catalog: ModernCatalog;
  shape: WriterShape;
  deviceLabel: string;
  connectionLabel: string;
  betaWarning: string;
  getResponseTimeoutMs: number;
}): DeviceWriter {
  const { codec, catalog, shape, deviceLabel, connectionLabel, betaWarning, getResponseTimeoutMs } = opts;
  const { resolveBlockOrThrow, resolveParamOrThrow } = catalog;
  const BETA_WARNING = betaWarning;
  const channelValues: Readonly<Record<string, number>> = Object.freeze(
    Object.fromEntries(shape.channel_names.map((c, i) => [c.toUpperCase(), i])),
  );

  /**
   * Refuse a device-state write on a write-gated device. The gen-3 param/block
   * write path is inferred from the III/AM4 codec but is NOT confirmed on this
   * device's hardware, and (for the serial VP4) the block-placement wire shape
   * is undecoded, so emitting any write risks silently corrupting state with no
   * acked confirmation. Reads (get_param / get_preset) stay live; writes refuse
   * until a hardware capture lands. No-op on non-gated devices (III/FM3/FM9).
   */
  function gateWrite(op: string): void {
    if (!shape.writesGated) return;
    throw new DispatchError(
      'capability_not_supported',
      deviceLabel,
      `${shape.id} ${op}: device-state writes are GATED on ${deviceLabel}. The parameter/block ` +
        `write path is inferred from the gen-3 codec but is not yet confirmed on this device's ` +
        `hardware, and its block-placement wire shape is undecoded. Reads (get_param / get_preset) ` +
        `work; writes refuse until a hardware capture lands. ${BETA_WARNING}`,
    );
  }

  function parseLocation(location: LocationRef): number {
    const max = shape.preset_count - 1;
    const n = typeof location === 'number' ? location : Number(location);
    if (!Number.isInteger(n) || n < 0 || n > max) {
      throw new DispatchError(
        'bad_location',
        deviceLabel,
        `${shape.id}: preset location '${location}' is invalid (expected integer 0..${max}).`,
      );
    }
    return n;
  }

  function formatErrorCode(report: { resultCode: number; description?: string }): string {
    const hex = `0x${report.resultCode.toString(16).padStart(2, '0')}`;
    return report.description !== undefined
      ? `${report.description} (${hex})`
      : `unknown result code ${hex}`;
  }

  /**
   * Send a frame and watch for a 0x64 MULTIPURPOSE_RESPONSE rejection in
   * a short window. The device emits 0x64 only on rejection — no echo on
   * accept — so the predicate is "rejection came back".
   */
  async function sendAndWatchForError(
    ctx: DispatchCtx,
    bytes: number[],
    // The device emits 0x64 only on rejection (no positive ack), and a SysEx
    // round-trip is 30-60 ms per the performance budget, so a 50 ms window
    // could close before a genuine rejection arrives and report a rejected
    // write as accepted. Structural ops (set_block/set_bypass/switch_scene/
    // save/rename/routing) are infrequent, so a generous window costs little
    // latency and ensures a rejection is never missed.
    windowMs = 250,
  ): Promise<{ resultCode: number; description?: string } | undefined> {
    const watchPromise = ctx.conn.receiveSysExMatching(
      (b) => codec.isMultipurposeResponse(b),
      windowMs,
    );
    ctx.conn.send(bytes);
    try {
      const frame = await watchPromise;
      const parsed = codec.parseMultipurposeResponse(frame);
      return {
        resultCode: parsed.resultCode,
        description: codec.describeMultipurposeResultCode(parsed.resultCode),
      };
    } catch {
      return undefined; // No rejection within window → write accepted.
    }
  }

  /**
   * Send a SET frame and, within a short window, watch for EITHER:
   *   - a 0x64 MULTIPURPOSE_RESPONSE rejection, or
   *   - the synchronous 60-byte fn=0x01 value-echo whose effectId+paramId
   *     match this write. The echo carries the device's quantized value as a
   *     NORMALIZED float32 ([0,1] = wire16/65534 for continuous params), so a
   *     write can confirm in display units rather than reporting the value we
   *     sent.
   *
   * The echo is parsed opportunistically: our typed-SET (sub=0x09) echo is not
   * yet hardware-confirmed (the FM9 capture used the editor's own sub-action),
   * so a missing echo is the expected case and resolves as a plain accept.
   * Parsing inbound bytes emits nothing on the wire.
   */
  async function sendAndWatchSetResponse(
    ctx: DispatchCtx,
    bytes: number[],
    effectId: number,
    paramId: number,
    // Per-param SET is on the apply_preset hot path, so this window is kept
    // tighter than the structural-op window, but still above the 30-60 ms
    // round-trip so a 0x64 rejection is not missed. An inbound value-echo or
    // rejection resolves early; only the silent-accept path waits the window.
    windowMs = 120,
  ): Promise<
    | { kind: 'reject'; resultCode: number; description?: string }
    | { kind: 'echo'; normalizedValue: number }
    | { kind: 'accept' }
  > {
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (
        r:
          | { kind: 'reject'; resultCode: number; description?: string }
          | { kind: 'echo'; normalizedValue: number }
          | { kind: 'accept' },
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof unsubscribe === 'function') unsubscribe();
        resolve(r);
      };
      const unsubscribe = ctx.conn.onMessage((frame) => {
        if (codec.isMultipurposeResponse(frame)) {
          const parsed = codec.parseMultipurposeResponse(frame);
          finish({
            kind: 'reject',
            resultCode: parsed.resultCode,
            description: codec.describeMultipurposeResultCode(parsed.resultCode),
          });
          return;
        }
        // Opportunistic value-echo: a fn=0x01 frame for OUR effectId+paramId.
        // parse throws on any other frame shape (broadcasts, GET responses),
        // which we swallow and keep waiting.
        try {
          const echo = parseGen3SetValueEcho(frame);
          if (echo.effectId === effectId && echo.paramId === paramId) {
            finish({ kind: 'echo', normalizedValue: echo.normalizedValue });
          }
        } catch {
          // not a value-echo; ignore.
        }
      });
      const timer = setTimeout(() => finish({ kind: 'accept' }), windowMs);
      ctx.conn.send(bytes);
    });
  }

  /**
   * Turn a SET value-echo's normalized float ([0,1]) into a display-unit
   * value via the param's catalog schema. Continuous params normalize as
   * wire16/65534, so the device-quantized wire is `round(normalized*65534)`
   * and we decode that. Enum / display-only params normalize as
   * `index/(count-1)`, which doesn't invert cleanly without the vocab size,
   * so for those we return undefined and the caller falls back to decoding
   * the value it sent.
   */
  function echoToDisplay(
    blockSlug: string,
    name: string,
    normalizedValue: number,
  ): { wire: number; display: number | string } | undefined {
    const schema = catalog.blocks[blockSlug]?.params[name];
    if (schema === undefined) return undefined;
    if (schema.enum_values !== undefined) return undefined; // enum: not a wire16 normalize
    if (!Number.isFinite(normalizedValue)) return undefined;
    const wire = Math.round(Math.min(1, Math.max(0, normalizedValue)) * 65534);
    return { wire, display: schema.decode(wire) };
  }

  /** Decode a value we SENT through the param's schema, for display-unit
   *  confirmation when no device echo is available. Falls back to the raw
   *  wire integer when the block/param has no schema. */
  function sentToDisplay(blockSlug: string, name: string, wireValue: number): number | string {
    const schema = catalog.blocks[blockSlug]?.params[name];
    return schema !== undefined ? schema.decode(wireValue) : wireValue;
  }

  const writer: DeviceWriter = {
    buildSetParam(block: string, name: string, wireValue: number): number[] {
      const { effectId } = resolveBlockOrThrow(block, deviceLabel);
      const { param } = resolveParamOrThrow(block, name, deviceLabel);
      return codec.buildSetParameter(effectId, param.paramId, wireValue);
    },

    buildSwitchPreset(location: LocationRef): number[] {
      return codec.buildSwitchPresetPC(parseLocation(location));
    },

    buildSwitchScene(scene: number): number[] {
      // Unified surface scene numbers are 1-indexed (display); wire is 0-indexed.
      return codec.buildSetScene(scene - 1);
    },

    async setParam(
      ctx: DispatchCtx,
      blockSlugIn: string,
      name: string,
      wireValue: number,
      _channel?: number,
      instance?: number,
    ): Promise<WriteResult> {
      gateWrite('set_param');
      const { effectId } = resolveBlockOrThrow(blockSlugIn, deviceLabel, instance);
      const { param } = resolveParamOrThrow(blockSlugIn, name, deviceLabel);
      const bytes = codec.buildSetParameter(effectId, param.paramId, wireValue);
      const response = await sendAndWatchSetResponse(ctx, bytes, effectId, param.paramId);
      // fn=0x01 is dual-purpose with no byte-level SET/GET discriminator,
      // so SET handlers mark dirty explicitly; GET handlers don't.
      markDirty(connectionLabel);
      if (response.kind === 'reject') {
        const desc = response.description
          ? `${response.description} (code 0x${response.resultCode.toString(16).padStart(2, '0')})`
          : `unknown result code 0x${response.resultCode.toString(16).padStart(2, '0')}`;
        return {
          op: 'set_param',
          target: `${blockSlugIn}.${name}`,
          block: blockSlugIn,
          name,
          wire_value: wireValue,
          display_value: sentToDisplay(blockSlugIn, name, wireValue),
          acked: false,
          warning:
            `${deviceLabel} rejected set_param via 0x64 MULTIPURPOSE_RESPONSE: ${desc}. ` +
            BETA_WARNING,
        };
      }
      // Accepted. Prefer the device's quantized value-echo when one arrived
      // (display units via calibration); otherwise confirm with the value we
      // sent, decoded to display units.
      const echoDisplay =
        response.kind === 'echo'
          ? echoToDisplay(blockSlugIn, name, response.normalizedValue)
          : undefined;
      return {
        op: 'set_param',
        target: `${blockSlugIn}.${name}`,
        block: blockSlugIn,
        name,
        wire_value: echoDisplay?.wire ?? wireValue,
        display_value: echoDisplay?.display ?? sentToDisplay(blockSlugIn, name, wireValue),
        acked: true,
        warning: BETA_WARNING,
      };
    },

    async setParams(ctx: DispatchCtx, ops: readonly WriteOp[]): Promise<BatchWriteResult> {
      gateWrite('set_params');
      const writes: WriteResult[] = [];
      let ackedCount = 0;
      let unackedCount = 0;
      for (const op of ops) {
        const wireValue = typeof op.value === 'number' ? op.value : Number(op.value);
        const result = await writer.setParam!(ctx, op.block, op.name, wireValue, op.channel, op.instance);
        writes.push(result);
        if (result.acked) ackedCount += 1;
        else unackedCount += 1;
      }
      return { writes, acked_count: ackedCount, unacked_count: unackedCount };
    },

    async setBlock(
      ctx: DispatchCtx,
      slot: SlotRef,
      change: BlockChange,
    ): Promise<WriteResult> {
      gateWrite('set_block');
      const grid = shape.grid;
      if (grid === undefined) {
        // Serial AM4-shape devices place blocks by slot index, not grid cell.
        // The serial block-placement wire shape is undecoded, so this path is
        // unreachable on a gated device (gateWrite already threw) and refuses
        // defensively on any future non-gated serial device.
        throw new DispatchError(
          'capability_not_supported',
          deviceLabel,
          `${shape.id} setBlock: serial block placement is not wired (the block-placement ` +
            `wire shape is undecoded for ${deviceLabel}).`,
        );
      }
      if (typeof slot === 'number') {
        throw new DispatchError(
          'value_out_of_range',
          deviceLabel,
          `${shape.id} setBlock: slot must be {row, col} (grid coords). Got linear index ${slot}. ` +
            `${deviceLabel} uses a ${grid.rows}×${grid.cols} grid; pass slot as ` +
            `{row: 1..${grid.rows}, col: 1..${grid.cols}}.`,
        );
      }
      // Grid-bound check. buildSetGridCell now takes the row count (we pass
      // grid.rows below), but its column backstop is the III's 14, so a
      // smaller device (FM3 is 4 cols) would otherwise encode an out-of-grid
      // cell with no error. Reject against this device's real shape first.
      if (
        slot.row < 1 || slot.row > grid.rows ||
        slot.col < 1 || slot.col > grid.cols
      ) {
        throw new DispatchError(
          'value_out_of_range',
          deviceLabel,
          `${shape.id} setBlock: slot {row:${slot.row}, col:${slot.col}} is outside ` +
            `${deviceLabel}'s ${grid.rows}×${grid.cols} grid ` +
            `(valid: row 1..${grid.rows}, col 1..${grid.cols}).`,
        );
      }
      if (change.bypassed !== undefined && change.block_type === undefined) {
        throw new DispatchError(
          'value_out_of_range',
          deviceLabel,
          `${shape.id} setBlock: bypass-only changes require block_type to resolve the effect ID. ` +
            'For a pure bypass toggle, call set_bypass with the block name instead.',
        );
      }
      if (change.block_type === undefined) {
        throw new DispatchError(
          'value_out_of_range',
          deviceLabel,
          `${shape.id} setBlock: block_type is required (or "none" / "empty" / "shunt" to clear the cell).`,
        );
      }
      const blockType = change.block_type.trim().toLowerCase();
      let blockId: number;
      if (blockType === 'none' || blockType === 'empty' || blockType === '') {
        blockId = 0; // 0 clears the cell per II convention
      } else {
        try {
          // instance selects which block of the type (Amp 2 = effect id 59);
          // default 1 keeps single-instance placements byte-identical.
          blockId = resolveEffectId(change.block_type, change.instance ?? 1);
        } catch (err) {
          throw new DispatchError(
            'unknown_block',
            deviceLabel,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      const bytes = codec.buildSetGridCell({ row: slot.row, col: slot.col, blockId, rows: grid.rows });
      const errorReport = await sendAndWatchForError(ctx, bytes);
      // The block insert rides the dual-purpose fn=0x01 (sub=0x32), so the
      // connection-level edit classifier can't flag it by function byte alone;
      // mark dirty explicitly here, as set_param does.
      markDirty(connectionLabel);
      if (errorReport !== undefined) {
        return {
          op: 'set_block',
          target: `r${slot.row}c${slot.col}`,
          acked: false,
          warning:
            `${deviceLabel} rejected set_block via 0x64 MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. ` +
            BETA_WARNING,
        };
      }
      return {
        op: 'set_block',
        target: `r${slot.row}c${slot.col}`,
        acked: true,
        display_value: blockType === 'none' || blockType === 'empty' ? 'cleared' : change.block_type,
        warning:
          `🟡 ${shape.id} set_block: sent the gen-3 block-insert op ` +
          '(fn=0x01 sub=0x32, wire-confirmed from the editors). ' +
          'Device emitted no rejection but device-side persistence is not yet ' +
          'hardware-verified; confirm by checking the grid layout on the device. ' + BETA_WARNING,
      };
    },

    async setBypass(
      ctx: DispatchCtx,
      block: string,
      bypassed: boolean,
      instance?: number,
    ): Promise<WriteResult> {
      gateWrite('set_bypass');
      let effectId: number;
      try {
        effectId = resolveEffectId(block, instance ?? 1);
      } catch (err) {
        throw new DispatchError(
          'unknown_block',
          deviceLabel,
          err instanceof Error ? err.message : String(err),
        );
      }
      const bytes = codec.buildSetBypass(effectId, bypassed);
      const errorReport = await sendAndWatchForError(ctx, bytes);
      if (errorReport !== undefined) {
        return {
          op: 'set_bypass',
          target: block,
          acked: false,
          warning:
            `${deviceLabel} rejected set_bypass via 0x64 MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. ` +
            BETA_WARNING,
        };
      }
      return {
        op: 'set_bypass',
        target: block,
        acked: true,
        display_value: bypassed ? 'bypassed' : 'engaged',
        warning:
          `🟡 ${shape.id} set_bypass: spec-documented (function 0x0A). Targets the ACTIVE ` +
          'scene only; per spec, the modern family has no per-scene bypass write. ' + BETA_WARNING,
      };
    },

    async applyPreset(
      ctx: DispatchCtx,
      spec: PresetSpec,
      target?: LocationRef,
      options?: ApplyPresetOptions,
    ): Promise<ApplyResult> {
      gateWrite('apply_preset');
      const writes: WriteResult[] = [];
      let anyFailed = false;

      // Total-burst budget: each write can wait its full reject window, so a
      // device that goes silent mid-burst would otherwise stack N waits into a
      // multi-minute hang (the v0.1.0 AM4 incident class). overBudget() pushes a
      // single structured abort write the first time the ceiling is crossed and
      // returns true thereafter so the remaining phases skip cleanly.
      const applyStartMs = Date.now();
      let budgetExceeded = false;
      const overBudget = (): boolean => {
        if (budgetExceeded) return true;
        if (Date.now() - applyStartMs <= GEN3_APPLY_BUDGET_MS) return false;
        budgetExceeded = true;
        anyFailed = true;
        const elapsed = Date.now() - applyStartMs;
        writes.push({
          op: 'apply_preset',
          target: 'apply_preset',
          acked: false,
          warning:
            `${shape.id} apply_preset: total budget (${GEN3_APPLY_BUDGET_MS} ms) exceeded after ${elapsed} ms; ` +
            `remaining writes skipped — the device likely went silent mid-burst. ${BETA_WARNING}`,
        });
        console.error(
          `apply_preset ABORTED (${shape.id}): budget ${GEN3_APPLY_BUDGET_MS} ms exceeded after ` +
            `${writes.length} step(s), elapsed=${elapsed} ms`,
        );
        return true;
      };

      // 1. Place blocks (set_block per slot)
      for (const slotSpec of spec.slots) {
        if (overBudget()) break;
        if (typeof slotSpec.slot !== 'object') {
          writes.push({
            op: 'set_block',
            target: String(slotSpec.slot),
            acked: false,
            warning:
              `${shape.id} apply_preset: skipped slot ${String(slotSpec.slot)}: ` +
              'linear slot indexing not supported on grid device.',
          });
          anyFailed = true;
          continue;
        }
        try {
          const result = await writer.setBlock!(ctx, slotSpec.slot, {
            block_type: slotSpec.block_type,
            bypassed: slotSpec.bypassed,
            instance: slotSpec.instance,
          });
          writes.push(result);
          if (!result.acked) anyFailed = true;
        } catch (err) {
          writes.push({
            op: 'set_block',
            target: `r${slotSpec.slot.row}c${slotSpec.slot.col}`,
            acked: false,
            warning: `set_block failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          anyFailed = true;
        }
      }

      // 1.5. Emit cable edges (routing[]).
      // Each RoutingEdge {from, to, connect?} is resolved to grid coords via
      // the slot id map, then emitted as fn=0x01 sub=0x35. Row-1 even-col
      // sources are refused by the builder (not yet decoded); all others are
      // validated for 6-row grids (FM9/III source rows 2-6 + row-1 odd-col) and
      // 4-row grids (FM3, byte-confirmed from FM3-Edit loopMIDI captures).
      const applyGrid = shape.grid;
      if (spec.routing && spec.routing.length > 0 && applyGrid) {
        // Build id -> {row, col} map from the placed slots.
        const slotById = new Map<string, { row: number; col: number }>();
        for (const s of spec.slots) {
          if (typeof s.slot !== 'object') continue;
          const id = s.id ?? `${s.block_type.toLowerCase()}${s.instance !== undefined && s.instance !== 1 ? `_${s.instance}` : ''}`;
          slotById.set(id, s.slot as { row: number; col: number });
        }
        if (applyGrid.rows !== 6 && applyGrid.rows !== 4) {
          writes.push({
            op: 'routing',
            target: 'routing',
            acked: false,
            warning: `${shape.id} routing: unsupported grid row count (rows=${applyGrid.rows}). Only 4-row (FM3) and 6-row (III/FM9) grids are validated.`,
          });
          anyFailed = true;
        } else {
          for (let ei = 0; ei < spec.routing.length; ei++) {
            if (overBudget()) break;
            const edge = spec.routing[ei];
            const src = edge.from === 'OUTPUT' ? undefined : slotById.get(edge.from);
            const dst = edge.to === 'OUTPUT' ? undefined : slotById.get(edge.to);
            if (!src || !dst) {
              // OUTPUT sentinel and unresolved ids are skipped — preflight already
              // validated them; an unresolved id here is a preflight bypass.
              continue;
            }
            if (dst.col !== src.col + 1) {
              writes.push({
                op: 'routing',
                target: `${edge.from}->${edge.to}`,
                acked: false,
                warning: `${shape.id} routing edge [${ei}] ${edge.from}->${edge.to}: dest col must be src col + 1 (got src col ${src.col}, dst col ${dst.col}). Non-adjacent-column routing is not yet supported.`,
              });
              anyFailed = true;
              continue;
            }
            const op = edge.connect === false ? ROUTING_OP_DISCONNECT : ROUTING_OP_CONNECT;
            let routeBytes: number[];
            try {
              routeBytes = codec.buildSetGridRouting({ srcRow: src.row, srcCol: src.col, destRow: dst.row, rows: applyGrid.rows, op });
            } catch (err) {
              writes.push({
                op: 'routing',
                target: `${edge.from}->${edge.to}`,
                acked: false,
                warning: `${shape.id} routing edge [${ei}] ${edge.from}->${edge.to}: ${err instanceof Error ? err.message : String(err)}`,
              });
              anyFailed = true;
              continue;
            }
            // Routing is the path with the known residual (the b23 6-row
            // formula and the refused row-1 even-col corner), so a device-side
            // rejection here is more likely than for a plain param write. Watch
            // for a 0x64 rejection like every other structural op instead of
            // reporting the cable as unconditionally applied, and carry the
            // beta caveat on the success path.
            const routeReject = await sendAndWatchForError(ctx, routeBytes);
            if (routeReject) {
              writes.push({
                op: 'routing',
                target: `${edge.from}->${edge.to}`,
                acked: false,
                warning:
                  `${shape.id} routing edge [${ei}] ${edge.from}->${edge.to}: ${deviceLabel} ` +
                  `rejected the cable via 0x64 MULTIPURPOSE_RESPONSE: ${formatErrorCode(routeReject)}. ` +
                  BETA_WARNING,
              });
              anyFailed = true;
              continue;
            }
            markDirty(connectionLabel);
            writes.push({ op: 'routing', target: `${edge.from}->${edge.to}`, acked: true, warning: BETA_WARNING });
          }
        }
      }

      // 2. Loop per-block params. Flat (`{rate: 0.8}`) writes the current
      //    channel; channel-nested (`{A: {gain: 6}, B: {gain: 9}}`) sends
      //    SET_CHANNEL then loops SET_PARAMETER per channel. Mixed shape is
      //    rejected as a spec error.
      for (const slotSpec of spec.slots) {
        if (overBudget()) break;
        if (slotSpec.params === undefined) continue;
        const blockSlugLocal = slotSpec.block_type.trim().toLowerCase();

        const entries = Object.entries(slotSpec.params);
        let nestedCount = 0;
        let flatCount = 0;
        for (const [, v] of entries) {
          if (typeof v === 'object' && v !== null && !Array.isArray(v)) nestedCount++;
          else flatCount++;
        }
        if (nestedCount > 0 && flatCount > 0) {
          writes.push({
            op: 'set_param',
            target: blockSlugLocal,
            acked: false,
            warning:
              `${shape.id} apply_preset: slot ${blockSlugLocal} mixes flat values and channel-nested objects. ` +
              'Use one shape per slot: flat `{gain: 6}` to write the current channel, ' +
              'or channel-nested `{A: {gain: 6}, B: {gain: 9}}` to address channels explicitly.',
          });
          anyFailed = true;
          continue;
        }

        if (nestedCount > 0) {
          let effectId: number;
          try {
            ({ effectId } = resolveBlockOrThrow(blockSlugLocal, deviceLabel, slotSpec.instance));
          } catch (err) {
            writes.push({
              op: 'set_channel',
              target: blockSlugLocal,
              acked: false,
              warning: `resolveBlock failed: ${err instanceof Error ? err.message : String(err)}`,
            });
            anyFailed = true;
            continue;
          }

          for (const [channelKey, paramMap] of entries) {
            const upper = channelKey.trim().toUpperCase();
            const wireChannel = channelValues[upper];
            if (wireChannel === undefined) {
              writes.push({
                op: 'set_channel',
                target: `${blockSlugLocal} (channel "${channelKey}")`,
                acked: false,
                warning:
                  `${shape.id} apply_preset: unknown channel key "${channelKey}" on ${blockSlugLocal}. ` +
                  `Valid channels: ${shape.channel_names.join(', ')}.`,
              });
              anyFailed = true;
              continue;
            }

            try {
              const channelBytes = codec.buildSetChannel(effectId, wireChannel as 0 | 1 | 2 | 3);
              const channelError = await sendAndWatchForError(ctx, channelBytes);
              if (channelError !== undefined) {
                writes.push({
                  op: 'set_channel',
                  target: `${blockSlugLocal} (channel ${upper})`,
                  acked: false,
                  warning:
                    `${deviceLabel} rejected set_channel via 0x64 MULTIPURPOSE_RESPONSE: ` +
                    `${formatErrorCode(channelError)}. ${BETA_WARNING}`,
                });
                anyFailed = true;
                continue;
              }
              writes.push({
                op: 'set_channel',
                target: `${blockSlugLocal} (channel ${upper})`,
                acked: true,
                display_value: upper,
                warning: BETA_WARNING,
              });
            } catch (err) {
              writes.push({
                op: 'set_channel',
                target: `${blockSlugLocal} (channel ${upper})`,
                acked: false,
                warning: `set_channel failed: ${err instanceof Error ? err.message : String(err)}`,
              });
              anyFailed = true;
              continue;
            }

            for (const [paramName, value] of Object.entries(paramMap as Record<string, number | string>)) {
              try {
                // Coerce DISPLAY → wire via the catalog schema, exactly as the
                // set_param tool does at the dispatcher boundary. Without this,
                // a spec value like `treble: 5.5` reaches packValue16 raw and is
                // rejected; calibrated knobs map through their display range.
                const wireValue = catalog.encodeParamOrThrow(blockSlugLocal, paramName, value, deviceLabel);
                const result = await writer.setParam!(ctx, blockSlugLocal, paramName, wireValue, undefined, slotSpec.instance);
                writes.push({ ...result, target: `${blockSlugLocal}.${upper}.${paramName}` });
                if (!result.acked) anyFailed = true;
              } catch (err) {
                writes.push({
                  op: 'set_param',
                  target: `${blockSlugLocal}.${upper}.${paramName}`,
                  acked: false,
                  warning: `set_param failed: ${err instanceof Error ? err.message : String(err)}`,
                });
                anyFailed = true;
              }
            }
          }
          continue;
        }

        // Flat-shape path — writes to the block's current channel.
        for (const [paramName, value] of entries) {
          try {
            // Coerce DISPLAY → wire via the catalog schema (see channel-nested
            // path above). Calibrated knobs map through their display range; an
            // uncalibrated param still requires a raw wire int and errors clearly.
            const wireValue = catalog.encodeParamOrThrow(blockSlugLocal, paramName, value, deviceLabel);
            const result = await writer.setParam!(ctx, blockSlugLocal, paramName, wireValue, undefined, slotSpec.instance);
            writes.push(result);
            if (!result.acked) anyFailed = true;
          } catch (err) {
            writes.push({
              op: 'set_param',
              target: `${blockSlugLocal}.${paramName}`,
              acked: false,
              warning: `set_param failed: ${err instanceof Error ? err.message : String(err)}`,
            });
            anyFailed = true;
          }
        }
      }

      // 3. Optional rename + save (only if caller asked to persist).
      //    Skipped when the burst aborted on budget — a half-applied buffer
      //    must not be persisted, and the rename ack would itself wait a window.
      if (!budgetExceeded && spec.name !== undefined) {
        try {
          const result = await writer.rename!(ctx, 'preset', spec.name);
          writes.push(result);
          if (!result.acked) anyFailed = true;
        } catch (err) {
          writes.push({
            op: 'rename',
            target: 'preset',
            acked: false,
            warning: `rename failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          anyFailed = true;
        }
      }
      if (!budgetExceeded && target !== undefined) {
        try {
          const result = await writer.savePreset!(ctx, target);
          writes.push(result);
          if (!result.acked) anyFailed = true;
        } catch (err) {
          writes.push({
            op: 'save_preset',
            target: String(target),
            acked: false,
            warning: `save_preset failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          anyFailed = true;
        }
      }

      void options; // landingScene / no_save_on_done not yet wired

      const failedStepIdx = writes.findIndex((w) => !w.acked);
      // Only name the envelopes actually emitted on this path. The store
      // (sub=0x26) leg runs solely when a target was given and the burst did
      // not abort on budget; advertising it on a non-saving audition apply
      // would tell a tester a save envelope went out when none did.
      const envelopes = ['block-insert (fn=0x01 sub=0x32)', 'SET_PARAMETER', 'SET_PRESET_NAME'];
      if (!budgetExceeded && target !== undefined) envelopes.push('store (fn=0x01 sub=0x26)');
      return {
        ok: !anyFailed,
        steps: writes.length,
        duration_ms: Date.now() - applyStartMs,
        failed_step: failedStepIdx >= 0 ? {
          index: failedStepIdx,
          description: writes[failedStepIdx].target ?? writes[failedStepIdx].op ?? 'step',
          error: writes[failedStepIdx].warning ?? 'no warning recorded',
        } : undefined,
        warning:
          `🟡 ${shape.id} apply_preset: composed of ${envelopes.join(' / ')} envelopes. ` +
          'Confirm the audible / visible result on the device. ' +
          `${writes.length} step(s) attempted; ${writes.filter((w) => w.acked).length} acked.`,
        saved: target !== undefined ? !anyFailed : undefined,
      };
    },

    async switchPreset(ctx: DispatchCtx, location: LocationRef): Promise<WriteResult> {
      gateWrite('switch_preset');
      const n = parseLocation(location);
      const bytes = codec.buildSwitchPresetPC(n);
      // node-midi on Windows (WinMM) silently drops a single non-sysex
      // message longer than 3 bytes, so the concatenated Bank-MSB +
      // Bank-LSB + Program-Change blob never leaves the host and the switch
      // no-ops. Split on MIDI status bytes (high bit set) and send each
      // message separately — the same pattern send_program_change already
      // uses. Hardware-found on a real FM9 (community fm9-catalog branch,
      // 2026-06-06); latent for every gen-3 device on Windows.
      for (let i = 0; i < bytes.length; ) {
        let j = i + 1;
        while (j < bytes.length && (bytes[j] & 0x80) === 0) j++;
        ctx.conn.send(bytes.slice(i, j));
        i = j;
      }
      return {
        op: 'switch_preset',
        target: String(n),
        acked: true,
        display_value: String(n),
        warning:
          `${shape.id} switch_preset: sent standard MIDI Program Change + Bank Select on ` +
          `channel 1 (the factory-default MIDI channel). ${deviceLabel} does not ack PC ` +
          `writes; confirm by reading the new active preset name or by checking the front ` +
          `panel. If the device listens on a different MIDI channel, the switch silently ` +
          `no-ops; set it back to channel 1 in the Global → MIDI menu.`,
      };
    },

    async savePreset(ctx: DispatchCtx, location: LocationRef, name?: string): Promise<WriteResult> {
      gateWrite('save_preset');
      const n = parseLocation(location);
      if (name !== undefined) {
        try {
          await writer.rename!(ctx, 'preset', name);
        } catch {
          // Continue to save attempt anyway.
        }
      }
      const bytes = codec.buildStorePreset(n);
      const errorReport = await sendAndWatchForError(ctx, bytes, 200);
      if (errorReport !== undefined) {
        return {
          op: 'save_preset',
          target: String(n),
          acked: false,
          warning:
            `${deviceLabel} rejected save_preset (fn=0x01 sub=0x26 store envelope) via 0x64 ` +
            `MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. This is the gen-3 editor's ` +
            `own store op, captured byte-exact; a rejection here likely means a different firmware ` +
            `state (e.g. an unsaved-edit guard). For now, save on the device front panel. ` + BETA_WARNING,
        };
      }
      return {
        op: 'save_preset',
        target: String(n),
        acked: true,
        display_value: String(n),
        warning:
          `🟡 ${shape.id} save_preset: sent the gen-3 editor store envelope (fn=0x01 sub=0x26, ` +
          `destination preset at the 14-bit arg slot). Wire shape is captured byte-exact from the ` +
          `editor, but device persistence is not yet hardware-verified. Device emitted no rejection. ` +
          `CONFIRM by switching to a different preset and back: if the saved state survived, the ` +
          `save landed. ` + BETA_WARNING,
      };
    },

    async switchScene(ctx: DispatchCtx, scene: number): Promise<WriteResult> {
      gateWrite('switch_scene');
      if (!Number.isInteger(scene) || scene < 1 || scene > shape.scene_count) {
        throw new DispatchError(
          'value_out_of_range',
          deviceLabel,
          `${shape.id} switchScene: scene ${scene} out of range. ` +
            `${deviceLabel} has ${shape.scene_count} scenes per preset ` +
            `(1..${shape.scene_count} display, 0..${shape.scene_count - 1} wire).`,
        );
      }
      const bytes = codec.buildSetScene(scene - 1);
      const errorReport = await sendAndWatchForError(ctx, bytes);
      if (errorReport !== undefined) {
        return {
          op: 'switch_scene',
          target: String(scene),
          acked: false,
          warning:
            `${deviceLabel} rejected switch_scene via 0x64 MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. ` +
            BETA_WARNING,
        };
      }
      return {
        op: 'switch_scene',
        target: String(scene),
        acked: true,
        warning: `🟡 ${shape.id} switch_scene: spec-documented (function 0x0C). ` + BETA_WARNING,
      };
    },

    async rename(ctx: DispatchCtx, target: RenameTarget, name: string): Promise<WriteResult> {
      gateWrite('rename');
      if (target !== 'preset') {
        throw new DispatchError(
          'capability_not_supported',
          deviceLabel,
          `${shape.id} rename: only target='preset' is wired (tried target='${target}'). ` +
            'Scene rename would need SET_SCENE_NAME which has no envelope to port from.',
        );
      }
      let bytes: number[];
      try {
        bytes = codec.buildSetPresetName(name);
      } catch (err) {
        throw new DispatchError(
          'value_out_of_range',
          deviceLabel,
          err instanceof Error ? err.message : String(err),
        );
      }
      const errorReport = await sendAndWatchForError(ctx, bytes, 100);
      if (errorReport !== undefined) {
        return {
          op: 'rename',
          target: 'preset',
          acked: false,
          warning:
            `${deviceLabel} rejected rename (0x09 SET_PRESET_NAME envelope) via 0x64 ` +
            `MULTIPURPOSE_RESPONSE: ${formatErrorCode(errorReport)}. ` + BETA_WARNING,
        };
      }
      return {
        op: 'rename',
        target: 'preset',
        acked: true,
        display_value: name,
        warning:
          `🟡 ${shape.id} rename: sent the 0x09 SET_PRESET_NAME envelope. Device emitted no ` +
          `rejection but may have ignored the write; confirm via the front-panel preset title. ` +
          `Working-buffer scope only; persist with save_preset. ` + BETA_WARNING,
      };
    },

    guardActiveBufferOrSave: makeGuard({
      codec,
      connectionLabel,
      deviceLabel,
      getResponseTimeoutMs,
      // Save persistence is not yet hardware-verified for III/FM3/FM9
      // (supports_save is false on the descriptor), so the auto-save path
      // must not emit the store op (fn=0x01 sub=0x26) during navigation.
      supportsSave: shape.supportsSave,
    }),
  };

  return writer;
}
