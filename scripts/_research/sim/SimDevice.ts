/**
 * Codec-backed gen-3 device simulator — the state machine.
 *
 * `SimDevice(config)` presents as a gen-3 Fractal device (III 0x10 / FM3 0x11 /
 * FM9 0x12) to the matching editor over loopMIDI. `handle(bytes)` is the single
 * entry: it takes one inbound editor frame and returns zero or more device
 * frames to send back. The emulator I/O shell pumps those through its
 * rate-limited send loop.
 *
 * Response policy (the fix for the failed naive replay):
 *   - For an UN-mutated read of a render-gate frame the codec has not fully
 *     decoded (sub=0x2e layout map, sub=0x01 block descriptor, and the other
 *     static blobs), serve the SEEDED captured bytes for that exact query
 *     ADDRESS (bytes 5..11), recomputing only the checksum. Deterministic
 *     one-query-to-one-frame, never a lumped batch.
 *   - For frames the codec HAS decoded (sub=0x7b placed-flag, sub=0x37 stream,
 *     fn=0x1F bulk-read), and for any block MUTATED this session (a live insert
 *     / param-set), PROJECT from the consistent state model so the response
 *     reflects the mutation.
 *   - Write sub-actions (insert / select / store / routing / typed-SET) mutate
 *     state and (usually) return nothing; the editor re-queries.
 *
 * This is the same device-agnostic binding the descriptor factory uses
 * (`createModernFractalCodec(config.model_byte)` + `createModernCatalog(...)`),
 * so the M0 offline assertion and the live M1..M4 runs use one code path across
 * all three model bytes.
 */
import {
  isGen3Envelope,
  recomputeGen3Checksum,
  gen3Decode14,
  FN_BLOCK_BULK_READ,
  FN_PARAMETER_SETGET,
  SUB_PLACED_FLAG,
  SUB_STREAM,
} from '@mcp-midi-control/fractal-modern/simResponders.js';
import type { FractalModernConfig, SimDeviceState, PresetState, BlockState } from './types.js';
import { seedFromCapture, echoKeyOf, type CaptureFrame, type CaptureSeed } from './seed.js';
import { projectPlacedFlag, projectStream, projectBulkRead } from './projectors.js';
import { applyWrite, WRITE_SUBS, type MutationResult } from './mutators.js';

const NUM_CHANNELS = 4;

export interface SimHandleTrace {
  kind: 'verbatim' | 'project' | 'write' | 'empty';
  label: string;
}

export class SimDevice {
  readonly state: SimDeviceState;
  private seed: CaptureSeed | undefined;
  private streamCounter = 0;
  private readonly mutatedEffectIds = new Set<number>();
  /**
   * Cursor-streamed sub-actions: the query advances a cursor (bytes 10..11) and
   * the device returns the next chunk. A fixed same-sub fallback can't satisfy
   * these (the cursor never advances → infinite re-ask), so they are excluded
   * from the fallback and answered empty → graceful editor timeout. sub=0x1f is
   * the "Query All Param Definitions" stream.
   */
  private static readonly STREAMED_SUBS: ReadonlySet<number> = new Set([0x1f]);
  /** Set by the most recent handle() call, for emulator logging. */
  lastTrace: SimHandleTrace = { kind: 'empty', label: 'init' };

  constructor(config: FractalModernConfig) {
    const active: PresetState = {
      name: 'Sim Preset',
      presetNumber: 0,
      grid: new Map(),
      blocks: new Map(),
      activeScene: 0,
    };
    this.state = { config, active, stored: new Map() };
  }

  /**
   * Seed from a direction-tagged capture (Source A): the fastest path to M1.
   * Frames are remapped onto THIS device's model byte, so an FM9 corpus can
   * seed an FM3 / III editor (cross-family seeding; the codec is model-byte
   * parametric). Grid/catalog deltas still differ per device — cross-family
   * render is an experiment, not a guarantee, until each editor has its own
   * connect+sync capture.
   */
  seedFromCaptureFrames(frames: CaptureFrame[]): void {
    const seed = seedFromCapture(frames, this.state.config.model_byte);
    this.seed = seed;
    // Reconstruct the active preset's placed blocks from the capture.
    for (const [effectId, placedFlagBytes] of seed.placedFlagByEffectId) {
      const bulkValues = seed.bulkValuesByEffectId.get(effectId) ?? [];
      const block: BlockState = {
        effectId,
        channels: Array.from({ length: NUM_CHANNELS }, () => ({ paramValues: new Map() })),
        bulkValues,
        itemCount: bulkValues.length,
        placedFlagBytes,
        mutated: false,
      };
      this.state.active.blocks.set(effectId, block);
    }
  }

  private modelByte(): number {
    return this.state.config.model_byte;
  }

  /** Look up the seeded verbatim response for a query's address, checksum-refreshed. */
  private verbatim(query: number[]): number[] | undefined {
    const frame = this.seed?.verbatimByEchoKey.get(echoKeyOf(query));
    return frame ? recomputeGen3Checksum(frame) : undefined;
  }

