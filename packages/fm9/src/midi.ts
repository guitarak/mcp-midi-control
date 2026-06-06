/**
 * Fractal FM9-specific MIDI helpers. Wraps the generic transport in
 * @mcp-midi-control/core/midi/transport with FM9-specific port-name
 * needles + onboarding hints. Cloned from the Axe-Fx III's midi.ts.
 *
 * Status: 🟡 foundation-verification scaffold. The wire envelope shape
 * is shared with the Axe-Fx III (same modern Fractal SysEx family,
 * `F0 00 01 74 [model] ... [checksum] F7`), so transport + connection
 * are low-risk. The MODEL BYTE itself is a hypothesis pending hardware
 * verification — see `FM9_MODEL_ID` in `fractal-midi/fm9`.
 */

import {
  connect,
  mockConnect,
  type MidiConnection,
  type MockResponder,
} from '@mcp-midi-control/core/midi/transport.js';
import { markClean, markDirty } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import { FM9_MODEL_ID } from 'fractal-midi/fm9';

export {
  connect,
  toHex,
  type ConnectOptions,
  type MidiConnection,
} from '@mcp-midi-control/core/midi/transport.js';

// ── Dirty-state classification — III-derived hypothesis ─────────────
//
// The III emits a STATE_BROADCAST frame (`fn=0x01` with sub-action
// `04 01` at payload pos 0..1) when the working buffer is edited; the
// FM9 shares the firmware lineage so the same inbound classifier is
// wired here as a hypothesis. The clean signal is code-sourced: we
// mark clean when WE emit a Program Change (switch_preset). The
// foundation scaffold wires no edit-class outbound SysEx yet, so
// there is no outbound markDirty path.

const FM9_DIRTY_LABEL = 'fm9';

function isFractalFM9Envelope(bytes: readonly number[]): boolean {
  return bytes.length >= 6
    && bytes[0] === 0xf0
    && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x74
    && bytes[4] === FM9_MODEL_ID;
}

function isCleanOutboundFM9(bytes: readonly number[]): boolean {
  // switch_preset uses MIDI Program Change + Bank Select (not SysEx).
  // buildSwitchPresetPC produces a 9-byte sequence with the PC byte at
  // offset 6; match a PC status byte at any offset.
  for (let i = 0; i < bytes.length; i++) {
    if ((bytes[i] & 0xf0) === 0xc0) return true;
  }
  return false;
}

function isStateBroadcastInboundFM9(bytes: readonly number[]): boolean {
  if (!isFractalFM9Envelope(bytes)) return false;
  if (bytes[5] !== 0x01) return false;
  if (bytes.length < 10) return false;
  return bytes[6] === 0x04 && bytes[7] === 0x01;
}

/**
 * Wrap an FM9 connection with dirty-state classification. Adds:
 *   - inbound `onMessage` handler that fires `markDirty` on STATE_BROADCAST
 *   - `send` wrapper that fires `markClean` on switch_preset (MIDI PC)
 *
 * Returns a new connection object that delegates everything else to the
 * underlying conn unchanged.
 */
function wrapWithDirtyClassification(conn: MidiConnection): MidiConnection {
  conn.onMessage((bytes) => {
    if (isStateBroadcastInboundFM9(bytes)) {
      markDirty(FM9_DIRTY_LABEL);
    }
  });
  const originalSend = conn.send;
  return {
    ...conn,
    send: (bytes: number[]) => {
      if (isCleanOutboundFM9(bytes)) markClean(FM9_DIRTY_LABEL);
      originalSend(bytes);
    },
  };
}

/**
 * Substrings used to find FM9 ports. The FM9 is class-compliant USB
 * MIDI; Windows / macOS surface it with "FM9" in the port name
 * (e.g. "FM9 MIDI In" / "FM9 MIDI Out"). The match is
 * case-insensitive (transport.ts lowercases both sides).
 *
 * We deliberately do NOT match the bare "Fractal" needle here — AM4
 * owns that as a catch-all, so registration order in
 * server-all/server/index.ts puts FM9 BEFORE AM4 (same
 * registration-order tiebreaking as the Axe-Fx III).
 */
export const FM9_PORT_NEEDLES = ['fm9', 'fm-9'] as const;

/**
 * Open a connection to the FM9. Thin wrapper around connect() that
 * supplies the FM9-specific name needles and the onboarding hints
 * users hit during setup.
 */
export function connectFM9(): MidiConnection {
  if (process.env.MCP_MOCK_TRANSPORT === '1') {
    return wrapWithDirtyClassification(mockConnect({ responder: fm9MockResponder }));
  }
  const conn = connect({
    needles: FM9_PORT_NEEDLES,
    notFoundLeadIn: 'FM9 not found in the MIDI device list. Common causes:',
    notFoundHints: [
      '  - FM9 is powered off or not connected by USB',
      '  - USB cable is data-only or not seated fully',
      '  - On Windows: FM9-Edit claimed the MIDI port exclusively — quit FM9-Edit then retry',
      '',
      'Once visible, call `list_midi_ports` to confirm the server sees it, then retry. Use `reconnect_midi` to force a fresh handle.',
    ],
  });
  return wrapWithDirtyClassification(conn);
}

/**
 * FM9 mock response synthesizer. Minimal scaffolding — the FM9 ships
 * as a foundation-verification scaffold, so the mock's job is to make
 * agent-regression flows runnable without hardware. Returns [] (no
 * inbound) for every outgoing message — read predicates time out,
 * write tools see the outbound classification fire from
 * `wrapWithDirtyClassification`. Extend with FM9-specific response
 * shapes once hardware captures land.
 */
const fm9MockResponder: MockResponder = (_outgoing) => [];

// Register the FM9 connector with the shared connection registry as a
// module-load side effect. Importing anything from this module (or any
// module that transitively imports it) makes `ensureConnection(FM9_LABEL)`
// route through `connectFM9()`.
import { registerConnector, FM9_LABEL } from '@mcp-midi-control/core/server-shared/connections.js';
registerConnector(FM9_LABEL, connectFM9);
export { FM9_LABEL };

// ── Startup banner helper ────────────────────────────────────────────

import midi from 'midi';

interface FM9PortInfo {
  index: number;
  name: string;
  looksLikeFM9: boolean;
}

/**
 * Enumerate output ports without opening any. Used by the startup
 * banner so the server can log a verdict ("FM9 detected" / "FM9 not
 * visible") at boot — mirrors the AM4 + Axe-Fx II/III + Hydrasynth
 * startup-banner pattern for consistency.
 */
export function listFM9Outputs(): FM9PortInfo[] {
  const out = new midi.Output();
  try {
    const result: FM9PortInfo[] = [];
    for (let i = 0; i < out.getPortCount(); i++) {
      const name = out.getPortName(i);
      const lower = name.toLowerCase();
      result.push({
        index: i,
        name,
        looksLikeFM9: FM9_PORT_NEEDLES.some((n) => lower.includes(n)),
      });
    }
    return result;
  } finally {
    out.closePort();
  }
}

/**
 * Startup-banner helper — describes whether an FM9 output port is
 * visible right now, without opening it. Returns a single-line string
 * for the server's startup stderr log.
 */
export function describeFM9PortStatus(): string {
  try {
    const outputs = listFM9Outputs();
    const fm9 = outputs.find((p) => p.looksLikeFM9);
    if (fm9) return `FM9 detected at output [${fm9.index}]: "${fm9.name}" (🟡 foundation-verification scaffold)`;
    if (outputs.length === 0) return 'no MIDI outputs visible';
    return `FM9 not visible among ${outputs.length} output(s)`;
  } catch (err) {
    return `port scan failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
