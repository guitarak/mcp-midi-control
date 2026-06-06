/**
 * Codec-backed gen-3 device simulator — seeding.
 *
 * Two device-agnostic seed sources:
 *
 *  - SOURCE A (capture replay-seed): parse a direction-tagged frames.json
 *    (`{dir, t, fn, sub, len, hex}` records from a real connect+sync) into a
 *    verbatim store keyed by the query's echo address (bytes 5..11), plus a
 *    reconstructed state model (placed set + per-block bulk values). This is
 *    the fastest path to a rendered grid (M1) with ZERO projection risk: the
 *    undecoded render-gate frames (sub=0x2e layout map, sub=0x01 descriptors)
 *    are served byte-for-byte as the device emitted them, recomputing only the
 *    checksum.
 *
 *  - SOURCE B (PresetSpec seed): build state from the same PresetSpec the
 *    unified `apply_preset` consumes. Used for M2..M4 and cross-device, where
 *    there is no capture to replay.
 *
 * The key difference from the failed naive record-and-replay: the old map
 * keyed on the FULL query hex and lumped EVERY device frame between two editor
 * queries onto the first query, so a poll preceding a big dump replayed
 * hundreds of mispaired frames. This keys on the query's ADDRESS (bytes 5..11)
 * and pairs each query with exactly its own response frame(s) by frame type, so
 * the store is deterministic one-query-to-one-response.
 */
import {
  gen3Decode14,
  FN_BLOCK_BULK_READ,
  FN_BROADCAST_HEAD,
  FN_BROADCAST_BODY,
  FN_BROADCAST_END,
  SUB_PLACED_FLAG,
  SUB_LAYOUT_MAP,
} from '@mcp-midi-control/fractal-modern/simResponders.js';

export interface CaptureFrame {
  dir: 'OUT' | 'IN';
  t?: string;
  fn: number;
  sub: number;
  len: number;
  hex: string;
}

export interface CaptureSeed {
  /** query echo address (bytes 5..11 hex) -> the single response frame for it. */
  verbatimByEchoKey: Map<string, number[]>;
  /** effectId -> the full 0x74/0x75…/0x76 burst frames. */
  burstByEffectId: Map<number, number[][]>;
  /** effectId -> reconstructed channel-blocked bulk value vector. */
  bulkValuesByEffectId: Map<number, number[]>;
  /** effectId -> the sub=0x7b placed-flag value bytes (nonzero == placed). */
  placedFlagByEffectId: Map<number, [number, number]>;
  /** The captured sub=0x2e layout-map frame (whole-preset; served verbatim at M1). */
  layoutMap2e?: number[];
  /**
   * sub-action -> one representative captured response frame. Fallback shape
   * when the editor reads an ADDRESS the capture never recorded: the simulator
   * answers with this same-sub frame, rewriting the address echo (bytes 5..11)
   * to the query. The editor needs a well-formed answer to advance its sync;
   * an empty reply makes it retry the same read forever (the M1 hang on the
   * sub=0x1c enum sweep). Wrong data of the right SHAPE unblocks it.
   */
  templateBySub: Map<number, number[]>;
}

const toBytes = (hex: string): number[] => hex.trim().split(/\s+/).map((b) => parseInt(b, 16));
const echoKeyOf = (bytes: number[]): string => bytes.slice(5, 12).join(',');

const unpack16 = (a: number, b: number, c: number): number =>
  (a & 0x7f) | ((b & 0x7f) << 7) | ((c & 0x03) << 14);

/** Reconstruct the positional value vector from a 0x74/0x75…/0x76 burst. */
function reconstructBulkValues(burst: number[][]): number[] {
  const values: number[] = [];
  for (const frame of burst) {
    if (frame[5] !== FN_BROADCAST_BODY) continue;
    // body payload: [sectionId, flag, N × packValue16]; values start at byte 8,
    // [cks][F7] stripped.
    const end = frame.length - 2;
    for (let i = 8; i + 3 <= end; i += 3) {
      values.push(unpack16(frame[i], frame[i + 1], frame[i + 2]));
    }
  }
  return values;
}

/**
 * Remap a device frame's model byte (envelope byte 4) to `targetModelByte` and
 * fix its checksum. The gen-3 codec is model-byte-parametric (III/FM3/FM9 share
 * the wire shape, differing only in byte 4 + the per-device catalog), so an FM9
 * capture frame is a structurally valid FM3/III frame once byte 4 is swapped.
 * Used when seeding an editor of a different model than the capture (e.g.
 * driving FM3-Edit from the FM9 connect+sync corpus). A no-op when the frame is
 * already on the target model.
 */
