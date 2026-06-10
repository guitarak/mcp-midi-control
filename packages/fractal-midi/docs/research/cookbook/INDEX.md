# Encoding Cookbook — Index

> Read this BEFORE researching a new wire shape. The shape may already be a
> known primitive. The cookbook turns decode work from infinite-capture into
> mechanical composition.

Each entry is one file. Status comes from frontmatter; `cookbook-verify` is
the build gate. Refinement happens in place (update the file, log the
status transition in the Refinement history footer).

## How to use

1. Looking up a primitive: grep by name or read the table below.
2. Decoding a new wire shape: walk the table. Is your shape an instance of
   any registered primitive? If yes, mechanical decode. If no, you may be
   discovering a new primitive — register it the same session.
3. Refining a primitive (new evidence, new fixture, status promotion):
   update the entry in place. Don't create a duplicate file. See
   `../INDEX.md` § "Refinement workflow" for the canonical procedure.

## Status legend

- `matched` — generalized + golden passes + ≥ 2 fixtures from **distinct
  axis points**. An axis point is a device family (AM4 vs II vs III vs
  Hydra), a firmware major revision (Q8 vs Q9), or a capture context
  (live-wire vs forum capture vs Ghidra dump). Two entries of the same
  kind (e.g. two firmware revisions of the same device) only qualify
  when the body explicitly identifies firmware-revision as the
  generalization axis being claimed. Build-gate-protected.
- `matched-singleton` — generalized as far as it goes (no second axis
  exists). 1 fixture is sufficient. Applicability section must explain
  why no second axis applies.
- `partial-N1` — shipped with N=1 caveat. Counted separately in
  `decode-progress`. Path to `matched` is named in the entry's body.
- `wip` — in progress; not build-gating.
- `scratch` — in `_scratch/`, expect-fail golden, hypothesis pending.
- `regression` — build break by design; must be triaged.
- `non-matching` — in `_negative/`, hypothesis rejected.

## The table