  /**
   * Same-sub fallback: when the editor reads an ADDRESS the capture never
   * recorded, answer with a representative frame of the SAME sub-action,
   * rewriting its address echo (bytes 5..11) to the query and refreshing the
   * checksum. The editor needs a well-formed answer to advance; an empty reply
   * makes it retry the same read forever (the M1 hang on the sub=0x1c sweep).
   * The payload is wrong but the SHAPE + address are right, which unblocks it.
   */
  private sameSubFallback(query: number[], sub: number): number[] | undefined {
    // NEVER fall back for a cursor-streamed read (sub=0x1f "Query All Param
    // Definitions"): its query advances a cursor in bytes 10..11, so a fixed
    // template answer never lets the editor's cursor progress and it re-asks
    // forever (the flood). Returning undefined → empty → the editor's own
    // timeout fires gracefully (recoverable), as observed live.
    if (SimDevice.STREAMED_SUBS.has(sub)) return undefined;
    const tmpl = this.seed?.templateBySub.get(sub);
    if (tmpl === undefined) return undefined;
    const framed = tmpl.slice();
    for (let i = 5; i <= 11; i++) framed[i] = query[i] ?? 0;
    return recomputeGen3Checksum(framed);
  }

  handle(bytes: number[]): number[][] {
    const model = this.modelByte();
    if (!isGen3Envelope(bytes, model)) {
      this.lastTrace = { kind: 'empty', label: 'non-gen3 / wrong model' };
      return [];
    }
    const fn = bytes[5];

    // fn=0x1F block bulk-read poll.
    if (fn === FN_BLOCK_BULK_READ) {
      const effectId = gen3Decode14(bytes[6], bytes[7]);
      if (!this.mutatedEffectIds.has(effectId)) {
        const burst = this.seed?.burstByEffectId.get(effectId);
        if (burst) {
          this.lastTrace = { kind: 'verbatim', label: `fn=0x1F burst eff ${effectId} (verbatim)` };
          return burst.map(recomputeGen3Checksum);
        }
      }
      this.lastTrace = { kind: 'project', label: `fn=0x1F burst eff ${effectId} (projected)` };
      return projectBulkRead(this.state, bytes);
    }

    if (fn !== FN_PARAMETER_SETGET) {
      this.lastTrace = { kind: 'empty', label: `unhandled fn=0x${fn.toString(16)}` };
      return [];
    }

    const sub = bytes[6];

    // Write sub-actions mutate state. The editor gates a multi-step write (e.g.
    // grid insert = sub=0x30 select -> sub=0x32 insert) on seeing an ACK for
    // each step; with no ack it stalls before the next step and times out
    // ("Insert Block : grid_set_position"). The original single-port capture
    // worked because the editor saw its own writes echoed back (self-loopback),
    // which served as the ack. Replicate that here: echo the write frame back
    // when the mutator has no specific reply, so the editor advances to the
    // next step (letting sub=0x32 actually emit, instead of stalling at 0x30).
    if (WRITE_SUBS.has(sub)) {
      const res: MutationResult = applyWrite(this.state, bytes);
      for (const eff of res.touched) this.mutatedEffectIds.add(eff);
      this.lastTrace = { kind: 'write', label: res.label };
      return res.replies.length > 0 ? res.replies : [recomputeGen3Checksum(bytes)];
    }

    // sub=0x37 stream: always projected from a free-running counter.
    if (sub === SUB_STREAM) {
      this.streamCounter = (this.streamCounter + 1) & 0x3fff;
      this.lastTrace = { kind: 'project', label: 'sub=0x37 stream (counter)' };
      return [projectStream(this.state, bytes, this.streamCounter)];
    }

    // sub=0x7b placed-flag: project for mutated blocks, else verbatim, else project.
    if (sub === SUB_PLACED_FLAG) {
      const effectId = gen3Decode14(bytes[8], bytes[9]);
      if (!this.mutatedEffectIds.has(effectId)) {
        const v = this.verbatim(bytes);
        if (v) {
          this.lastTrace = { kind: 'verbatim', label: `sub=0x7b placed-flag eff ${effectId} (verbatim)` };
          return [v];
        }
      }
      this.lastTrace = { kind: 'project', label: `sub=0x7b placed-flag eff ${effectId} (projected)` };
      return [projectPlacedFlag(this.state, bytes)];
    }

    // All other reads (layout map 0x2e, block descriptor 0x01, param info 0x1a,
    // param flags 0x1b, typed GET 0x09, directory 0x2a, global tables 0x4b,
    // enum sweeps 0x1c/0x56, ...): served verbatim by address. These are not
    // yet projectable from state (the 0x2e occupancy bytes are undecoded), so
    // M1 serves the captured device bytes; projecting them is gated on a
    // second-preset capture (produced once M2 places a block live).
    const v = this.verbatim(bytes);
    if (v) {
      this.lastTrace = { kind: 'verbatim', label: `fn=0x01 sub=0x${sub.toString(16)} (verbatim)` };
      return [v];
    }
    // No exact-address seed: serve a same-sub frame with the query's address so
    // the editor's read completes instead of hanging on an empty reply.
    const fb = this.sameSubFallback(bytes, sub);
    if (fb) {
      this.lastTrace = { kind: 'verbatim', label: `fn=0x01 sub=0x${sub.toString(16)} (same-sub fallback)` };
      return [fb];
    }
    this.lastTrace = { kind: 'empty', label: `fn=0x01 sub=0x${sub.toString(16)} (no seed, no template)` };
    return [];
  }
}

export type { CaptureFrame };
