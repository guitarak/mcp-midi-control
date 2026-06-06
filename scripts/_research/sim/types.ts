/**
 * Codec-backed gen-3 device simulator — state types.
 *
 * Every field is config-driven, so the same state machine serves all three
 * gen-3 editors (III 0x10 / FM3 0x11 / FM9 0x12); only the FractalModernConfig
 * differs. Keys mirror the wire address space exactly:
 *   - grid key  = col * rows + row   (the editor's gridPos, column-major)
 *   - block key = effectId           (decode14 of query bytes 8..9)
 *   - param key = paramId            (decode14 of query bytes 10..11)
 */
import type { FractalModernConfig } from '@mcp-midi-control/fractal-modern/factory.js';

export type { FractalModernConfig };

/** One channel's param values (paramId -> 16-bit wire value). */
export interface ChannelState {
  paramValues: Map<number, number>;
}

/** A placed block's full state. */
export interface BlockState {
  effectId: number;
  /** Per-channel param values (A..D). */
  channels: ChannelState[];
  /**
   * The whole-block bulk-read value vector (channel-blocked positional layout:
   * index = channel × stride + paramId). Seeded verbatim from the captured
   * fn=0x1F burst; the projected burst re-emits these. itemCount = values.length.
   */
  bulkValues: number[];
  /** Item count the 0x74 head advertises (4 × param count). */
  itemCount: number;
  /** The two value bytes the sub=0x7b placed-flag reports (captured marker). */
  placedFlagBytes: [number, number];
  /** True once a write op (insert / param-set) has touched this block this session. */
  mutated: boolean;
}

/** One grid cell: a real effect, or a routing shunt (byte 9 high septet = 0x08). */
export type GridCell = { effectId: number } | { shunt: true; instance: number };

export interface PresetState {
  name: string;
  presetNumber: number;
  /** grid key (col*rows+row) -> cell. */
  grid: Map<number, GridCell>;
  /** effectId -> block. */
  blocks: Map<number, BlockState>;
  activeScene: number;
}

export interface SimDeviceState {
  config: FractalModernConfig;
  active: PresetState;
  stored: Map<number, PresetState>;
}
