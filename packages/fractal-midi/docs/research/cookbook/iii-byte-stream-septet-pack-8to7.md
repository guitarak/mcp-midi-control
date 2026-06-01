---
name: iii-byte-stream-septet-pack-8to7
class: bit-level
status: matched-singleton
discovered: 2026-05-22 (cookbook mine of ghidra-axe-edit-iii-store-preset.txt)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-iii-byte-stream-septet-pack-8to7
relates_to: [septet-14bit, septet-21bit-byte2-mask-preservation, iii-fn01-set-parameter-envelope]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt (FUN_14033f2d0; L1278-1317)
---

# 8-to-7-bit byte-stream septet packer (III)

Pack an arbitrary N-byte raw input buffer into `ceil(N * 8 / 7)`
SysEx-safe bytes (every output byte has bit 7 clear) by walking input
bytes and emitting 7-bit output chunks with a carry. This is the
standard MIDI 8-of-7 packing scheme used wherever a Fractal envelope
needs to embed a variable-length raw payload that doesn't carve
cleanly into fixed 14- or 21-bit fields.

## Formal definition

```
pack(input, N):
  output = byte array of size ceil(N * 8 / 7)
  inIdx = 0
  outIdx = 0
  bitsConsumed = 1
  carry = 0
  while inIdx < N:
    if bitsConsumed == 8:
      output[outIdx++] = carry & 0x7F
      bitsConsumed = 1
      carry = 0
    else:
      b = input[inIdx]
      output[outIdx++] = ((b >> bitsConsumed) | carry) & 0x7F
      carry = (b & ((1 << bitsConsumed) - 1)) << (7 - bitsConsumed)
      bitsConsumed += 1
      inIdx += 1
  output[outIdx] = carry & 0x7F
  return output
```

Every output byte has bit 7 clear (SysEx-safe). Output size:

- N=1 → 2 bytes
- N=7 → 8 bytes
- N=8 → 10 bytes (one carry-flush iteration between input 7 and 8)
- N=14 → 16 bytes
- general → `ceil(N * 8 / 7)`

The pattern: every 8th loop iteration (when `bitsConsumed` reaches 8)
flushes the accumulated carry as its own output byte and consumes no
input. After the input is exhausted, one final byte writes whatever
remains in `carry`. Together this gives the expanded byte-count.

## Where it's used

The packer is invoked from `FUN_14033ec70`, the AxeEdit III canonical
fn=0x01 builder (see [[iii-fn01-set-parameter-envelope]]). Specifically
at the call site L1525 (per
`fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`):

```c
if (param_3[5] != 0) {
  FUN_14033f2d0(param_3 + 6, param_3[5], pbVar3 + 0xf);
}
```

`param_3[5]` is the tail-item count; `param_3 + 6` is the raw tail
buffer (one ushort per item, packed elsewhere); `pbVar3 + 0xf` is the
write target inside the 15-byte fn=0x01 header. This is what writes
the long-broadcast (`sub-action 01 00`, 64-item tail) and any future
fn=0x01 variant with a non-empty tail.

## Applicability

Apply this primitive wherever a Fractal envelope must embed N raw
bytes (or N ushorts treated as 2-byte chunks) of unstructured payload
into a SysEx body. It is the general case that
[[septet-14bit]] (fixed 2-byte width) and
[[septet-21bit-byte2-mask-preservation]] (fixed 3-byte width with a
reserved-mask invariant) specialize. The byte-stream form keeps
running bits across the entire buffer rather than re-anchoring on a
fixed field boundary.

The 7-of-8 expansion ratio is universal across MIDI vendors; this
entry's narrower claim is that Fractal's specific `FUN_14033f2d0`
implementation uses the LSB-first-with-carry variant documented above
(distinct from MSB-first variants seen in some other vendor codecs).

## Misapplication failure modes

- **DO NOT** use this for fixed-width fields. [[septet-14bit]]
  encodes a single 14-bit value as exactly 2 bytes regardless of bit
  pattern; the byte-stream packer would emit 2 bytes for a 1-byte
  input or 3 bytes for a 2-byte input. Use the fixed-width primitive
  when the field is a number with known bit count.
- **DO NOT** confuse the "carry flush every 7 input bytes" with a
  framing marker. The flush byte is part of the contiguous packed
  output; consumers MUST track `bitsConsumed` to know when to read it
  as a flush vs. as the high bits of the next packed input.
- **DO NOT** assume output[0] is always SET to the high bits of
  input[0]. With `bitsConsumed=1` on the first iteration, output[0]
  carries the high 7 bits of input[0] (i.e. `input[0] >> 1`), losing
  the low bit into `carry` for output[1]. Decoders must walk the
  packing state explicitly.

## Where it does NOT apply

- Axe-Fx II — no direct evidence yet that II's AxeEdit ships the
  identical `FUN_14033f2d0` shape. Transfer candidate: scan II's
  Ghidra dump for the same loop pattern (`if bitsConsumed == 8` flush
  + carry shift) and confirm. Until then, treat II as unknown for
  this primitive.
- AM4 — same. AM4-Edit's set-param path uses
  [[am4-pidlow-register-families]] addressing with fixed-width
  septet fields per [[septet-14bit]]; no byte-stream payload is
  exercised in the AM4 fn=0x01 wire shape.
- Hydrasynth — NRPN-based, no Fractal envelope; not applicable.

## Verification path

`scripts/cookbook-verify.ts#case-iii-byte-stream-septet-pack-8to7`
runs the pack algorithm against a small set of fixtures (N=1, 2, 7,
8, 14) and verifies:

1. Every output byte is 7-bit-clean (bit 7 == 0).
2. Output size matches `ceil(N * 8 / 7)`.
3. Byte-exact output matches the algorithm's formal definition for
   the hand-traced cases (e.g. `input=[0xFF]` → `output=[0x7F, 0x40]`).

Decompile reference: `FUN_14033f2d0` at envelope positions L1278-1317
of `fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`.

## Path to `matched`

Promotion from `matched-singleton` to `matched` requires a second
axis point. The cheapest paths:

- Scan AxeEdit II's Ghidra dump for the identical
  `if bitsConsumed == 8 / carry shift / 7-bit output mask` loop
  pattern. If present, AxeEdit II becomes the second axis.
- Cross-check AM4-Edit similarly. AM4's set-param path does not
  exercise a tail payload in production, but the function may exist
  in the binary as dead code for the long-broadcast variant.
- Cross-check against the III firmware itself (not just the editor)
  if a III firmware-binary dump becomes available.

Hardware verification is NOT required for promotion; this is a pure
encoding primitive verifiable from binaries alone.

## Refinement history

- 2026-05-22 (cookbook-mine of `ghidra-axe-edit-iii-store-preset.txt`,
  agent ba0vy28cl follow-up): primitive discovered as
  `FUN_14033f2d0` at L1278-1317. The cookbook entry +
  `scripts/cookbook-verify.ts` golden case shipped same-session per
  the cookbook same-session discipline.
