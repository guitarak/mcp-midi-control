---
name: am4-preset-dump-flat-byte-diff
class: decode-plan
status: non-matching
verified_on:
  - am4
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-am4-preset-dump-flat-byte-diff
relates_to: [ii-preset-binary-flat-byte-diff, am4-fn1f-atomic-read, vendor-envelope-descriptor-table]
consumed_in: []
---

# Flat-byte-offset diff of the AM4 `0x77/0x78/0x79` preset binary: does NOT work

A natural decode plan for the AM4 preset-dump body is: capture two
dumps with exactly one variable changed (a block-type swap, a per-channel
gain edit), diff the binaries byte-for-byte, and read the changed field's
offset from the diff positions. It does not work on AM4, for a reason
distinct from the II case ([[ii-preset-binary-flat-byte-diff]], where the
body is Huffman-compressed): the AM4 dump encoder is **non-deterministic
between identical inputs**.

## Why it fails

**The encoder reshuffles the body on every export, even with no edit.**
A no-mutation redump pair (`am4-warm-pair-1-baseline-redump-before.syx`
vs `-after.syx`, captured back to back in one warm session) differs by
**2541 of 12352 bytes** (about 20 percent), spread across all four
`fn 0x78` chunks. A one-variable amp-type swap
(`am4-warm-pair-5-amp-type-swap-{before,after}.syx`) differs by 2909
bytes: the swap contributes only roughly 370 diffs on top of the 2541
no-op baseline noise, so the signal is swamped. With a ~20 percent noise
floor, no stable byte holding a changed field's value can be localized
from these pairs. The cleartext block-layout table (chunk-1 payload
`0x0E..0x40`) does NOT change on a confirmed amp-type swap and does not
hold block-type codes as record byte 0, so the dump does not expose
block-type identity in a flat-diffable position either. See
`am4-warm-pair-diff.json` (per-chunk `byte_diffs` / `septet_diffs`) and
`docs/devices/am4/preset-binary-format-research.md` Section 10.10.

Note the contrast with Axe-Fx II: the II `0x77/0x78/0x79` dump IS
deterministic between identical inputs (a channel-toggle redump of
`Drive_1` / `Compressor_1` shows zero byte diffs), so the II failure mode
is Huffman instability, not encoder non-determinism. The AM4 and II dumps
share an envelope shape but not a stability property; do not assume one
device's diffability from the other.

## What works instead

- **AM4 `fn 0x01 action=0x1F` name-table snapshot** for preset name, the
  four scene names, the active scene index (`0x08`), and the four
  per-slot block-type codes (`0xB0`, `BLOCK_TYPE_VALUES` pidLows). This
  is a structured, stable, deterministic reply. See
  `docs/devices/am4/SYSEX-MAP.md` "Read response for action = 0x1F".
- **[[am4-fn1f-atomic-read]]** (`fn 0x1F` per-block atomic read) for
  per-block parameter state, single round-trip per block.
- The **parser-side AM4-Edit Ghidra arc** recovers byte-positional
  knowledge of the dump body without any capture.

## What this does NOT rule out

- A **same-warm-window single-block capture**: a Z04 scratch preset
  holding exactly one block in slot 1, dumped, then one `set_block_type`
  swap, dumped again in the same session. With one block present the
  model-default-parameter churn is far smaller, so a stable block-type
  byte (if one exists in the dump) could be localized against the layout
  table. The existing corpus only has multi-block (`AM4 Gig Rig`) pairs,
  whose swapped-amp model-default churn swamps the layout-table signal.
- Diffing other AM4 envelopes whose bodies are stable by construction
  (`fn 0x01` single-param messages, the `action=0x1F` snapshot above).

## Refinement history

- 2026-05-29: negative finding registered. AM4 dump non-determinism
  reproduced directly (2541/12352 bytes differ on a no-op redump),
  confirming the block-type codes cannot be cross-corroborated from the
  dump primitive and the `0xB0` footer block-type map (in the
  `action=0x1F` snapshot) stays single-primitive. Cross-device note: the
  II dump is deterministic, so this non-determinism is AM4-specific.
