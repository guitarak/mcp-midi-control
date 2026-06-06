#!/usr/bin/env node
/**
 * MCP MIDI Control: MCP server (stdio).
 *
 * The boot + register-loop. One `register*Tools(server)` call per
 * supported device, plus a couple of generic-MIDI primitive families.
 *
 * Where things live (npm workspace layout):
 *   packages/server-all/src/server/shared/    cross-tool helpers
 *                                               (connection registry, channel
 *                                                cache, wire-op helpers,
 *                                                paramKey resolution)
 *   packages/server-all/src/server/tools/     generic-MIDI tool families that
 *                                               work against any USB MIDI
 *                                               device (`send_*`,
 *                                               `list_midi_ports`,
 *                                               `reconnect_midi`)
 *   packages/am4/src/tools/                   AM4 tool family (split by family)
 *   packages/axe-fx-ii/src/tools/             Axe-Fx II tool family
 *   packages/axe-fx-iii/src/tools/            Axe-Fx III tool family (beta)
 *   packages/hydrasynth/src/                  Hydrasynth tool family
 *   packages/core/src/protocol-generic/       cross-device unified tools +
 *                                               dispatcher
 *
 * Adding a new device follows the same shape: stand up a new workspace
 * package under `packages/<device>/`, export a
 * `register<Device>Tools(server)`, and register it below. The unified
 * surface (set_param, apply_preset, ...) dispatches automatically once
 * the descriptor is registered.
 *
 * Run standalone for a quick sanity check (development only; picks up
 * source changes without rebuilding):
 *   npm run server          # tsx-based, requires project cwd
 *
 * Claude Desktop wiring: run `npm run setup-claude-desktop` (handles
 * build + config-file detection + idempotent merge), or hand-edit
 * `%APPDATA%\Claude\claude_desktop_config.json` after `npm run build`:
 *
 *   "mcp-midi-control": {
 *     "command": "node",
 *     "args": ["C:\\\\path\\\\to\\\\mcp-midi-control\\\\packages\\\\server-all\\\\dist\\\\server\\\\index.js"],
 *     "env": {}
 *   }
 *
 * `tsx`-against-source DOES NOT work as a Claude Desktop entry: Desktop
 * spawns the server with cwd = C:\Windows\System32, so tsx can't find
 * the workspace tsconfigs and intra-package imports fail to resolve.
 * Point Claude Desktop at the built `packages/server-all/dist/server/index.js`
 * instead.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { listMidiPorts } from '@mcp-midi-control/core/midi/transport.js';
import { AM4_PORT_NEEDLES } from '@mcp-midi-control/am4/midi.js';

import { registerMidiControlTools } from './tools/midi-control.js';
import { registerMidiPrimitiveTools } from './tools/midi-primitives.js';

// import { registerAM4Tools } from '@mcp-midi-control/am4/tools/index.js';
import { describeAxeFxIIPortStatus } from '@mcp-midi-control/axe-fx-ii/tools.js';
import { describeAxeFxIIIPortStatus } from '@mcp-midi-control/axe-fx-iii/tools.js';
import { describeFM9PortStatus } from '@mcp-midi-control/fm9/midi.js';
import { registerHydrasynthTools, describeHydrasynthPortStatus } from '@mcp-midi-control/hydrasynth/server.js';

// Unified tool surface — descriptor registration. The dispatcher
// resolves a tool call's `port` to a registered descriptor; per-device
// behavior lives in the descriptor's schema + reader/writer adapters.
import { registerDevice as registerMcpDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { registerDeviceResources } from '@mcp-midi-control/core/protocol-generic/resources.js';
import { registerUnifiedTools } from '@mcp-midi-control/core/protocol-generic/tools.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/axe-fx-iii/device.js';
import { FM9_DESCRIPTOR } from '@mcp-midi-control/fm9/device.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';

// -- Server setup -----------------------------------------------------------

/**
 * Server-level instructions — sent once at the MCP `initialize`
 * handshake, ahead of any tool call. Cross-cutting agent contracts
 * that apply to the entire MIDI tool surface live here instead of
 * being copy-pasted into every tool description.
 */
