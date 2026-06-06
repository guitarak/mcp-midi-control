/**
 * Fractal FM9 DeviceDescriptor — FOUNDATION-VERIFICATION SCAFFOLD.
 *
 * Cloned from `packages/axe-fx-iii/src/descriptor.ts` and deliberately
 * stripped to the protocol-foundation surface. This step exists to
 * confirm on real FM9 hardware that:
 *
 *   1. the port binds (port_match + transport),
 *   2. the model byte hypothesis (`FM9_MODEL_ID = 0x12` in
 *      `fractal-midi/fm9`) is right,
 *   3. switch_preset (MIDI PC + Bank Select) and switch_scene
 *      (function 0x0C) physically move the unit,
 *   4. response framing matches the Axe-Fx III family.
 *
 * What is deliberately NOT here yet (lands after foundation
 * verification + the FM9-Edit catalog mining pass — see
 * `docs/research/fractal-midi-extraction-plan.md` §"Adding FM9"):
 *
 *   - block roster / param schema (`blocks` is EMPTY)
 *   - parameter SET/GET (fn=0x01 path)
 *   - set_block / set_bypass / apply_preset / save_preset / rename
 *   - lineage, concept keys, recipes, block_params_summary
 *
 * Registration order in `packages/server-all/src/server/index.ts`
 * MUST put FM9 BEFORE AM4 — AM4's port-name regex is the catch-all
 * `/Fractal/i`, and the dispatcher uses registration order as the
 * tiebreaker (same rationale as the Axe-Fx III's placement).
 */
import type {
  DeviceDescriptor,
  DeviceReader,
  DeviceWriter,
  DispatchCtx,
  ReadResult,
  BatchReadResult,
  ParamQuery,
  WriteResult,
  LocationRef,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  buildQueryPatchName,
  buildSetScene,
  buildSwitchPresetPC,
  describeMultipurposeResultCode,
  isMultipurposeResponse,
  isQueryPatchNameResponse,
  parseMultipurposeResponse,
  parseQueryPatchNameResponse,
} from 'fractal-midi/fm9';

const DEVICE_LABEL = 'Fractal FM9';

/** Wire response window — same budget the III descriptor uses. */
const GET_RESPONSE_TIMEOUT_MS = 800;

/**
 * Banner appended to every FM9 write-path response. The FM9 descriptor
 * is a foundation-verification scaffold: wire shapes are cloned from
 * the Axe-Fx III (same modern Fractal SysEx family) and the model byte
 * is a hypothesis. Nothing is hardware-verified until the maintainer's
 * unit confirms it; the agent surfaces this so the user verifies by
 * ear / front panel.
 */
const FOUNDATION_WARNING = [
  'fm9 foundation scaffold. Model byte (0x12), preset switch, scene',
  'switch, and QUERY PATCH NAME / STATUS DUMP framing are',
  'hardware-verified (2026-06-06 foundation probe); everything beyond',
  'that surface is not wired yet. Please confirm the audible/visible',
  'response on the device front panel.',
].join(' ');

/** Structured refusal for the surfaces the scaffold deliberately omits. */
function notScaffolded(op: string): DispatchError {
  return new DispatchError(
    'capability_not_supported',
    DEVICE_LABEL,
    `fm9 ${op}: not available in the foundation-verification scaffold. ` +
      'The FM9 block/param catalog has not been mined yet; only device ' +
      'identification, switch_preset, and switch_scene are wired.',
    {
      retry_action:
        'Use switch_preset / switch_scene / describe_device for now. The full ' +
        'surface lands after the protocol foundation is hardware-verified and ' +
        'the FM9-Edit catalog mining pass runs.',
    },
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

/** Render a MULTIPURPOSE_RESPONSE result-code into a human-readable suffix. */
function formatErrorCode(report: { resultCode: number; description?: string }): string {
  const hex = `0x${report.resultCode.toString(16).padStart(2, '0')}`;
  return report.description !== undefined ? `${report.description} (${hex})` : `unknown result code ${hex}`;
}

/**
 * Send wire bytes and watch for a 0x64 MULTIPURPOSE_RESPONSE rejection
 * in a short window after the write. The family emits 0x64 only on
 * rejection — no echo on accept — so the predicate is "rejection came
 * back" rather than "ack came back."
 */
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
    return undefined; // No rejection within window → write accepted.
  }
}

// ── Reader ─────────────────────────────────────────────────────────
//
// getParam / getParams are REQUIRED by the DeviceReader contract, but
// the scaffold has no param catalog to resolve names against — both
// refuse with a structured capability error until the catalog lands.

