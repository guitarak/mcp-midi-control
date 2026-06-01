# Axe-Fx III, fn=0x33 Block Connect (routing) wire byte

**Status:** fn-byte identified ( routing wire-byte). The
emission is DEVICE-INITIATED, AxeEdit III subscribes to fn=0x33
as a "routing changed" broadcast from the device, but does NOT
itself emit fn=0x33.

## Identification

From `FUN_1401f0f10` (state-machine initializer):

```c
*(undefined4 *)(param_1 + 0x65f8 + 0x10) = 0x35;   // state ID
*(undefined4 *)(param_1 + 0x65f8 + 0x14) = 0x36;   // state ID
FUN_1401bac70(param_1 + 0x65f8, 0, 1);            // start marker
FUN_1401bac70(param_1 + 0x65f8, 0x33, 1);         // subscribe to fn=0x33
FUN_1401bac70(param_1 + 0x65f8, 1, 1);            // end marker
FUN_14005faa0(&local_118, "Block Connect");        // workflow label
```

## Direction: device → host only

Searched the binary for any host emitter of fn=0x33 (i.e., a CALL
to either generic SysEx builder with `fn_byte_arg = 0x33`).

**Result: 0 candidates.** AxeEdit III never emits fn=0x33 itself.

This means the III's grid-routing wire byte is **a device-broadcast
notification**, not a host-emit request. The device pushes fn=0x33
to AxeEdit when:

- The user manipulates the grid via the III's front-panel buttons
- A preset load brings in a new routing matrix
- Some other internal state change updates the connections

AxeEdit III listens for fn=0x33 to keep its UI grid in sync with
the hardware state. It is NOT how the editor SAVES routing changes.

## How does AxeEdit modify routing then?

If fn=0x33 is broadcast-only, the editor must use a different wire
byte to TRIGGER routing changes. Candidates from our 27 host-emitted
fn-byte vocabulary that could carry routing-modify commands:

- **fn=0x01 SET_PARAMETER**: most likely. The III's grid is a
  collection of parameters (per-cell block-id + routing-mask), so
  routing edits may be `set_param(block_id=GRID, param_id=cell_X_Y,
  value=routing_bitmap)`. Builder `FUN_14033ec70` already supports
  arbitrary 14-bit values in Field D.
- **fn=0x77/0x78/0x79 PRESET_DUMP**: writing the whole preset
  binary (which embeds the grid). Heavy-handed but works for any
  routing change since the grid is part of the preset binary.
- **A different fn-byte we don't yet see in the host-emit list**
  (e.g., a dedicated "set grid cell" function the device exposes
  but AxeEdit doesn't use because it goes through SET_PARAMETER
  for code simplicity).

The cleanest path to confirm: USBPcap AxeEdit III while the user
clicks ONE arrow on the grid. Whichever fn-byte the host emits IS
the routing-modify primitive.

##  status update

| Item | Before this session | After this session |
|---|---|---|
| Wire byte for routing | unknown | **fn=0x33 (device broadcast)** ✓ |
| HOST request envelope | unknown | likely fn=0x01 SET_PARAMETER; needs capture |
| Cell payload structure | hypothesis | needs capture to confirm |
| III-specific dimensions (14×6) | hypothesis | needs capture |

**Half closure.** We know which byte to LISTEN for. We don't yet
know which byte to EMIT.

## Implementation pathway

For a future III `set_routing` or `block_connect` MCP tool:

1. **Read-side**: subscribe to inbound fn=0x33 frames. Each frame
   carries the updated routing state for the grid. The
   `get_block_layout` tool reads this synchronously by triggering
   the device to emit a fresh fn=0x33 (e.g., by querying the active
   preset).

2. **Write-side**: until we capture the HOST-emit equivalent, fall
   back to the heavy path:
   - Read current preset binary via 0x77/0x78/0x79 PRESET_DUMP
   - Decode the native ushort stream (see `preset-dump-decoded.md`)
   - Modify the routing bytes in-stream
   - Send the modified preset back as a PRESET_DUMP
   - Device confirms with fn=0x33 broadcast

   This is slower (~2 s round trip) but works without further
   protocol RE.

## Source

- `samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt`
  L1354, "Block Connect" label registration
- `samples/captured/decoded/ghidra-axe-edit-iii-block-connect.txt`
  L7, "0 candidates" confirmation (no host-emit of fn=0x33)
- `scripts/ghidra/FindAxeEditIIIBlockConnectEmitter.java`
