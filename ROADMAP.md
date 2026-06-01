# Roadmap

## Where things stand

This is the first public release. Three devices are first-class and hardware-verified: the Fractal AM4, the Fractal Axe-Fx II XL+ (model byte 0x07, confirmed on Quantum 8.02 firmware), and the ASM Hydrasynth Explorer. On those, preset and patch authoring is audio-confirmed end to end: you describe a tone in chat and the server builds it on the device. The Fractal Axe-Fx III is in community beta. Its wire shapes are byte-verified against Fractal's published "MIDI for Third-Party Devices" v1.4 spec and a set of public captures, but they have not been confirmed on real hardware (the maintainer does not own a III), so every III tool response carries an unverified-on-hardware notice. Beyond the registered devices, generic-MIDI primitives (CC, NRPN, SysEx, program change, notes, clock, and more) reach any USB MIDI device the OS exposes, so synths, looper pedals, and other gear are usable from day one.

## Milestones

### Done

- **Workspace and codec split.** The pure wire codec lives in its own package, `fractal-midi`, published to npm with no MIDI transport and no MCP code. The MCP server packages depend on it. The codec is reusable by other consumers and testable in isolation.
- **Multi-device unified tool surface.** One port-dispatched verb set (`set_param`, `get_param`, `apply_preset`, `translate_preset`, `get_preset`, `switch_preset`, `save_preset`, `switch_scene`, `set_block`, `set_bypass`, `lookup_lineage`, `scan_locations`, `describe_device`, `find_compatible_types`, and the batch read/write pair) works across every registered device. Adding a device is a descriptor plus a wire adapter, not a new set of tools. The earlier device-namespaced tools have been removed in favor of this surface.
- **Recipes, mod-matrix, and macro routing.** Named recipes start a build from a curated point: `recipe_id` on `apply_preset` for the linear guitar devices, and on `apply_patch` for the Hydrasynth. The Hydrasynth ships a patch library auditioned on hardware (Prophet-5 pad, Juno-106 pad, OB-Xa Jump, and others); the guitar side ships utility effect recipes (pitch, wah, filter, auto-wah, diatonic pitch). The voice-class tools (`set_mod_route`, `set_macro_route`, `set_macro`) wire a synth's modulation matrix and performance macros by name, so an agent can build a voice that moves, not just a static set of knobs.

### In progress (help wanted)

- **Axe-Fx III to first-class.** The protocol layer is written and the write tools already emit bytes, but nothing has been confirmed against a real front panel. Closing this needs III owners running short test sessions, pasting the JSON responses back, and reporting where front-panel behavior diverges from the spec. Fixes and additional capture data move it from community beta to hardware-verified. The community beta-testing guide explains the five short sessions that get us there; no capture tools or developer setup required.

### Next (demand-driven)

- **Expansion beyond Fractal.** The descriptor model is built so a new device is a schema plus a wire adapter, not new tools. The natural next targets are popular amp modelers that publish their MIDI specifications (Line 6 Helix and similar) and other high-demand gear. Which device comes first is driven by demand: if owners ask for a specific modeler or synth and the protocol is documented, it moves up. Generic-MIDI primitives already cover the basics for anything with a published CC chart in the meantime.

## Decisions log

| Date | Decision | Rationale |
|---|---|---|
| | Publish the wire codec (`fractal-midi`) as its own npm package, separate from the MCP server. | Keeps the domain core free of MIDI I/O and MCP framework concerns, so it stays testable in isolation and other consumers can use it without pulling in the server. |
| | Unified, port-dispatched tool surface; adding a device means writing a descriptor, not new tools. | The public surface stays small and learnable while device coverage scales. Unsupported operations fail as capability checks rather than missing endpoints. |
| | Display-first tool I/O on every device, including enum option strings. | Tools speak front-panel units (0..10 knob, dB, ms, ratio, enum name); wire encoding never leaks through tool I/O. A parity gate round-trips every value and fails the build on any leak of an internal index or wire byte. |
| | Local stdio transport. | The server runs on the user's machine next to the USB MIDI hardware. No network surface, no cloud dependency, and the user's presets and gear stay local. |
| | Build to the current Model Context Protocol revision (2025-11-25). | Structured tool output with declared output schemas, the four behavioral annotation hints on every tool (gated in CI), and actionable error shapes so the agent can self-correct in one turn. A later release candidate exists but is not yet current stable, so we target the shipped revision. |
| | Remove the device-namespaced tools in favor of the unified surface. | Two parallel surfaces meant duplicated guidance and a larger thing to learn. The behavioral guidance now lives in each device's `describe_device` response, so the unified verbs carry it without a second tool family. |
