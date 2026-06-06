/**
 * Codec-backed gen-3 device simulator — read projectors.
 *
 * Each projector builds a device response frame from the consistent state
 * model (not a replay batch). They are used when a block has been MUTATED this
 * session (so the seeded verbatim frame is stale) and to fill gaps the capture
 * never recorded (a block placed live, a poll for a never-captured effectId).
 * For an un-mutated read of a render-gate frame the simulator prefers the
 * seeded verbatim bytes — see SimDevice.
 */
import {
  buildBroadcastBurst,
  buildNotInUseNack,
  buildPlacedFlagResponse,
  buildStreamResponse,
  gen3Decode14,
} from '@mcp-midi-control/fractal-modern/simResponders.js';
import type { SimDeviceState } from './types.js';

/** sub=0x7b placed-flag: nonzero value bytes iff the effect is in the active preset. */
export function projectPlacedFlag(
  state: SimDeviceState,
  query: number[],
): number[] {
  const modelByte = state.config.model_byte;
  const effectId = gen3Decode14(query[8], query[9]);
  const block = state.active.blocks.get(effectId);
  return buildPlacedFlagResponse(modelByte, query, block?.placedFlagBytes);
}

/** sub=0x37 stream: a free-running counter so repeat polls differ. */
export function projectStream(
  state: SimDeviceState,
  query: number[],
  counter: number,
): number[] {
  return buildStreamResponse(state.config.model_byte, query, counter);
}

/** fn=0x1F bulk read: the 0x74/0x75…/0x76 burst from the block's value vector, or a NACK. */
export function projectBulkRead(
  state: SimDeviceState,
  query: number[],
): number[][] {
  const modelByte = state.config.model_byte;
  const effectId = gen3Decode14(query[6], query[7]);
  const block = state.active.blocks.get(effectId);
  if (block === undefined) return [buildNotInUseNack(modelByte)];
  return buildBroadcastBurst(modelByte, {
    blockId: effectId,
    itemCount: block.bulkValues.length,
    values: block.bulkValues,
  });
}
