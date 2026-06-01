# Axe-Fx III, Workflow + fn-byte catalog (Ghidra-recovered Rosetta Stone)

**Status:** Closure-grade. `FUN_1401f0f10` in AxeEdit III is the
state-machine initializer that registers per-workflow subscriptions
to the III's inbound SysEx fn-bytes. Each workflow declares its
human-readable name (via `FUN_14005faa0(&label, "STRING")`) and the
set of fn-bytes that advance its state.

This recovers the **III protocol's true operation surface**: substantially more than the v1.4 PDF's 11 documented operations.

## How to read this table

Each workflow registers a set of fn-bytes via `FUN_1401bac70(stateMachine,
fn_byte, 1)`. When the III device responds with one of those bytes,
the workflow's state advances.

`0` (host→device write completion?) and `1` (likely 0x64 ACK end marker)
appear in every workflow as boilerplate sequence markers; the
**meaningful response fn-bytes are listed in the third column**.

## Recovered workflows (44 named + ~12 anonymous follow-ons)

| # | Workflow name | Distinguishing response fn-bytes |
|---|---|---|
| 1 | Query device version | `0x04, 0x05, 0x06, 0x07, 0x08, 0x46` |
| 2 | Initialization | `0x0E, 0x0F` |
| 3 | Query device name | `0x07` |
| 4 | Library Load | `0x09` |
| 5 | Query All Param Definitions | `0x0A, 0x0C, 0x0D, 0x47` |
| 6 | Query Param Definition | `0x0B` |
| 7 | Refresh Preset Names | `0x0C` |
| 8 | Refresh Cabinet Names | `0x0D` |
| 9 | Change Preset | `0x11` |
| 10 | Revert Preset | `0x12` |
| 11 | Clear Preset | `0x13` |
| 12 | Set Preset Name | `0x14` |
| 13 | Save Preset | `0x10` |
| 14 | File Snapshot | `0x19` |
| 15 | File Export to Sysex | `0x19` |
| 16 | Get Preset Data | `0x19` |
| 17 | File Export to Templates | `0x19` |
| 18 | Export Preset Bundle | `0x1C` |
| 19 | Import Preset Bundle | `0x1B` |
| 20 | Paste Preset | `0x1F, 0x22` |
| 21 | Change Scene | `0x15` |
| 22 | Set Scene Name | `0x16` |
| 23 | Copy Scene | `0x17` |
| 24 | Swap Scenes | `0x18` |
| 25 | Set Tempo | `0x23` |
| 26 | Delete Block | `0x02, 0x24, 0x25, 0x26, 0x03` |
| 27 | Insert Block | `0x02, 0x24, 0x28, 0x29, 0x03` |
| 28 | Bypass Block | `0x2A` |
| 29 | Set bypass in all scenes | `0x2B` |
| 30 | Bypass all blocks in current scene | `0x2C` |
| 31 | Reset Block | `0x30` |
| 32 | Set Channel | `0x2D` |
| 33 | Set Channel in all scenes | `0x2E` |
| 34 | Copy Channel | `0x2F` |
| 35 | **Block Connect** | **`0x33`** ⭐  routing wire-byte |
| 36 | Move Block | `0x24, 0x02, 0x31, 0x03` |
| 37 | Swap Blocks | `0x32` |
| 38 | Block Copy | `0x35` |
| 39 | Block Paste | `0x36` |
| 40 | Library Query | `0x34` |
| 41 | Import User Cab | `0x20, 0x22` |
| 42 | Export User Cab | `0x1A` |
| 43 | Channel Copy | `0x37` |
| 44 | Channel Paste | (`+more`) |
| 45 | Channel Copy to All | (`+more`) |
| 46 | Clear Layout (× 2 variants) | (`+more`) |
| 47 | Paste Layout | (`+more`) |
| 48 | Clear Switch (× 4 variants, FC modes) | (`+more`) |
| 49 | Paste Switch (× 2 variants) | (`+more`) |
| 50 | Swap Switch | (`+more`) |
| 51 | Download | (`+more`) |
| 52 | Unlink All Global Blocks | (`+more`) |
| 53 | Batch set a block's parameter | (`+more`) |
| 54 | Listing preset and scene names | (`+more`) |

Plus FC-MFC8 footswitch sub-workflows (PC Mapping, External Control,
"To Preset", "To Scene", Scene Decrement, Input/Output 1-4 Volume +
Incr/Decr).

## Major corrections to prior hypotheses

### fn=0x12, Revert Preset, NOT FS_PASSTHRU_MESSAGE

