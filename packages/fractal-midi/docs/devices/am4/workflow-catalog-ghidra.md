# AM4, Workflow + fn-byte catalog (Ghidra-recovered Rosetta Stone)

**Status:** Closure-grade. `FUN_1402d83d0` in AM4-Edit.exe is the
state-machine initializer that registers named workflows + their
inbound fn-byte subscriptions. **Same architecture as Axe-Fx III's
`FUN_1401f0f10`**: shared Fractal codebase ancestry, but **different
fn-byte assignments per workflow**.

This adds AM4's authoritative operation surface to the catalog.

## Architecture parallel to III

Both binaries use:
- A state-machine initializer that calls a label-string registrator
  (`FUN_140060fb0` on AM4 = `FUN_14005faa0` on III)
- + a subscription registrar (`FUN_140196500` on AM4 = `FUN_1401bac70`
  on III)
- Workflow names are string literals (NOT enum constants)
- Each workflow subscribes to a small set of response fn-bytes
- Workflows have state IDs (e.g., 3,4 for "Query device version")

## Recovered AM4 workflows (42 named)

| # | Workflow name | Subscribed inbound fn-bytes |
|---|---|---|
| 1 | Query device version | `0x04, 0x05, 0x06, 0x07, 0x31` |
| 2 | Initialization | `0x1A, 0x0C, 0x0D` |
| 3 | Query device name | `0x08` |
| 4 | Library Load | `0x09, 0x19, 0x0B, 0x32` |
| 5 | Query All Param Definitions | `0x0A` |
| 6 | Query Param Definition | `0x0B` |
| 7 | Refresh Preset Names | `0x19` |
| 8 | Refresh Cabinet Names | `0x0E, 0x12` |
| 9 | Change Preset | `0x0F` |
| 10 | Revert Preset | `0x10` |
| 11 | Clear Preset | `0x11` |
| 12 | Save Preset | `0x17` |
| 13 | File Snapshot | `0x17` |
| 14 | File Export to Sysex | `0x17` |
| 15 | Get Preset Data | `0x17` |
| 16 | File Export to Templates | `0x23, 0x25` |
| 17 | Paste Preset | `0x15` |
| 18 | Change Scene | `0x16` |
| 19 | Set Scene Name | `0x13` |
| 20 | Copy Scene | `0x14` |
| 21 | Swap Scenes | `0x27` |
| 22 | Block Copy | `0x28` |
| 23 | Block Paste | `0x29` |
| 24 | Block Move | `0x26` |
| 25 | Library Query (×2) | `0x26` |
| 26 | Channel Copy | `0x2A` |
| 27 | Channel Paste | `0x2B` |
| 28 | Channel Copy to All | `0x2C` |
| 29 | Copy Channel To Another | `0x2D` |
| 30 | Swap Channels | `0x2E` |
| 31 | Download (firmware update?) | `0x24, 0x25` |
| 32 | Listing preset and scene names | `0x18` |
| 33 | Set Channel | `0x1D` |
| 34 | Set Channel in all scenes | `0x1E` |
| 35 | Bypass Block | `0x20` |
| 36 | Set bypass in all scenes | `0x21` |
| 37 | Bypass all blocks in current scene | `0x22` |
| 38 | Import User Cab | `0x1B, 0x25` |
| 39 | Export User Cab | `0x1C` |
| 40 | Set Channel in all scenes (alt path) | `0x1F` |
| 41 | Listing preset and scene names (alt) | `0x2F` |
| 42 | Batch set a block's parameter | `0x30` |

## AM4 vs III, fn-byte divergence per shared workflow

The same operation has DIFFERENT wire bytes between AM4 and III:

| Shared workflow | AM4 fn | III fn |
|---|---:|---:|
| Query device version | `0x31` | `0x46` |
| Refresh Preset Names | `0x19` | `0x0C` |
| Refresh Cabinet Names | `0x0E, 0x12` | `0x0D` |
| Change Preset | `0x0F` | `0x11` |
| Revert Preset | `0x10` | `0x12` |
| Clear Preset | `0x11` | `0x13` |
| Save Preset | `0x17` | `0x10` |
| Set Preset Name | _(not in AM4)_ | `0x14` |
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
| Channel Paste | `0x2B` | _(in III's "Channel Paste" sub-workflow)_ |
| File Export to Sysex | `0x17` | `0x19` |
| Get Preset Data | `0x17` | `0x19` |
| Import User Cab | `0x1B, 0x25` | `0x20, 0x22` |
| Export User Cab | `0x1C` | `0x1A` |
| Library Query | `0x26` | `0x34` |

### Implications

1. **The v1.4 PDF's fn-byte names that supposedly cover both AM4
   and Axe-Fx III are wrong for at least one of them.** Each device
   has its own fn-byte assignments, there's no single Fractal-wide
   wire convention beyond the envelope shape.

2. **AM4 has no "Block Connect" workflow** (III's fn=0x33 routing
   wire byte). Consistent with AM4 being a single-row 4-slot device
   that doesn't have a routing matrix.

3. **AM4 has no "Set Preset Name" workflow** as a discrete operation.
   AM4 likely encodes the preset name only in the PRESET_DUMP payload
   (consistent with prior decode work), with no separate "set name"
   wire envelope.

4. **AM4 has a "Download" workflow** (firmware update) with fn-bytes
   `0x24, 0x25`. III's workflow catalog has these bytes used by other
   workflows ("Delete Block" 0x24, 0x25): so 0x24-0x25 mean different
   things on each device.

5. **AM4 "Save Preset" fn=0x17** is the inverse of III's fn=0x10. The
   v1.4 PDF lists 0x17 as `SET_TUNER_ENABLE` for III, that's the
   wrong name. AM4's PRESET_DUMP_HEADER 0x77 is shared, but the
   "save" workflow ack/confirm byte differs.

## Cross-device ops the agent can now design

The same Ghidra cross-application means **`unified_save_preset(port)`,
`unified_change_scene(port)`, `unified_set_channel(port)` etc. can
dispatch by device with confidence about which fn-byte to use per
device.** Eliminates guesswork in the unified surface.

## What is NOT in AM4's workflow catalog

Operations AM4 doesn't have (vs III):
- Block Connect (routing matrix): AM4 is single-row
- Set Preset Name as a discrete op, embedded in PRESET_DUMP
- Set Tempo as a discrete op, likely embedded in preset binary
- Paste / Swap Scene Layout (Layout = FC-controller config): AM4
  has no FC controller surface

Operations AM4 has that III doesn't:
- "Download" firmware update workflow as a dedicated state machine
- "Library Query" appears twice in AM4 (two variants, possibly
  preset library vs cab library)

## Source

- `samples/captured/decoded/ghidra-am4-edit-workflow-catalog.txt`
  L3449-5009, `FUN_1402d83d0` full state-machine initializer
- `scripts/ghidra/FindAM4EditWorkflowCatalog.java`

## Implications for AM4 protocol RE

The AM4 protocol surface decoded so far in `fractal-midi/docs/devices/
am4/SYSEX-MAP.md` is comprehensive for the operations the agent
currently uses (set_param, get_param, set_block, get_block_layout,
apply_preset, switch_preset, save_preset). The 42 workflows above
confirm we haven't missed anything major.

The "Batch set a block's parameter" workflow at fn=0x30 is
particularly interesting, it suggests a multi-param-at-once
write operation that could speed up `apply_preset` materially.
Hardware capture of AM4-Edit doing a "Set all amp params" UI
action would reveal the batch-write envelope.
