/**
 * FM9 descriptor export. Importing this file brings in the MIDI
 * connector side-effect (via `./midi.js`) so that
 * `ensureConnection('fm9')` routes through `connectFM9()`.
 *
 * Device registration (registerDevice) is intentionally NOT done here
 * as a side effect — the caller (server-all/src/server/index.ts) calls
 * `registerMcpDevice(FM9_DESCRIPTOR)` explicitly, matching the same
 * explicit-registration pattern used by AM4, Axe-Fx II/III, and
 * Hydrasynth. This keeps test scripts that import the descriptor clean
 * (no global registry mutations on import).
 */
import './midi.js';
export { FM9_DESCRIPTOR } from './descriptor.js';