const reader: DeviceReader = {
  async getParam(
    _ctx: DispatchCtx,
    _block: string,
    _name: string,
    _channel?: string | number,
  ): Promise<ReadResult> {
    throw notScaffolded('get_param');
  },

  async getParams(
    _ctx: DispatchCtx,
    _queries: readonly ParamQuery[],
  ): Promise<BatchReadResult> {
    throw notScaffolded('get_params');
  },
};

// ── Writer ─────────────────────────────────────────────────────────

const writer: DeviceWriter = {
  buildSetParam(_block: string, _name: string, _wireValue: number): number[] {
    throw notScaffolded('set_param');
  },

  buildSwitchPreset(location: LocationRef): number[] {
    const n = parseLocation(location);
    return buildSwitchPresetPC(n);
  },

  buildSwitchScene(scene: number): number[] {
    // Unified surface scene numbers are 1-indexed (display); wire is 0-indexed.
    return buildSetScene(scene - 1);
  },

  async switchPreset(
    ctx: DispatchCtx,
    location: LocationRef,
  ): Promise<WriteResult> {
    const n = parseLocation(location);
    const bytes = buildSwitchPresetPC(n);
    // HARDWARE-VERIFIED (FM9 foundation probe, 2026-06-06): Windows'
    // WinMM backend (node-midi/RtMidi) rejects the concatenated
    // CC0+CC32+PC blob with "message size is greater than 3 bytes
    // (and not sysex)" and the switch silently never leaves the host.
    // Send the three channel messages separately.
    ctx.conn.send(bytes.slice(0, 3)); // CC 0  (Bank MSB)
    ctx.conn.send(bytes.slice(3, 6)); // CC 32 (Bank LSB)
    ctx.conn.send(bytes.slice(6, 8)); // Program Change
    // Optional read-back: the family answers QUERY PATCH NAME with the
    // now-active preset number + name, which both verifies the switch
    // landed AND exercises the model-byte hypothesis. Best-effort — a
    // timeout downgrades to the no-ack warning rather than failing.
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
        'fm9 switch_preset: sent standard MIDI Program Change + Bank Select on ' +
        'channel 1 (Fractal factory default). No QUERY PATCH NAME response came ' +
        'back within the window, so the switch is unconfirmed — check the front ' +
        'panel. If the FM9 listens on a different MIDI channel, the switch ' +
        'silently no-ops. ' + FOUNDATION_WARNING,
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

// ── Descriptor ─────────────────────────────────────────────────────

export const FM9_DESCRIPTOR: DeviceDescriptor = {
  id: 'fm9',
  display_name: 'Fractal FM9',
  preset_class: 'layout',
  connection_label: 'fm9',
  port_match: [
    // /fm-?9/i — matches "FM9 MIDI Out", "Fractal Audio FM9", "FM-9", etc.
    // Must register BEFORE AM4's /Fractal/i catch-all (see header).
    { pattern: /fm-?9/i },
  ],
  capabilities: {
    slot_model: 'grid',
    // 4×14 per docs/FRACTAL-PRESET-SCHEMA.md ("FM9: 4×14 grid,
    // A/B/C/D channels, 8 scenes: schema-ready"). ⚠️ VERIFY the column
    // count against FM9-Edit before relying on it — the III's note
    // shows these dimensions track firmware revisions.
    grid: { rows: 4, cols: 14 },
    has_scenes: true,
    scene_count: 8,
    has_channels: true,
    channel_names: ['A', 'B', 'C', 'D'],
    preset_location_format: /^(?:\d{1,3})$/,
    supports_save: false,           // not wired in the foundation scaffold
    supports_lineage: false,
    atomic_read: false,
  },
  canonical_terms: {
    block: 'block',
    slot: 'grid cell (row 1..4, col 1..14)',
    preset: 'preset',
    scene: 'scene 1..8',
    channel: 'channel A/B/C/D',
    location: 'preset slot 0..511 (integer)',
  },
  // Foundation scaffold: NO block/param schema yet. list_params returns
  // nothing; set_param / get_param refuse via the reader/writer stubs.
  blocks: {},
  reader,
  writer,
  agent_guidance: {
    foundation_status: [
      'The FM9 descriptor is a foundation-verification scaffold. Only',
      'device identification, switch_preset (0..511), and switch_scene',
      '(1..8) are wired; the block/param catalog has not been mined.',
      'Wire shapes are cloned from the Axe-Fx III; the model byte',
      '(0x12), preset switch (bank in CC0), scene switch, and QUERY',
      'PATCH NAME / STATUS DUMP framing are hardware-verified against',
      'a real FM9 (2026-06-06). Surface every result to the user for',
      'front-panel confirmation, and report mismatches.',
    ].join(' '),
  },
};
