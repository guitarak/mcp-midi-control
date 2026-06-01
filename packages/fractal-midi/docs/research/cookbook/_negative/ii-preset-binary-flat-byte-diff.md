---
name: ii-preset-binary-flat-byte-diff
class: decode-plan
status: non-matching
discovered:  (21-capture plan rejection)
verified_on:
  - axe-fx-ii-xl-plus
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-ii-preset-binary-flat-byte-diff
relates_to: [ii-fn1f-atomic-read, vendor-envelope-descriptor-table]
consumed_in: []
---

# Flat-byte-offset diff of the II `0x77/0x78/0x79` preset binary: does NOT work

A natural decode plan for the II preset-dump body is: capture N
preset dumps with one parameter changed between each pair, diff
the binaries byte-for-byte, infer field offsets from the diff
positions.  proposed this as a 21-capture, 70-minute
campaign. It was rejected before execution for two independent
reasons.

## Why it fails

**1. The body is Huffman-compressed.** Per the III community RE
(Fractal Forum thread #159885; same envelope family as II), the
body of the preset-dump envelope is variable-length Huffman-
compressed against a per-firmware codebook. Flat byte offsets are
NOT stable across presets; a single-bit change in an upstream
field shifts every downstream offset by an unpredictable amount.
The diff between two captures with one parameter changed reflects
the codebook output, not the source field location. Decoding the
Huffman codebook is open research of unknown duration.

**2. The atomic read primitive is `fn=0x1F`, not the preset-
binary envelope.** [[ii-fn1f-atomic-read]] (`SYSEX_GET_ALL_PARAMS`,
recovered from AxeEdit.exe ) is the wire shape AxeEdit
actually uses for its "Read from Axe-Fx" sync flow. One
`fn=0x1F` request → device responds with the full per-block state
in a single round-trip. The preset-binary envelope (`0x77/0x78/0x79`)
is a different path used by the editor's "store / load preset
file" feature, not by its parameter-sync feature. The 21-capture
plan was solving the wrong problem.

## What works instead

- **[[ii-fn1f-atomic-read]]** for parameter-state recovery. Single
  request, single response, no Huffman decode needed.
- **[[vendor-envelope-descriptor-table]]** for envelope-shape
  decoding without committing to a full body decode. The
  descriptor table at `.rdata` offset (see III equivalent for the
  shape) declares the preset-dump envelope as
  `(tag=0, mid=6, byte_count=2) + (tag=1, mid=8, byte_count=N)`
  with the body opaque at the wire layer.

## What this does NOT rule out

- Decoding the Huffman codebook itself (separate, open research
  target). If a future session recovers the codebook from a
  firmware dump or matches it against a published Huffman library,
  flat-offset diffing against the *decompressed* body would work.
- Diffing other Fractal envelopes whose bodies are uncompressed
  (e.g. fn=0x02 single-param messages). Those have stable byte
  offsets by construction.

## Refinement history

- 2026-05-22 (cookbook backfill): negative finding registered.
  Citation correction: earlier CLAUDE.md text stated `fn 0x0E` for
  the atomic read primitive; the cookbook positive entry confirms
  it is `fn=0x1F`. This cookbook negative is the byte-correct
  reference.
