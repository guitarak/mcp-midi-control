# Changelog

All notable changes to MCP MIDI Control are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released version has one entry here and one corresponding commit. Fixes
ship as patch releases.

## [0.1.0]

First public release. A local MCP server that lets Claude control real USB MIDI
gear by describing the sound you want, hardware-verified on Fractal AM4, Fractal
Axe-Fx II XL+, and ASM Hydrasynth Explorer, with Axe-Fx III in community beta and
generic MIDI for any USB device.

### Devices

- **Fractal Audio AM4.** Hardware-verified end-to-end. Full preset authoring,
  scene and channel control, and save-to-location.
- **Fractal Audio Axe-Fx II XL+** (firmware Quantum 8.02, model byte 0x07).
  Hardware-verified. Multi-scene preset authoring on the 4x12 grid, save to
  location, and X/Y channel state per block.
- **ASM Hydrasynth Explorer** (firmware 1.5.x). NRPN patch authoring via SysEx
  dump, mod-matrix and macro routing by name, and a patch recipe library.
- **Fractal Audio Axe-Fx III.** Community beta. The protocol is scaffolded from
  Fractal's published v1.4 MIDI implementation document and public captures, and
  every write is byte-verified against that evidence, but no round-trip has been
  confirmed on real III hardware yet. Every III tool response carries a beta
  notice. III owners can confirm what works without writing code; see
  `docs/AXEFX3-BETA-TESTING.md`.
- **Any USB MIDI device.** The generic-MIDI primitives reach gear that has no
  registered descriptor, so a Line 6 Helix, a Boss GT-1000, or any synth with a
  published CC chart is controllable from day one.

### Tool surface

- **Unified surface, same names on every device.** One port-dispatched verb set
  (`describe_device`, `list_params`, `get_param`, `set_param`, `get_params`,
  `set_params`, `set_block`, `set_bypass`, `get_preset`, `apply_preset`,
  `translate_preset`, `switch_preset`, `save_preset`, `switch_scene`,
  `scan_locations`, `lookup_lineage`, `find_compatible_types`) covers every
  registered device. Adding a device means registering a descriptor, not adding
  tools.
- **Voice-class tools for synths** (`apply_patch`, `init_patch`,
  `set_system_param`, `set_macro`, `set_macro_route`, `set_mod_route`). With
  `set_mod_route` and `set_macro_route` an agent can wire the modulation matrix
  and performance macros by name, so it builds an expressive voice, not just
  static knobs.
- **Generic-MIDI primitives** (`send_cc`, `send_note`, `send_chord`,
  `send_sequence`, `send_program_change`, `send_nrpn`, `send_sysex`,
  `send_panic`, `send_song_position`, `send_reset_controllers`,
  `send_clock_start` / `send_clock_stop` / `send_clock_continue`) plus MIDI
  utilities (`list_midi_ports`, `reconnect_midi`).
- The exact count and per-tool reference are generated from the live server into
  `docs/TOOLS.md`; preflight fails on drift.

### Tone building

- **Build a whole preset in one call.** `apply_preset` takes blocks, params,
  scenes, and a name; without a target location it writes the working buffer for
  audition, with one it switches to the location and saves. `verify_chain` reads
  back every written param and reports drift.
- **Recipes as named starting points.** `recipe_id` applies a curated starting
  point on `apply_preset` (guitar) or `apply_patch` (synth). The Hydrasynth ships
  a patch library auditioned on hardware (Prophet-5 pad, Juno-106 pad, OB-Xa Jump,
  and more); the guitar side ships utility recipes (pitch, wah, filter, auto-wah,
  diatonic pitch). The recipe library is meant to grow with community help.
- **Cross-device tone porting** (`translate_preset`). Translate a preset spec
  from one device's vocabulary to another (AM4, Axe-Fx II, Axe-Fx III): maps
  block roles, translates param names and enum values, and collapses channel and
  scene cardinality. Read-only; it returns the translated spec and warnings, and
  the agent applies it on the target.
- **Lineage corpus** (`lookup_lineage`). Authored real-hardware lineage for amp,
  drive, and cab models: what each models, manufacturer and model notes, and
  designer context. AM4 and Axe-Fx II ship lineage corpora.
- **Loudness-aware gain staging.** Per-amp loudness offsets and scene-leveling
  come from a measured corpus, so a lead scene gets louder than rhythm without
  redlining.
- **Cross-device tolerance.** Param-name aliases (`drive.volume` resolves to
  `drive.level` where the device uses that name) and case-insensitive,
  whitespace-tolerant, fuzzy enum matching, so the same instruction works across
  devices.

### Opinionated behavior, consistent across devices

- **Display-first, including enum options.** Every value in and out is what the
  front panel shows (0..10, dB, ms, a ratio, an enum name), never a wire byte or
  internal index, even for non-linear mappings. A parity gate round-trips every
  such parameter in preflight and fails the build on any leak.
- **Tempo-first when supported.** Time-based parameters prefer syncing to the
  song or preset tempo, advisory rather than a hard gate, and the tool warns when
  a param it touched is tempo-locked.
- **No silent saves.** Saving to flash requires explicit save intent from the
  user; building a tone auditions in the working buffer and does not persist.
- **No silent edit loss.** Navigating away from an edited buffer refuses unless
  the caller discards or saves first, device-sourced where the hardware exposes a
  dirty signal and heuristic where it does not.
- **No silent overwrites.** Multi-preset writes pre-flight scan the target range
  and surface what would be lost.
- **Every write is acknowledged.** Writes wait for the device echo before
  reporting success, with a cold-start retry and auto-reconnect.

### Built to the MCP spec (2025-11-25)

- **Structured tool output.** Tools with a stable result shape declare an
  `outputSchema` and return `structuredContent` plus a JSON text fallback.
- **Tool annotations on every tool** (read-only, destructive, idempotent,
  open-world hints), with a CI gate that rejects any unannotated tool.
- **Actionable errors.** Correctable input returns a structured result the agent
  can fix and retry; operational failures return a tool-execution error with a
  suggestion, valid options, and a retry action, never an opaque protocol fault.

### Engineering

- **Layered architecture.** The wire codec is published independently on npm as
  `fractal-midi` (builders, parsers, param dictionaries, calibration, lineage),
  with no MIDI transport and no MCP code. Transport sits behind one interface;
  the MCP server only boots and registers.
- **Executable contracts.** Byte-exact SysEx goldens built from real captures,
  the display-first parity gate, the tool-annotation and tool-inventory gates,
  and per-package strict typechecks all run under one command, `npm run
  preflight`.
- **Distribution.** A Windows release ZIP bundles the Node runtime, a prebuilt
  native MIDI binary, and a `setup.cmd` that registers the server with Claude
  Desktop. End users need no developer tooling.

### License

- Apache-2.0, with the patent grant, from day one. Trademark statement in
  `NOTICE`. Security policy in `SECURITY.md`.

[0.1.0]: https://github.com/TheAndrewStaker/mcp-midi-control/releases
