---
name: paramBase-plus-paramId
class: address-calculation
status: partial-N1
discovered:  (formula);  (28-block width table)
verified_on:
  - axe-fx-ii-q8.02
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-paramBase-plus-paramId
relates_to: [alphabetical-name-cascade-block-ordering, block-record-stride-8, wire-id-pairs-per-placed-block, septet-21bit-byte2-mask-preservation]
consumed_in:
  - packages/fractal-gen2/src/blockBinaryLayout.ts (width + X→Y offset tables)
  - packages/fractal-gen2/src/sceneChannelMap.ts (BLOCK_LAYOUT_MAP)
# Note: axefx2_atomic_apply was deprecated ; the active
# consumer is the apply_preset slots[].params.X/.Y nesting path.
---

# paramBase + paramId = ushort offset (II)

For each placed block in the II preset binary, the per-param ushort
offset is `paramBase + paramId`. `paramBase` is layout-dependent (varies
with preset composition); `paramId` is fixed per (block-type, param)
pair.

## Formal definition

For a placed block `b` with block-type `T` and a parameter with
`paramId` `p`:

```
ushortOffset(b, p) = paramBase(b) + p
value             = decode21bit(presetBinary, ushortOffset(b, p))   # see [[septet-21bit-byte2-mask-preservation]]
```

Where `paramBase(b)` depends on the preset's block composition AND the
firmware's sort algorithm (NOT a simple alphabetical sort — see "Sort
algorithm" below). Per-block widths are STABLE across preset
compositions, confirmed via 5 batches of co-resident probes (Session
116 cont 2, -DECODE-NOTES.md lines 109-148).

## Status: partial-N1

`partial-N1` not because widths are missing (they're not — 28 measured
+ persisted in `blockBinaryLayout.ts`), but because **the sort
algorithm is only partially cracked**. Cascade order works for batches
A/B/C/E; breaks for Batch D (PanTrem appeared before Vocoder/VolPan)
and for Mixer (always sorts to the END regardless of cascade position).

Promotion to `matched` blocked on full sort-algorithm reverse engineering.

## Measured widths (-DECODE-NOTES.md )

Per-block-name widths in ushorts, cross-verified across batches A-E
(stable per block-name regardless of co-resident placement):

| Block-name | Width | Verified |
|---|---|---|
| Amp | 238 | Test Crunch + all batches |
| Cab | 80 | Test Crunch + all batches |
| Chorus | 50 | A, E |
| Compressor | 42 | A, E + Test Crunch |
| Crossover | 17 | A |
| Delay | 142 | A + Test Crunch |
| Drive | 44 | A + Test Crunch |
| EffectsLoop (FX Loop) | 22 | D |
| Enhancer | 13 | A |
| Filter | 16 | A |
| Flanger | 50 | B, E |
| Formant | 14 | B |
| GateExpander | 28 | B |
| GraphicEQ | 40 | B, E |
| MegaTap | 19 | B |
| MultibandComp | 30 | B |
| MultiDelay | 120 | B |
| ParametricEQ | 50 | C, E |
| Phaser | 48 | C |
| Pitch | 172 | C, E |
| Resonator | 42 | C |
| Reverb | 92 | C, E |
| RingMod | 12 | C, D |
| Rotary | 40 | C, D |
| Synth | 42 | D |
| Vocoder | 52 | D |
| VolPan | 11 | D |
| PanTrem | 34 | D |

Per-block-name X→Y channel offsets (ushorts,  cont 2 Tier 1a):

| Block-name | X→Y offset |
|---|---|
| Amp | 118 |
| Cab | 39 |
| Compressor | 20 |
| Delay | 70 |
| Drive | 21 |
| Reverb | 45 |

Remaining block-names' X→Y offsets need measurement (probe per-block-name
with channel-X + channel-Y SET_PARAM, observe diff in both positions).

## Sort algorithm — observed anomalies

The binary order is DETERMINISTIC but not yet predictable from a single
sort key. Observations across 5 batches (-DECODE-NOTES.md lines
164-181):