const SERVER_INSTRUCTIONS = [
  'mcp-midi-control is a USB MIDI control server for Fractal AM4, Fractal',
  'Axe-Fx II XL+, ASM Hydrasynth Explorer, and any generic MIDI device the',
  'OS exposes. Pick tools by intent, not by name length.',
  '',
  'DEFAULT BEHAVIOR — call the tools, do not write specs.',
  'When the user asks for an audible change on connected hardware (build a',
  'tone, tweak a param, switch a preset, switch a scene, save a patch), USE',
  'THE TOOLS. Do not produce a written spec / preset doc / parameter table',
  'instead of calling the tools unless the user explicitly asked for a dry',
  'run, design exercise, or "what would the params look like" preview.',
  'Audible-change requests are tool-call requests by default.',
  '',
  'SESSION-START SETUP — call describe_device(port) ONCE.',
  'Before the first tone-building or apply_preset call against a device,',
  'call describe_device({port}) once. The response carries device-specific',
  'agent_guidance (channel/scene model, applicability rules, iconic-amp',
  'shortcuts, enum-name conventions, tempo-sync discipline, save-language',
  'anti-patterns, read-vs-navigate constraints) — load it into context',
  'and refer to it while planning. Skipping this is the #1 cause of "the',
  'AI changed something but it doesn\'t sound right."',
  'This server is OPINIONATED about musical defaults: on every device that',
  'supports them it prefers tempo-synced timing (musical note divisions like',
  '1/4 and 1/8, dotted variants, over raw ms/Hz) and gain-staged loudness',
  '(display-first levels, data-driven scene leveling, audible-by-construction',
  'patches). Reach for those defaults unless the user asks otherwise; the',
  'per-device agent_guidance carries the specifics.',
  '',
  'ONE TOOL SURFACE.',
  'The unified surface (apply_preset, set_param, get_param, switch_preset,',
  'save_preset, switch_scene, set_block, set_bypass, set_params, get_params,',
  'list_params, lookup_lineage, scan_locations, describe_device,',
  'find_compatible_types, get_preset, translate_preset, init_patch,',
  'set_system_param, set_macro, apply_patch, send_chord, send_sequence)',
  'routes via the `port` argument and works against any registered device.',
  'All tools are unified; there are no device-namespaced alternatives.',
  '',
  'SAVE LANGUAGE — strict vocabulary list.',
  'Persisting to flash is destructive and gated. Only set save_authorized=',
  'true when the user used explicit save vocab: save, store, keep, put on,',
  'persist, commit to flash. State descriptions ("I want X to have a copy',
  'of Y", "make X look/sound like Y", "create at X based on Y") describe',
  'the desired audition state, NOT save intent — leave save_authorized=false',
  'and audition. When ambiguous, audition and ASK before persisting.',
].join('\n');

const server = new McpServer({
  name: 'mcp-midi-control',
  version: '0.1.0',
}, {
  instructions: SERVER_INSTRUCTIONS,
});

// -- Generic-MIDI tool families (any device) --------------------------------
//
// These tools target a port by name substring and don't carry any
// device-specific protocol logic. Useful when a device has a published
// CC / NRPN / SysEx chart but no dedicated wrapper yet.

registerMidiControlTools(server);   // list_midi_ports, reconnect_midi
registerMidiPrimitiveTools(server); // send_cc / _note / _program_change / _nrpn / _sysex

// -- Per-device tool families -----------------------------------------------
//
// Device-namespaced tools (am4_*, axefx2_*, hydra_*) have been removed
// from the registered surface. Code is preserved in the device packages
// for reference. Hydrasynth-specific tools that haven't migrated to the
// unified surface are still registered below.
registerHydrasynthTools(server);    // Hydra-specific tools not yet on unified surface

// -- Unified-surface descriptor registration --------------------------------
//
// Order matters: register MORE SPECIFIC port_match regexes FIRST so
// tiebreaking favors the narrower pattern.
//
//   1. Axe-Fx III  /axe-?fx ?iii/i   (most specific — wins on "Axe-Fx III")
//   2. FM9         /fm-?9/i          (distinct token; must precede AM4's catch-all,
//                                     e.g. a port named "Fractal Audio FM9")
//   3. Axe-Fx II   /axe-?fx/i        (would also match III if III didn't win first)
//   4. AM4         /Fractal/i        (catch-all for the modern Fractal family)
//   5. Hydrasynth  /hydrasynth/i     (different vendor — order doesn't matter for it)
//
// Axe-Fx III is a community-beta descriptor: scaffolded from Fractal's
// published v1.4 PDF and AxeEdit III editor assets, but NOT yet hardware-
// verified end-to-end. Read + navigation tools work per spec; write tools
// refuse with structured "pending capture" errors until a community
// contributor runs the USBPcap workflow.
registerMcpDevice(AXEFX3_DESCRIPTOR);
// FM9 is a foundation-verification scaffold: identification +
// switch_preset + switch_scene only, cloned from the III. Registered
// BEFORE AM4 so its /fm-?9/i pattern wins over AM4's /Fractal/i
// catch-all on ports like "Fractal Audio FM9".
registerMcpDevice(FM9_DESCRIPTOR);
registerMcpDevice(AXEFX2_DESCRIPTOR);
registerMcpDevice(AM4_DESCRIPTOR);
// Hydrasynth registers after the Fractal devices — its port_match
// regex (/hydrasynth|asm.*hydra/i) can't collide with the Fractal
// patterns, so ordering doesn't matter for correctness.
registerMcpDevice(HYDRASYNTH_DESCRIPTOR);
registerUnifiedTools(server);
// Expose each device's agent_guidance topics as MCP resources so the
// agent can pull individual topics on demand instead of always
// receiving the full agent_guidance bag via describe_device.
registerDeviceResources(server);

