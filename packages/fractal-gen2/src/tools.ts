/**
 * Axe-Fx II shared-helper barrel.
 *
 * The Axe-Fx II is a unified-surface device: every tool the user calls
 * is the port-dispatched unified surface (`set_param`, `apply_preset`,
 * `get_preset`, ...). The device-namespaced `axefx2_*` tool surface was
 * removed once the unified surface absorbed every case.
 *
 * What remains here is a re-export of the helpers that outlived the tool
 * surface and are still imported by the server boot path and by scripts:
 *
 *   - `describeAxeFxIIPortStatus` — startup-banner port probe (server-all)
 *   - `resetAxeFxIIConnection`    — drop the cached MIDI handle
 *   - `findParam`                 — param-name resolver (param-lookup script)
 *
 * The substantive shared logic (apply executor, audibility check, dirty
 * gate, MIDI lazy-init) lives in `tools/{applyExecutor,audibility,shared}.ts`
 * and is consumed directly by the unified descriptor.
 */

export {
  describeAxeFxIIPortStatus,
  resetAxeFxIIConnection,
  findParam,
} from './tools/shared.js';