- **Cascade order from `FUN_00595260` works for batches A, B, C, E.**
- **Batch D breaks cascade**: PanTrem (cascade pos 31) appeared BEFORE
  Vocoder (29) + VolPan (30) in the binary. PanTrem alphabetically
  precedes V-names (P < V), suggesting an alphabetical-by-cascade-key
  fallback when blocks are spread across cascade-position clusters.
- **Mixer (canBypass=false) always sorts to the END** regardless of
  cascade position (cascade pos 17, observed last in Batch B).

Hypothesis: the sort is by canBypass-class first (true → false), then
by some secondary key that's mostly cascade-position but sometimes
alphabetical. Not yet conclusively reverse-engineered.

## Path to `matched` status

Two paths:

- **Path A (calibration-based atomic apply — interim)**: for each
  preset handled, dump it, send one test SET_PARAM per target block,
  dump again, derive each block's paramBase from the diff. Cache
  per-preset. Per -DECODE-NOTES.md line 191, this is the
  RECOMMENDED interim approach.
- **Path B (full sort algorithm RE)**: Ghidra mining was **explicitly
  ruled out ** — the encoder lives in firmware, NOT
  in AxeEdit.exe. The AxeEdit binary only consumes the device-encoded
  output. Full RE requires firmware analysis (separate, deeper effort).

## Applicability

Use ONLY for preset compositions whose block-set has been validated
against the sort algorithm. The persisted `blockBinaryLayout.ts` widths
+ X→Y offsets are correct per-block-name; the paramBase ORDERING
requires the calibration path or full sort-algorithm crack.

## Misapplication failure modes

- **DO NOT** assume the  paramBase values generalize across
  presets — they don't, due to the sort-algorithm anomalies. This is
  the literal N=1 trap the plan's capability-application discipline §
  "Generalization-claim check" was designed to catch.
- **DO NOT** ship a tool that uses naive cascade-order paramBase without
  a runtime calibration check or a documented preset-composition
  constraint.

## Where it does NOT apply

- AM4 (different binary layout; 4 slots, no cascade).
- Axe-Fx III — transfer candidate. III binary likely uses a similar
  per-block-name width + sort scheme; un-verified.

## Verification path

`scripts/cookbook-verify.ts#case-paramBase-plus-paramId` runs 1 fixture
(Test Crunch composition). `partial-N1` only requires one fixture. To
promote to `matched`: add ≥1 more fixture from a composition that
triggers the sort anomaly (e.g. include Mixer or PanTrem + Vocoder +
VolPan); cookbook-verify will then refuse to promote unless the sort
algorithm is fully captured.

## Refinement history

- : formula `paramBase + paramId = ushort offset` decoded
  for Test Crunch.
- : BLOCK_LAYOUT_MAP shipped with Test Crunch widths,
  caveat in tool description.
-  cont: co-resident probe (Chorus added to Test Crunch)
  proved paramBase is layout-dependent. Cascade-order rule recovered
  from `AEImageDepot::FUN_00595260`. Status downgraded → `partial-N1`.
- : 28 block-name widths measured across 5 batches,
  persisted in `blockBinaryLayout.ts`. Cross-block stability confirmed.
  X→Y offsets measured for 6 Tier-1 blocks.
- : Ghidra Path B (mine "compute binary size" in
  AxeEdit.exe) explicitly ruled out — encoder lives in firmware.
  Path A (calibration-based atomic apply) confirmed as interim
  approach.
- : deprecated `axefx2_atomic_apply` tool;
  scene-state writes route through `apply_preset slots[].params.X/.Y`
  channel-nesting path.
- 2026-05-22 (cookbook audit): refreshed the entry to reflect Session
  116 cont 2-4 actual state — width table is 28 rows (not the original
  5), Ghidra path is closed (not "queued"), and the sort-algorithm
  anomalies (Batch D, Mixer) are the actual blocker to `matched` status.