// -- Start ------------------------------------------------------------------

/**
 * Exit the process when the MCP client disconnects or the OS signals
 * termination. A stdio MCP server child has no reason to outlive its
 * client, and lingering past disconnect is actively harmful here: each
 * orphaned instance keeps the USB-MIDI output port open, so a later
 * server's writes route through a dead/duplicate handle and silently
 * never reach the device (observed 2026-05-31: 5 stale `server-all`
 * processes held the Hydrasynth port; sends "succeeded" but the device
 * stayed deaf). Exiting releases the port back to the OS for the next
 * instance. Registered once; idempotent via the `closing` guard.
 */
let closing = false;
function shutdown(reason: string): void {
  if (closing) return;
  closing = true;
  console.error(`MCP MIDI Control server shutting down (${reason}); releasing MIDI ports.`);
  // Process exit hands all open node-midi port handles back to the OS.
  process.exit(0);
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Self-terminate on client disconnect (the stdio pipe closes when
  // Claude exits or reconnects) and on OS signals, so we never accumulate
  // orphaned servers fighting over the MIDI port. stdin close/end is the
  // disconnect signal for a stdio MCP server.
  process.stdin.on('close', () => shutdown('stdin closed'));
  process.stdin.on('end', () => shutdown('stdin ended'));
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => shutdown(sig));
  }
  // MCP servers log to stderr — stdout is owned by the transport.
  // The port enumeration mirrors what list_midi_ports would return at
  // this moment; if the user reports "AM4 not connected" later, the
  // startup banner captures whatever state the server started with.
  console.error('MCP MIDI Control MCP server running on stdio.');
  try {
    const { inputs, outputs } = listMidiPorts(AM4_PORT_NEEDLES);
    const am4In = inputs.find((p) => p.matched);
    const am4Out = outputs.find((p) => p.matched);
    const verdict = am4In && am4Out
      ? `AM4 detected (in: "${am4In.name}", out: "${am4Out.name}")`
      : am4In || am4Out
        ? 'AM4 partially visible — one direction missing; check driver'
        : inputs.length === 0 && outputs.length === 0
          ? 'no MIDI ports visible (driver likely not installed)'
          : `AM4 not visible among ${inputs.length} inputs / ${outputs.length} outputs`;
    console.error(`Startup port scan: ${verdict}.`);
  } catch (err) {
    // Port enumeration shouldn't throw, but if node-midi barfs on this
    // platform we don't want startup to die — log and continue.
    console.error(`Startup port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Hydrasynth port-scan banner — separate from the AM4 scan because
  // they're independent devices that may both be plugged in (or just
  // one, or neither). Honest reporting of what's actually connected.
  try {
    console.error(`Hydrasynth port scan: ${describeHydrasynthPortStatus()}.`);
  } catch (err) {
    console.error(`Hydrasynth port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Axe-Fx II port-scan banner — same independence rationale as above.
  try {
    console.error(`Axe-Fx II port scan: ${describeAxeFxIIPortStatus()}.`);
  } catch (err) {
    console.error(`Axe-Fx II port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Axe-Fx III port-scan banner — 🟡 community beta (BK-015). Banner
  // surfaces the device's presence + beta status so users see in the
  // MCP log panel that the III is registered and what tier of support
  // ships today.
  try {
    console.error(`Axe-Fx III port scan: ${describeAxeFxIIIPortStatus()}.`);
  } catch (err) {
    console.error(`Axe-Fx III port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  // FM9 port-scan banner — 🟡 foundation-verification scaffold.
  // Surfaces the device's presence + scaffold status so users see in
  // the MCP log panel that the FM9 is registered and what tier of
  // support ships today.
  try {
    console.error(`FM9 port scan: ${describeFM9PortStatus()}.`);
  } catch (err) {
    console.error(`FM9 port scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch((err) => {
  console.error('Fatal server error:', err);
  process.exit(1);
});
