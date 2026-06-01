---
name: block-record-stride-8
class: struct-layout
status: matched-singleton
discovered: 
verified_on:
  - axe-fx-ii-q8.02
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-block-record-stride-8
relates_to: [scene-state-ushort, alphabetical-name-cascade-block-ordering, vendor-envelope-descriptor-table, wire-id-pairs-per-placed-block]
consumed_in:
  - packages/axe-fx-ii/src/sceneChannelMap.ts
---

# Block-record table stride-8 (II)

Axe-Fx II preset binary carries a block-record table at chunk 0,
starting at ushort offset 36, with stride 8 ushorts per record.

## Formal definition

The table at `chunk[0][36..]` is an array of block records, each 8
ushorts wide:

```
record[i] = chunk[0][36 + 8*i : 36 + 8*(i+1)]
```

Per the Ghidra cross-reference, **only the first 2
ushorts of each record are populated**:

- `ushort[0]` — block_id (matches the wire-id from
  [[wire-id-pairs-per-placed-block]])
- `ushort[1]` — flag ushort. Bit 1 (`0x0002`) = "active in standard
  scene" (-DECODE-NOTES.md lines 399-410). Other bits' semantics
  not yet decoded but observed values cluster around 0x0002, 0x0003.
- `ushort[2..7]` — zero, reserved by firmware (writeback must preserve
  zeros)

Termination: end-of-list marker (block_id = 0xFFFF or similar; verify
in goldens).

## Where it's used

II preset binary parser uses this table to enumerate which blocks are
PLACED in the current preset. Scene-state ushort offsets per block
([[scene-state-ushort]]) are looked up via this table.

## Misapplication failure modes

- **DO NOT** assume the unused ushorts (positions 2..7) carry paramBase
  or any layout information. They DO NOT. paramBase is computed
  dynamically by firmware from the cascade order +
  per-block-name widths — see [[paramBase-plus-paramId]] and
  [[alphabetical-name-cascade-block-ordering]].
- **DO NOT** treat the table as fixed-position (always at chunk 0
  ushort 36). The OFFSET is stable in the II envelope family, but a
  new firmware revision could shift it; verify against the envelope
  descriptor table ([[vendor-envelope-descriptor-table]]) for the
  current firmware.

## Where it does NOT apply

- AM4 (no analog; 4 fixed slots, no record table needed)
- Axe-Fx III — transfer candidate (would need probe of III preset
  binary structure)

## Verification path

`scripts/cookbook-verify.ts#case-block-record-stride-8` parses a known
preset capture, asserts:
- Records start at chunk 0 ushort 36
- Each record is 8 ushorts (stride verified)
- Only positions 0-1 are non-zero
- Block-id sequence matches expected placed blocks

## Refinement history

- : table structure decoded. 21 blocks total mappable per
  the table.
-  cont: Ghidra cross-reference confirmed ushort[2..7] are
  always zero (firmware doesn't write them); paramBase dynamic-
  computation hypothesis confirmed.