function remapModelByte(frame: number[], targetModelByte: number): number[] {
  if (frame[4] === targetModelByte) return frame;
  const out = frame.slice();
  out[4] = targetModelByte;
  const n = out.length;
  out[n - 2] = out.slice(0, n - 2).reduce((a, b) => a ^ b, 0) & 0x7f;
  return out;
}

/**
 * Build a CaptureSeed from direction-tagged frames. Pairs each editor query
 * (dir=OUT) with its own response by frame type:
 *   - fn=0x01 sub=X  -> the next IN frame with fn=0x01 and the same sub.
 *   - fn=0x1F poll   -> the following IN 0x74 head + 0x75 bodies + 0x76 end.
 * First response per echo key wins (repeat polls are near-identical).
 *
 * `targetModelByte` (when given) remaps every stored device frame onto that
 * model byte (cross-family seeding); omit to keep the capture's own model.
 */
export function seedFromCapture(frames: CaptureFrame[], targetModelByte?: number): CaptureSeed {
  const seed: CaptureSeed = {
    verbatimByEchoKey: new Map(),
    burstByEffectId: new Map(),
    bulkValuesByEffectId: new Map(),
    placedFlagByEffectId: new Map(),
    templateBySub: new Map(),
  };

  for (let i = 0; i < frames.length; i++) {
    const q = frames[i];
    if (q.dir !== 'OUT') continue;
    const qb = toBytes(q.hex);

    if (q.fn === FN_BLOCK_BULK_READ) {
      // fn=0x1F poll → collect the following burst.
      const effectId = gen3Decode14(qb[6], qb[7]);
      if (seed.burstByEffectId.has(effectId)) continue;
      const burst: number[][] = [];
      for (let j = i + 1; j < frames.length; j++) {
        const r = frames[j];
        if (r.dir !== 'IN') {
          if (burst.length > 0) break; // device went quiet before next query
          continue;
        }
        const rb = targetModelByte === undefined ? toBytes(r.hex) : remapModelByte(toBytes(r.hex), targetModelByte);
        if (rb[5] === FN_BROADCAST_HEAD || rb[5] === FN_BROADCAST_BODY) {
          burst.push(rb);
        } else if (rb[5] === FN_BROADCAST_END) {
          burst.push(rb);
          break;
        } else {
          break;
        }
      }
      if (burst.length > 0) {
        seed.burstByEffectId.set(effectId, burst);
        seed.bulkValuesByEffectId.set(effectId, reconstructBulkValues(burst));
      }
      continue;
    }

    if (q.fn !== 0x01) continue;
    const sub = q.sub;
    const key = echoKeyOf(qb);
    if (seed.verbatimByEchoKey.has(key)) {
      // already have this address; still capture placed-flag/layout state below
    }
    // Find this query's own response: next IN fn=0x01 with the same sub.
    let resp: number[] | undefined;
    for (let j = i + 1; j < Math.min(frames.length, i + 6); j++) {
      const r = frames[j];
      if (r.dir !== 'IN') continue;
      if (r.fn === 0x01 && r.sub === sub) {
        resp = targetModelByte === undefined ? toBytes(r.hex) : remapModelByte(toBytes(r.hex), targetModelByte);
        break;
      }
      // an unrelated IN before our response — keep scanning a short window
    }
    if (resp === undefined) continue;
    if (!seed.verbatimByEchoKey.has(key)) seed.verbatimByEchoKey.set(key, resp);
    if (!seed.templateBySub.has(sub)) seed.templateBySub.set(sub, resp);

    if (sub === SUB_PLACED_FLAG) {
      const effectId = gen3Decode14(qb[8], qb[9]);
      const v0 = resp[12] ?? 0;
      const v1 = resp[13] ?? 0;
      if ((v0 !== 0 || v1 !== 0) && !seed.placedFlagByEffectId.has(effectId)) {
        seed.placedFlagByEffectId.set(effectId, [v0, v1]);
      }
    } else if (sub === SUB_LAYOUT_MAP && seed.layoutMap2e === undefined) {
      seed.layoutMap2e = resp;
    }
  }

  return seed;
}

export { echoKeyOf, toBytes };