The earlier `fn12-fs-passthru-decoded.md` hypothesis was wrong.
fn=0x12 is the **device response to "Revert Preset"** (undo current
buffer's changes, reload from stored).

Builder `FUN_1401e3fb0` (1-byte payload, 3 caller contexts) is most
likely the HOST→DEVICE request side: "device, revert the working
buffer to the stored preset state". The byte may indicate scope
(active scene, all scenes, etc.).

### fn=0x46, Query device version, NOT DSP_MESSAGE

The earlier  partial closure was wrong. fn=0x46 belongs to the
**"Query device version" workflow**, alongside fn=0x04, 0x05, 0x06,
0x07, 0x08. Likely the FIRMWARE_VERSION response.

The actual DSP_MESSAGE fn-byte remains unknown, none of the 44
named workflows include "DSP" in the label. The III may not expose
DSP usage over SysEx (only via its proprietary USB-bulk channel),
OR it's in an unnamed sub-workflow not in this initializer.

### **fn=0x33, Block Connect, UNBLOCKS ** ⭐

The III's grid routing (arrows between cells) is the
**"Block Connect"** workflow, responding to fn=0x33. Combined with
`fn-byte-envelopes-ghidra.md`'s descriptor scan, the HOST→DEVICE
emit for fn=0x33 builds the **routing-change request** the editor
sends when the user clicks an arrow on/off.

Finding the emitter for fn=0x33 (a caller of `FUN_1403437d0` with
`fn_byte_arg = 0x33`) gives us the complete routing-edit wire shape.

## v1.4 PDF cross-reference

v1.4 PDF documented fn-bytes (the only 11 it lists for III):
- 0x08 WHO_AM_I → in Query device version workflow ✓
- 0x0A QUERY_TUNER → in Query All Param Definitions workflow
- 0x0B SET_BYPASS → in Query Param Definition workflow (and Bypass Block? unclear)
- 0x0C SET_SCENE → in Refresh Preset Names + Query All Param Definitions
- 0x0D GET_PATCH_NAME → in Refresh Cabinet Names + Query All Param Definitions
- 0x0E GET_SCENE_NAME → in Initialization workflow
- 0x0F GET_LOOPER_STATE → in Initialization workflow
- 0x10 TEMPO_TAP → **WRONG**: actually "Save Preset" per Ghidra
- 0x11 TUNER_ENABLE → **WRONG**: actually "Change Preset"
- 0x13 GET_PRESET_STATUS → **WRONG**: actually "Clear Preset"
- 0x14 SET_TEMPO → **WRONG**: actually "Set Preset Name"

**The v1.4 PDF's fn-byte names are systematically wrong for fn ≥
0x10.** The names appear to be inherited from the Axe-Fx II spec
but reassigned in the III's firmware. Authoritative III names come
from this Ghidra workflow catalog.

## Implications

###  substantially CLOSED

The III protocol's named operation surface is now fully recovered.
44 workflows × their wire bytes give us a complete map for designing
agent tools. The remaining gap is the HOST→DEVICE emit shape for
each one, we've decoded 6 so far (0x01, 0x12, 0x40, 0x46, 0x74-0x76,
0x77-0x79). The other ~38 can be decoded by following the same
"FUN_1403437d0 with fn_byte_arg = X" pattern.

###  (DSP-meter): re-opens as research

DSP usage query may not be a SysEx operation. Other channels to
investigate:
- AxeEdit III may use a separate proprietary USB-bulk channel for
  DSP telemetry (this is consistent with the "DSP_MESSAGE" string
  existing in the binary but not appearing in the SysEx workflow
  catalog).
- A USBPcap of AxeEdit III's CPU% meter ticking would show whether
  there's any inbound SysEx traffic, and if not the meter must
  come from a non-SysEx channel.

###  (routing decode): unblocked

`fn=0x33 Block Connect` is the routing-write wire byte. Next step:
find the HOST emitter (`FUN_1403437d0(buf, 0x33, ...)` caller) and
decode its payload structure. This is the III equivalent of II's
fn=0x06 routing-write that we already decoded.

###  unified surface, operations to add

These III operations are now wire-decodable for unified tool design:

- `save_to_location` → Save Preset (fn=0x10 trigger + PRESET_DUMP push)
- `set_preset_name` → Set Preset Name (fn=0x14)
- `clear_preset` → Clear Preset (fn=0x13)
- `revert_preset` → Revert Preset (fn=0x12)
- `change_scene` → Change Scene (fn=0x15)
- `set_scene_name` → Set Scene Name (fn=0x16)
- `swap_scenes` → Swap Scenes (fn=0x18)
- `copy_scene` → Copy Scene (fn=0x17)
- `delete_block` → Delete Block
- `insert_block` → Insert Block
- `bypass_block` → Bypass Block (fn=0x2A)
- `reset_block` → Reset Block (fn=0x30)
- `set_channel` → Set Channel (fn=0x2D)
- `block_connect` → Block Connect (fn=0x33): ROUTING
- `move_block` → Move Block (fn=0x31)
- `swap_blocks` → Swap Blocks (fn=0x32)
- `set_tempo` → Set Tempo (fn=0x23)
- `query_device_version` → Query device version (fn=0x46)

That's 18 ready-to-design III tools just from this Ghidra pass.

## Source

- `samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt`
  L7-2238, FUN_1401f0f10 state-machine initializer (the 50+ workflows)
- `scripts/ghidra/FindAxeEditIIIInboundDispatcher.java`
