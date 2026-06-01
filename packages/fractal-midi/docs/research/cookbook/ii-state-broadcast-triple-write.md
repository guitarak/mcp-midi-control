---
name: ii-state-broadcast-triple-write
class: envelope-shape
status: matched-singleton
devices: [II]
golden: scripts/cookbook-verify.ts#case-ii-state-broadcast-triple-write
verified_on:
  - axis: device-firmware
    point: "Axe-Fx II XL+ Q8.02"
    date: 2026-05-25
    evidence: "probe-axefx2-state-write.ts Test A: Amp 1 pos[2] round-trip byte-exact"
---

# State-Broadcast Triple Write (fn 0x74/0x75/0x76, Host → Device)

The device accepts a synthesized 0x74/0x75/0x76 triple as a WRITE operation.
Same envelope shape as the device-emitted state-broadcast (device → host) and
the fn=0x1F response. Bidirectional.

## Wire shape

```
HEADER  F0 00 01 74 [model] 74 [targetId:14b] [itemCount:14b] [opFlag] [cs] F7
CHUNK   F0 00 01 74 [model] 75 [chunkCount:14b] [N × packValue16] [cs] F7
FOOTER  F0 00 01 74 [model] 76 [cs] F7
```

- `targetId`: effectId from BLOCK_BY_ID (e.g. 106=Amp 1, 108=Drive 1)
- `itemCount`: total values across all chunks (must match block's full position count)
- `opFlag`: 0x01 (block edit) or 0x00 (preset-structure). Both accepted for writes.
- `packValue16`: 3-byte septet pack of a 16-bit value `[v&0x7F, (v>>7)&0x7F, (v>>14)&0x03]`
- Chunks hold max 64 items each; overflow spills to additional 0x75 frames.

## Constraints

1. **Full array required.** itemCount MUST equal the block's total position count
   (e.g. 236 for Amp, 78 for Drive). Partial writes (itemCount < total) are ignored.
2. **NOT channel-aware.** The triple writes to the block's monolithic state array
   regardless of which channel fn=0x11 last selected. Channel X and Y share
   most positions; writing one affects both channels' reads at shared positions.
3. **Encoding is per-position.** Some positions use wire16 (0..65534 for display
   0..10), others use display-integer scale (0..10 directly), others are enums
   or read-only. The fn=0x1F response reveals each position's native encoding.

## Applicability

Axe-Fx II XL+ Q8.02. No second axis exists (only one firmware tested). The
underlying envelope shape (0x74/0x75/0x76) is shared with the device-emitted
broadcast, which is firmware-universal, but the HOST-TO-DEVICE write acceptance
is confirmed on Q8.02 only.

## Fixtures

- `probe-axefx2-state-write.ts` Test A: Amp 1, 236 values, opFlag=0x01,
  pos[2] modified from 32767 to 49152. Readback confirmed byte-exact.
- `probe-axefx2-state-write-multiblock.ts`: 21-block sweep, 15 wire16 + 6
  display-int, all pass when values match native encoding.
- `probe-axefx2-state-write-display-scale.ts`: 6/6 "failing" blocks pass
  with display-scale values. Zero drift.
- `probe-axefx2-state-write-channel-xy.ts` PART 1: writing Y at pos[1,2]
  overwrote X's values (channel isolation breach). Monolithic.

## Consumer

- Builder: `packages/fractal-midi/src/axe-fx-ii/setParam.ts:buildStateBroadcastTriple`
- Reader: `packages/axe-fx-ii/src/descriptor/reader.ts:readAllParams`

## Cross-references

- [[ii-fn1f-atomic-read]] — the READ primitive that returns this same shape
- [[septet-14bit]] — targetId and itemCount encoding
- `docs/_private/HW-125-FINDINGS-2026-05-25.md` — full session findings

## Refinement history

- 2026-05-25: Initial registration. Status `matched-singleton` (Q8.02 XL+).
  Proved bidirectional + per-position encoding + NOT channel-aware.
