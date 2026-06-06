/**
 * Axe-Fx Standard/Ultra (gen-1) DeviceWriter.
 *
 * Scope: SET only. gen-1's published doc documents the parameter-set message
 * and nothing else (no GET, no save, no preset-change, no scenes/channels). So
 * the writer implements `buildSetParam` + `setParam` + `setParams`; every other
 * op is omitted and the dispatcher returns `capability_not_supported`.
 *
 * Community-beta: the wire is decoded byte-exactly from the vendor doc but not
 * confirmed on gen-1 hardware. Every response carries a beta note pointing the
 * user at the front panel.
 */

import type {
  BatchWriteResult,
  DeviceWriter,
  DispatchCtx,
  WriteOp,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  KNOWN_PARAMS,
  blockIdFor,
  buildSetParam as buildSetParamBytes,
  type AxeFxGen1Param,
} from 'fractal-midi/axe-fx-gen1';

const DEVICE_LABEL = 'Fractal Axe-Fx Standard/Ultra';
const BETA_NOTE =
  'gen-1 (Axe-Fx Standard/Ultra) is community-beta: the wire is decoded from the published ' +
  'Ultra SysEx doc but not hardware-verified. Confirm the change on the front panel.';

function resolveParam(block: string, name: string): AxeFxGen1Param {
  const p = KNOWN_PARAMS[`${block}.${name}` as keyof typeof KNOWN_PARAMS] as AxeFxGen1Param | undefined;
  if (!p) {
    const known = Object.values(KNOWN_PARAMS)
      .filter((x) => (x as AxeFxGen1Param).block === block)
      .map((x) => (x as AxeFxGen1Param).name);
    throw new DispatchError(
      'unknown_param',
      DEVICE_LABEL,
      `Unknown parameter '${block}.${name}' on ${DEVICE_LABEL}.` +
        (known.length ? ` Known params for ${block}: ${known.slice(0, 20).join(', ')}${known.length > 20 ? ', …' : ''}.` : ` Unknown block '${block}'.`),
      { retry_action: `Call list_params({port, block:["${block}"]}) for the canonical names.` },
    );
  }
  return p;
}

export const writer: DeviceWriter = {
  buildSetParam(block, name, wireValue): number[] {
    const p = resolveParam(block, name);
    const blockId = blockIdFor(block, 1);
    if (blockId === undefined) {
      throw new DispatchError('unknown_block', DEVICE_LABEL, `No wire blockId for '${block}' on ${DEVICE_LABEL}.`);
    }
    return buildSetParamBytes(blockId, p.paramId, wireValue);
  },

  async setParam(ctx: DispatchCtx, block, name, wireValue): Promise<WriteResult> {
    const bytes = writer.buildSetParam(block, name, wireValue);
    ctx.conn.send(bytes);
    const p = resolveParam(block, name);
    const display = makeDisplay(p, wireValue);
    return {
      op: 'set_param',
      target: `${block}.${name}`,
      block,
      name,
      wire_value: wireValue,
      ...(display !== undefined ? { display_value: display } : {}),
      acked: true,
      info: `Fire-and-forget set on ${DEVICE_LABEL} (gen-1 has no read-back). ${BETA_NOTE}`,
    };
  },

  async setParams(ctx: DispatchCtx, ops: readonly WriteOp[]): Promise<BatchWriteResult> {
    const writes: WriteResult[] = [];
    let acked_count = 0;
    let unacked_count = 0;
    for (const op of ops) {
      try {
        const r = await writer.setParam!(ctx, op.block, op.name, op.value as number, op.channel);
        writes.push(r);
        acked_count++;
      } catch (err) {
        writes.push({
          op: 'set_param',
          target: `${op.block}.${op.name}`,
          block: op.block,
          name: op.name,
          acked: false,
          warning: err instanceof Error ? err.message : String(err),
        });
        unacked_count++;
      }
    }
    return { writes, acked_count, unacked_count };
  },

  // get/save/switch/scene/channel/block ops intentionally omitted — gen-1's doc
  // documents only the parameter-set message. The dispatcher returns
  // capability_not_supported for those unified tools.
};

/** Best-effort decode of the wire value back to a display label for the receipt. */
function makeDisplay(p: AxeFxGen1Param, wire: number): number | string | undefined {
  if (p.controlType === 'enum' || p.controlType === 'switch') return p.enumValues?.[wire] ?? wire;
  if (p.scaling !== 'linear' || !p.display) return undefined;
  const { min, max } = p.display;
  const wmax = p.range.max ?? 254;
  return Math.round((min + (wire / wmax) * (max - min)) * 100) / 100;
}
