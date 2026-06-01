/**
 * Hydrasynth port-status helper. The main mcp-midi-control server
 * uses this during startup to log a "Hydrasynth detected at port [N]"
 * line for observability.
 *
 * No tool registrations live here. The previous `hydra_reconnect_midi`
 * tool was removed in favor of the generic `reconnect_midi`, and the
 * informational `hydra_get_active_patch` was removed because the
 * Hydrasynth has no SysEx for reading the active slot (users read the
 * front panel directly).
 */

import { listHydrasynthOutputs } from '../midi.js';

export function describeHydrasynthPortStatus(): string {
  try {
    const outputs = listHydrasynthOutputs();
    const hydra = outputs.find((p) => p.looksLikeHydrasynth);
    if (hydra) return `Hydrasynth detected at output [${hydra.index}]: "${hydra.name}"`;
    if (outputs.length === 0) return 'no MIDI outputs visible';
    return `Hydrasynth not visible among ${outputs.length} output(s): ${outputs.map((p) => p.name).join(', ')}`;
  } catch (err) {
    return `port scan failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
