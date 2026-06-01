# Hydrasynth: protocol + research

ASM Hydrasynth (Explorer model, with the same engine across Keyboard /
Desktop / Deluxe). NRPN-based MIDI surface, not SysEx-heavy like the
Fractal devices. Code lives in
[`src/hydrasynth/`](../../../src/hydrasynth/) (codec) and the consumer MCP descriptors at [`packages/hydrasynth/` in the consumer repo](https://github.com/TheAndrewStaker/mcp-midi-control/tree/main/packages/hydrasynth).

## Files in this directory

- [`SYSEX-MAP.md`](./SYSEX-MAP.md): Hydrasynth wire-protocol
  reference. NRPN catalog, CC layout, SysEx envelope, voice
  architecture cross-references to the Owner's Manual.
- [`OVERVIEW.md`](./OVERVIEW.md): capability landscape: what's
  reachable from MIDI, what's MIDI-only, what's panel-only.
- [`preset-format-research.md`](./preset-format-research.md): research
  on the `.hydra` / `.patch` file format.

## See also

- [`./manuals/Hydrasynth_Explorer_Owners_Manual_2.2.0.txt`](./manuals/Hydrasynth_Explorer_Owners_Manual_2.2.0.txt):
  Explorer owner's manual extraction.
- [`./manuals/Hydrasynth_KB_DR_Owners_Manual_2.2.0.txt`](./manuals/Hydrasynth_KB_DR_Owners_Manual_2.2.0.txt):
  Keyboard / Desktop / Deluxe owner's manual extraction.
