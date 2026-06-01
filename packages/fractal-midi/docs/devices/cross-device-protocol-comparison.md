# Fractal protocol, cross-device comparison (AM4 vs III)

Distilled from the Ghidra-recovered workflow catalogs and host-emitter
maps for both AM4-Edit.exe and Axe-Edit III.exe.

Headline: **AM4 and III share the same architecture but diverge
significantly in wire-byte assignments and operation granularity.**

## Same architecture

Both editors implement the same state-machine pattern:

| Component | AM4 | III |
|---|---|---|
| State-machine initializer | `FUN_1402d83d0` | `FUN_1401f0f10` |
| Label registrator | `FUN_140060fb0` | `FUN_14005faa0` |
| Subscription registrar | `FUN_140196500` | `FUN_1401bac70` |
| Generic SysEx builders (primary) | `FUN_1401df710` (37 callers) | `FUN_1403437d0` (41 callers) |
| Generic SysEx builders (secondary) | `FUN_1401dd0d0`, `FUN_1401da020`, `FUN_1401df430` | `FUN_1403434b0` |
| PATCH_DUMP descriptor tables | `0x718090..0xe04440` | `0x1407aac70..0x1407ab940` (byte-identical) |
| PATCH_DUMP receiver dispatcher | `FUN_00512f30` (32-bit AxeEdit II legacy) | `FUN_14022ef30` |

The descriptor tables that drive PATCH_DUMP chunk parsing are
byte-for-byte IDENTICAL between AM4 and III. The wire format for
preset binaries is shared, both use 64 × 64 native ushorts per
preset with septet packing.

## Different wire-byte assignments per workflow

The same NAMED operation uses DIFFERENT fn-bytes on AM4 vs III:

| Workflow | AM4 fn | III fn |
|---|---:|---:|
| Query device version | `0x31` | `0x46` |
| Save Preset | `0x17` (device→host only) | `0x10` |
| Change Preset | `0x0F` | `0x11` |
| Revert Preset | `0x10` | `0x12` |
| Clear Preset | `0x11` | `0x13` |
| Change Scene | `0x16` | `0x15` |
| Set Scene Name | `0x13` | `0x16` |
| Copy Scene | `0x14` | `0x17` |
| Swap Scenes | `0x27` | `0x18` |
| Set Channel | `0x1D` | `0x2D` |
| Set Channel in all scenes | `0x1E, 0x1F` | `0x2E` |
| Bypass Block | `0x20` | `0x2A` |
| Set bypass in all scenes | `0x21` | `0x2B` |
| Bypass all blocks in current scene | `0x22` | `0x2C` |
| Block Copy | `0x28` | `0x35` |
| Block Paste | `0x29` | `0x36` |
| Block Move | `0x26` | `0x31` |
| Channel Copy | `0x2A` | `0x37` |
| Channel Paste | `0x2B` | _(no dedicated workflow)_ |
| Library Query | `0x26` | `0x34` |
| Export User Cab | `0x1C` | `0x1A` |

These divergent wire bytes are the reason the v1.4 PDF
documentation is inconsistent, Fractal apparently never published
a unified per-byte map; each editor codebase decided its own
byte assignments.

## Different operation granularity

AM4 emits more fn-bytes directly. III consolidates more operations
behind fn=0x01 SET_PARAMETER:

| Operation | AM4 host emit? | III host emit? |
|---|---|---|
| Bypass Block | ✓ (37 emitters of fn=0x20) | ✗ device-only |
| Block Copy | ✓ (2 emitters of fn=0x28) | ✗ device-only |
| Set Channel | ✗ device-only (0x1D) | ✗ device-only (0x2D) |
| Save Preset | ✗ device-only (0x17 is ACK) | ✓ (1 emitter of fn=0x10) |
| Change Scene | ✗ device-only (0x16) | ✓ (2 emitters of fn=0x15) |

**AM4 fn=0x20 with 37 emitters is its `Bypass Block` primitive.** III
doesn't have an equivalent, III editors trigger bypass via fn=0x01
SET_PARAMETER + the device broadcasts fn=0x2A ack.

**Architectural takeaway:** AM4 has MORE dedicated wire commands.
III has FEWER but more general primitives. The III's design is more
unified (fn=0x01 SET_PARAMETER + fn=0x77/0x78/0x79 PRESET_DUMP cover
80% of operations); AM4 spreads the same surface across more
dedicated fn-bytes.

This matches the device era: AM4 is older + simpler (single-row 4-slot
device), III is newer + more general (multi-row grid + scenes + FC).
The newer codebase consolidated wire commands; the older one kept
each operation discrete.

## Implications for the unified MCP surface

The unified `set_bypass(port, block)` tool needs to dispatch
differently per device:

```ts
async function set_bypass(port: Device, block: BlockRef, bypassed: bool) {
  if (port === 'am4') {
    // Direct fn=0x20 wire emit
    await emit_sysex(am4_model_byte, 0x20, [block.slot, bypassed ? 1 : 0]);
  } else if (port === 'axe-fx-iii') {
    // Generic SET_PARAMETER write
    await emit_set_parameter(III_model, block.blockId, BYPASS_PARAM_ID, bypassed ? 1 : 0);
  }
}
```

The unified surface absorbs the per-device wire divergence. The
agent sees one operation name; the dispatcher knows the wire shape.

## Operations only one device has

**AM4-only:**
- `Download` workflow (fn=0x24, 0x25): firmware update
- `Channel Copy to All` (fn=0x2C), `Copy Channel To Another` (fn=0x2D),
  `Swap Channels` (fn=0x2E): all 4 AM4 channels can be manipulated
- `Bypass Block` as a discrete host-emit op (fn=0x20)

**III-only:**
- `Block Connect` (fn=0x33): grid routing matrix (AM4 has no grid)
- `Set Preset Name` as discrete op (fn=0x14): AM4 embeds name in PRESET_DUMP
- `Set Tempo` as discrete op (fn=0x23): AM4 has no per-preset tempo
- `Channel Copy` (fn=0x37, sub-workflow): III X/Y channels (vs AM4's A/B/C/D)
- FC controller workflows (Clear Switch, Paste Switch, Swap Switch):   AM4 has no FC controller surface
- File operations: `File Snapshot`, `File Export to Sysex`,
  `Import/Export Preset Bundle`, III's library management richer

## Source

- `samples/captured/decoded/ghidra-am4-edit-workflow-catalog.txt`
- `samples/captured/decoded/ghidra-am4-edit-host-emitter-map.txt`
- `samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt`
- `samples/captured/decoded/ghidra-axe-edit-iii-host-emitter-map.txt`
- `samples/captured/decoded/ghidra-am4-edit-sysex-builders.txt`
- `scripts/ghidra/FindAM4EditWorkflowCatalog.java`
- `scripts/ghidra/FindAM4SysExBuilder.java`
- `scripts/ghidra/MapAM4EditHostEmitters.java`
- `scripts/ghidra/FindAxeEditIIIInboundDispatcher.java`
- `scripts/ghidra/MapAxeEditIIIHostEmitters.java`
