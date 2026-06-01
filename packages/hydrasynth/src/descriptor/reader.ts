/**
 * Hydrasynth DeviceDescriptor: DeviceReader implementation.
 *
 * Scope: MINIMAL. The Hydrasynth has no decoded single-param READ
 * primitive in our current tooling, and per Ashun's SysExEncoding.txt
 * there is no "request from current working memory" command on this
 * device. Verification is via the front-panel display.
 *
 * Reader contract requires `getParam` + `getParams`. We satisfy the
 * type system but throw `capability_not_supported` at runtime; the
 * dispatcher returns that cleanly to the agent.
 *
 * `scanLocations` and `lookupLineage` are optional and omitted. The
 * Hydrasynth has no Fractal-style preset-scan envelope (each patch is
 * a full ~13KB SysEx dump, not a single-byte name read), and no
 * Fractal-authored lineage corpus.
 */

import type {
  BatchReadResult,
  DeviceReader,
  DispatchCtx,
  ReadResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

const DEVICE_LABEL = 'ASM Hydrasynth Explorer';

export const reader: DeviceReader = {
  async getParam(_ctx: DispatchCtx, _block: string, _name: string): Promise<ReadResult> {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `get_param is not supported on ASM Hydrasynth Explorer. The device has no decoded single-param query/response primitive. ` +
      `To verify a written value, check the front-panel display directly.`,
      { retry_action: 'Read the value off the device\'s front-panel display.' },
    );
  },

  async getParams(_ctx: DispatchCtx, _queries): Promise<BatchReadResult> {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `get_params batch read is not supported on ASM Hydrasynth Explorer (same reason as get_param). ` +
      `Verify on the front-panel display.`,
    );
  },
};