| Primitive | Class | Status | Devices | Notes |
|---|---|---|---|---|
| [septet-14bit](septet-14bit.md) | bit-level | matched | AM4 / II / III | 14-bit value as 2 septets; pidLow, pidHigh, action codes, effect IDs, preset numbers, tempo BPM, location bytes |
| [gen1-nibble-split](gen1-nibble-split.md) | bit-level | matched-singleton | Standard/Ultra (gen-1) | Every 8-bit field (block id / param id / value) as 2 bytes, low nibble first `[v&0x0f,(v>>4)&0x0f]`; fixed `0x01` trailer, NO checksum. Distinct from gen-2 septet / gen-3 float32 |
| [septet-21bit-byte2-mask-preservation](septet-21bit-byte2-mask-preservation.md) | bit-level | matched-singleton | II | 21-bit-in-3-bytes; `byte2 & 0x7c` MUST be preserved on writeback |
| [msb-first-14bit-preset-payload](msb-first-14bit-preset-payload.md) | bit-level | matched | II / III | Preset numbers ≥128 encode MSB-first in fn 0x03 / 0x3c / 0x1d |
| [xor-7f-envelope-checksum](xor-7f-envelope-checksum.md) | checksum | matched | AM4 / II / III | Universal Fractal envelope checksum: `bytes.reduce((a,b)=>a^b,0) & 0x7F` over F0..last payload byte |
| [xor-fold-hash](xor-fold-hash.md) | checksum | matched | II (Q8 + Q9) | Footer hash = trivial 16-bit XOR-fold of decoded native ushorts; `FUN_00544cc0` |
| [vendor-envelope-descriptor-table](vendor-envelope-descriptor-table.md) | struct-layout | matched | AM4 / II / III | Universal Fractal envelope spec: `(tag, wire-offset-from-F0, byte-count-or-units-per-element)` triples in `.rdata` |
| [param-descriptor-16byte](param-descriptor-16byte.md) | struct-layout | matched | II / III / AM4 | 16-byte struct: `paramId at +0, name pointer at +8` |
| [per-effect-paramtable-dispatcher](per-effect-paramtable-dispatcher.md) | dispatch-context | matched | AM4 / III / FM3 / FM9 / VP4 | Switch dispatcher selecting per-effect ParamDescriptor tables; `(effectType, paramId)` addressing. Direct PE pattern-scan recovers rows without Ghidra |
| [iii-paramid-pseudo-sentinel-ranges](iii-paramid-pseudo-sentinel-ranges.md) | struct-layout | matched-singleton | III | paramIds in `0xFF00..0xFFFE` are non-terminator pseudo-entries (UI separators); only `0xFFFFFFFF` is the true terminator |
| [block-record-stride-8](block-record-stride-8.md) | struct-layout | matched-singleton | II | Block-record table at chunk 0 ushort 36+, stride 8 |
| [preset-name-ascii-triplets](preset-name-ascii-triplets.md) | struct-layout | matched-singleton | II | 32 × 3-byte ASCII triplets `[ch, 0x00, 0x00]` at CHUNK00:008-103 |
| [wire-id-pairs-per-placed-block](wire-id-pairs-per-placed-block.md) | struct-layout | matched-singleton | II | Each block-type name reserves K ∈ {1,2,4} consecutive wire-ids |
| [alphabetical-name-cascade-block-ordering](alphabetical-name-cascade-block-ordering.md) | struct-layout | partial-N1 | II | `AEImageDepot::FUN_00595260` cascade; works for batches A/B/C/E but breaks for Batch D + Mixer (canBypass-class hypothesis pending) |
| [paramBase-plus-paramId](paramBase-plus-paramId.md) | address-calculation | partial-N1 | II | `paramBase + paramId = ushort offset`; 28 block-name widths measured (stable per block-name); full sort algorithm unsolved |
| [ii-fn16-get-param-info](ii-fn16-get-param-info.md) | struct-layout | partial-N1 | II | 25-byte per-param descriptor: 5 groups of 5-septet-LE 32-bit; G1/G2/G3 float32 min/max/default |
| [ii-fn0e-query-states](ii-fn0e-query-states.md) | struct-layout | matched-singleton | II | fn 0x0E whole-preset block-state read: 5-byte records, count==placed non-shunt blocks, checksum-less; tag byte = active-scene state (bit 0x01 engaged, 0x02 channel); b1..b4 = per-block address monotonic in blockId (sort records by it, zip to placed blockIds to identify each). II-only opcode |
| [scene-state-ushort](scene-state-ushort.md) | packed-field | matched-singleton | II | One ushort per (block, scene): low byte = bypass mask, high byte = channel-Y mask |
| [display-q16-fixedpoint](display-q16-fixedpoint.md) | coercion | wip | AM4 / II / III | `display = wire / 65536`;  sanity probe queued |
| [display-log10-scaling](display-log10-scaling.md) | coercion | matched-singleton | II | 17 hand entries gained `scaling: 'log10'`  |
| [ii-compressor-calibration-divergence](ii-compressor-calibration-divergence.md) | coercion | matched-singleton | II | II STUDIO COMP uses different display ranges than AM4 compressor; threshold -80..0, attack 1..100, release 10..1000 |
| [trim-tolerant-display-match](trim-tolerant-display-match.md) | coercion | matched | II | Device pads trailing whitespace; comparison uses `hw.trimEnd() === cat` |
| [juce-binarydata-zip](juce-binarydata-zip.md) | label-extraction | matched | AM4 / III / FM3 / FM9 / VP4 | Embedded ZIP (raw DEFLATE, no gzip magic) in JUCE BinaryData; 1,299 AM4 + 10,250 III labels + gen-3 FM family |
| [editor-cache-section-record-grammar](editor-cache-section-record-grammar.md) | label-extraction | matched | AM4 / II / III / FM9 / VP4 | `effectDefinitions_*.cache` full grammar: count-driven sections of 22-byte-header records; sectionTag = block tag (shared across devices), recordCount = fn=0x1F stride; device-true ranges + complete enum rosters (II 266-amp roster, 259/259 catalog agreement); zero-resync walks on 7 caches; no-device caches are placeholder stubs |
| [fn28-enum-dump](fn28-enum-dump.md) | label-extraction | matched-singleton | II | Hardware-truth device-emitted enum labels; supersedes wiki |
| [ii-axeedit-opcode-table](ii-axeedit-opcode-table.md) | fn-byte-mapping | matched-singleton | II | Static `OpcodeDescriptor` table in `.rdata`; 94 entries; `wire = enum - 1` |
| [iii-host-emitter-fn-table](iii-host-emitter-fn-table.md) | fn-byte-mapping | matched-singleton | III | ~21 III host-emittable fn-bytes from caller-trace mining |
| [iii-fn01-set-parameter-envelope](iii-fn01-set-parameter-envelope.md) | envelope-shape | matched | III | III SET_PARAMETER is fn=0x01 + sub-action (NOT fn=0x02); 10 public captures |
| [am4-pidlow-register-families](am4-pidlow-register-families.md) | fn-byte-mapping | matched-singleton | AM4 | `pidLow=0x00CE` (PATCH) + `pidLow=0x0001` (GLOBAL) family discriminator |
| [ii-fn1f-atomic-read](ii-fn1f-atomic-read.md) | fn-byte-mapping | matched-singleton | II | fn=0x1F SYSEX_GET_ALL_PARAMS; single round-trip atomic read |
| [ii-fn03-dump-addressing](ii-fn03-dump-addressing.md) | fn-byte-mapping | matched-singleton | II | fn=0x03 two forms: slot-addressed = STORED dump + RELOADS the buffer (destructive); `7F 7F` sentinel = EDIT-BUFFER dump (tracks edits, no side effect, round-trips) |
| [am4-fn03-stored-dump-request](am4-fn03-stored-dump-request.md) | fn-byte-mapping | matched-singleton | AM4 | fn=0x03 `[bank, sub, 0x00]` = stored-location dump; header echoes bank/sub; NO buffer side effect; dump has volatile bytes (mask before byte-compare) |
| [ii-state-broadcast-triple-write](ii-state-broadcast-triple-write.md) | envelope-shape | matched-singleton | II | Host→device 0x74/0x75/0x76 write; bidirectional but NOT channel-aware; per-position encoding (wire16 vs display-int) |
| [am4-fn1f-atomic-read](am4-fn1f-atomic-read.md) | fn-byte-mapping | matched-singleton | AM4 | fn=0x1F per-block atomic read; 2-byte effectId payload; 0x74/0x75/0x76 state-broadcast triple reply |
| [gen3-fn1f-poll-block-bulk-read](gen3-fn1f-poll-block-bulk-read.md) | fn-byte-mapping | matched-singleton | FM9 | gen-3 fn=0x1F poll → 0x74/0x75/0x76 burst; positional body (index i == device-true paramId i); paged sections concatenate |
| [gen3-fn03-request-preset-dump](gen3-fn03-request-preset-dump.md) | envelope | partial-N1 | FM9 | fn=0x03 [preset#:14b BIG-ENDIAN] → 0x77/0x78×N/0x79 dump; reply parses via presetDump.ts; read/backup only |
| [gen3-enum-label-septet-stream](gen3-enum-label-septet-stream.md) | bit-level | partial-N1 | FM9 | enum value NAMES cross the wire septet-packed; 8→7 unpack starting at byte 5; carriers sub=0x2e/0x1a/0x09/0x2a/0x01 |
| [gen3-fn01-set-float32-ordinal](gen3-fn01-set-float32-ordinal.md) | protocol-exchange | matched-singleton | FM9, FM3 | gen-3 SET value = 5-septet LE float32 @ pos 12; discrete (09 00) = float32(ordinal), continuous (52 00) = float32(0..1). Retired the pos-15 raw-id misread. |
| [gen3-fn01-grid-set-position-insert](gen3-fn01-grid-set-position-insert.md) | envelope-shape | matched | III / FM9 | block insert: fn=0x01 sub=0x32 = `[effectId:14b] .. [gridPos:14b]` (sub=0x30 cell-select companion); gridPos=col*6+row (6-row grid); byte9=0x08 = shunt. No-hardware loopMIDI, byte-identical across model 0x10/0x12 |
| [gen3-fn01-grid-routing](gen3-fn01-grid-routing.md) | envelope-shape | matched | III / FM9 / FM3 | routing cable: fn=0x01 sub=0x35; 26-byte frame; two formula variants: 6-row (III/FM9) uses scaled colTerm + destSign; 4-row (FM3) uses colTerm=srcCol, no destSign, b23=(destRow-1)×32. Row-1 even-col works on FM3, refused on 6-row (not yet decoded). FM9-Edit 26 cables + FM3-Edit 10 cables over loopMIDI |
| [gen3-fn01-store-preset](gen3-fn01-store-preset.md) | envelope-shape | matched | III / FM9 | store/save-to-location: fn=0x01 sub=0x26 = `[presetNum:14b LSB-first @ byte12-13]`. Corrects the fn=0x1D save guess. No-hardware loopMIDI capture, model 0x10 + 0x12 |
| [gen3-editor-sync-read-surface](gen3-editor-sync-read-surface.md) | envelope-shape | matched-singleton | FM9 | editor connect/sync reads: every fn=0x01 response echoes query bytes 5..11; per-sub fixed response lengths; sub=0x7b placed-flag (bytes 12-13 nonzero == placed); 0x74 head is 12 bytes (no flag). The read surface a codec-backed device simulator answers to render the grid |
| [gen3-sub01-block-definition-response](gen3-sub01-block-definition-response.md) | envelope-shape | matched-singleton | FM9 | sub=0x01 query's response = 113-byte frame, tailCount14=80 DECODED bytes shipped as 92 wire septets ([[iii-byte-stream-septet-pack-8to7]]); 80-byte LE record {eid, familyTag(=cache sectionTag), instance, channelCount, paramCount(=fn=0x1F wire stride, ordinary records only; CABINET 106 vs cache 110), name[32], abbrev[12], flags}; all-zero record for empty eids; value32 slot is NOT the param value; host query bytes still uncaptured |
| [ii-fn06-set-cell-routing](ii-fn06-set-cell-routing.md) | fn-byte-mapping | matched-singleton | II | fn=0x06 grid-cell edge connect/disconnect; 3-byte payload |
| [ii-fn07-modifier-read](ii-fn07-modifier-read.md) | envelope-shape | matched-singleton | II | fn=0x07 field-indexed modifier read; `[effId][slot][field][value16][ASCII label]`; fn 0x18 is request-only |
| [hydra-sysex-envelope-base64-crc32](hydra-sysex-envelope-base64-crc32.md) | checksum | matched-singleton | Hydra | ASM envelope `F0 00 20 2B 00 6F <base64-payload> F7`; 4-byte CRC32-derived checksum |
| [hydra-nrpn-14bit-with-fxaware-resolution](hydra-nrpn-14bit-with-fxaware-resolution.md) | bit-level | matched-singleton | Hydra | 1175 NRPNs; 5-step resolution chain; FX sub-params context-sensitive on `prefxtype` |
| [hydra-mod-matrix-category-prefixed-value](hydra-mod-matrix-category-prefixed-value.md) | value-encoding | matched-singleton | Hydra | Mod source/target = 14-bit category-prefixed WIRE VALUE (not list index); `Env 1`=129, `Filt 1 Cutoff`=296; depth bipolar -128..+128 |
| [hydra-envelope-time-table](hydra-envelope-time-table.md) | coercion | matched-singleton | Hydra | 27 wire-to-ms HW-verified pairs; non-linear table beats Q16/log10 |
| [iii-byte-stream-septet-pack-8to7](iii-byte-stream-septet-pack-8to7.md) | bit-level | matched-singleton | III | Variable-length 8-to-7 byte-stream packer per AxeEdit III `FUN_14033f2d0`; generalizes [[septet-14bit]] for arbitrary-length payloads |
| [iii-multiproduct-editor-binary](iii-multiproduct-editor-binary.md) | dispatch-context | matched-singleton | III / FM3 / FM9 | AxeEdit III's binary serves three model bytes (0x10/0x11/0x12); behavior dispatches via `DAT_1412633f8` and per-caller chained-equality blocks |
| [iii-fn01-action-code-per-model-byte](iii-fn01-action-code-per-model-byte.md) | dispatch-context | matched-singleton | III / FM3 / FM9 | fn=0x01 callers diverge per model byte (e.g. `FUN_1401e38a0` emits 0x84/0x83/0x7b); naive III→FM9 ports break on this |
| [iii-async-workflow-fn-registry](iii-async-workflow-fn-registry.md) | dispatch-context | matched-singleton | III | AxeEdit III routes inbound by ~60 named workflows registering fn-bytes via `FUN_1401bac70` + `FUN_14005faa0`; ground truth for "what fn-byte means in context" |
| [iii-workflow-state-machine-executor](iii-workflow-state-machine-executor.md) | dispatch-context | matched-singleton | III | `FUN_1401f4390` state-machine executor with ~70 case labels; cases emit fn=0x01 via `FUN_14033ec70`, many pick action14 by model-byte chained-equality |

## Negative findings

See `_negative/INDEX.md` (or grep the directory). Always check before
re-attempting a method that "feels useful but might already be ruled out."

## Scratch (in-flight hypotheses)

See `_scratch/`. Goldens are `expect-fail` until promoted. A scratch entry
whose golden unexpectedly passes is a build break — promote or document.

## Adding to this index

The cookbook discipline: every session that discovers, refines, or rules
out an encoding primitive adds OR updates one file in `cookbook/` + adds
at least one golden case to `scripts/cookbook-verify.ts` in the same
session. Refinement workflow handles status promotions (`partial-N1` →
`matched-singleton` → `matched`). See `../INDEX.md` for the full procedure.
