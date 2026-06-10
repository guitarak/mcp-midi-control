---
name: gen3-fn01-set-float32-ordinal
class: protocol-exchange
status: matched-singleton
discovered: 2026-06-04 (capture3 re-decode); corrected 2026-06-08 (FM3 write capture + re-verify)
verified_on:
  - fm9-fw-11.00
  - fm3-fw-12.00
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-gen3-fn01-set-float32-ordinal
relates_to: [gen3-enum-label-septet-stream, iii-fn01-set-parameter-envelope, iii-byte-stream-septet-pack-8to7]
consumed_in: []
---

# gen-3 fn=0x01 SET value = 5-septet LE float32 @ pos 12

A gen-3 parameter SET (`F0 00 01 74 [model] 01 [sub:2] [eff:14b LE] [pid:14b LE]
...`) carries its value as an **IEEE-754 float32, little-endian, packed as five
7-bit septets at payload bytes 12..16**, followed by four `0x00` bytes and the
XOR-7F checksum (23-byte frame). Two sub-actions:

- **discrete** (type/model selectors), sub `09 00`: value = `float32(read-ordinal)`.
  The ordinal is exactly the index the read leg (fn=0x1f / broadcast) and the
  shipped enum rosters decode with — so **set-by-name resolves straight off the
  read roster; there is no separate write-id space.**
- **continuous** (knobs), sub `52 00`: value = `float32(normalized 0..1)` =
  `wire16 / 65534`.

```
SET  F0 00 01 74 [model] 01 [sub] 00 [eff:14b LE] [pid:14b LE] [s0 s1 s2 s3 s4] 00 00 00 00 [cs] F7
     value u32 = s0 | s1<<7 | s2<<14 | s3<<21 | s4<<28 ; reinterpret as float32
```

## RETRACTION — the "raw-id permutation" model was a misread

A prior version of this entry claimed the OUT SET carried a permuted "raw enum
id" (reverb 524/529, drive 523) at bytes 15-16 read as a packValue16, distinct
from the read ordinal. **That was wrong.** Bytes 15-16 are the high two septets
of the float32, and reading them alone as a 14-bit int is a lossy MISREAD:
ordinals 16/17/18/19 all collapse to "524". `prove.py` (Drew, 2026-06-08)
reproduces every "raw-id" from `float32(ordinal)`:

| name | true ordinal | float32 | old pos-15 misread |
|---|---|---|---|
| Medium Spring (reverb) | 16 | 16.0 | 524 |
| Music Hall (reverb) | 45 | 45.0 | 529 |
| Blues OD (drive) | 15 | 15.0 | 523 |
| Shiver Clean (amp, FM3) | 31 | 31.0 | 527 |
| Recording Studio A (reverb, FM3) | 38 | 38.0 | 528 |

## Evidence

- FM9 fw 11.00 (capture3): reverb SET-echo OUT frame
  `...01 09 00 42 00 0a 00 00 00 00 0c 04 00 00 00 00 5f f7` → float32@pos12 =
  **16.0** (Medium Spring); the 60-byte IN echo carries the name septet-packed
  from byte 5 ([[gen3-enum-label-septet-stream]]) and the normalized ordinal
  16/78.
- FM3 fw 12.00 (Drew lldb write capture): amp model SELECT → float32 **31.0**
  (Shiver Clean, file-id 31); reverb type SELECT → float32 **38.0** (Recording
  Studio A). Both checksums valid.
- The shipped rosters (TYPE_BINARY_IDS / GEN3_READ_ROSTERS) ARE the set-by-name
  map; amp ordinal 31 = "Shiver Clean", 179 = "Texas Star Clean" resolve directly.

## Where this does NOT apply

- 47 amp ordinals are unnamed in the factory-correlated roster (need the
  FM3-Edit `effectDefinitions` cache); a name not in the roster is rejected, not
  mis-set. The 47 are settable by numeric ordinal.
- Device ACCEPTANCE of a server-issued SET is still hardware-untested (the
  captures are the editor driving the device); a non-power-of-2 ordinal SET
  (e.g. Music Hall = 45) is the decisive confirmation.

## Refinement history

- 2026-06-04: discovered as `partial-N1`, framed as a {raw-id → name} write leg.
- 2026-06-08: model corrected to `float32(read-ordinal) @ pos 12`; the raw-id /
  permutation framing retracted (pos-15 packValue16 misread). Renamed from
  `gen3-enum-setecho-rawid-name`. Promoted to `matched-singleton` (FM3 + FM9).
