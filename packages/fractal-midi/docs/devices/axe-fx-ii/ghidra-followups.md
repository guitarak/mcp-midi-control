# Ghidra-findings follow-ups, execution log

>  mined the Axe-Edit.exe binary and recovered the full
> 94-opcode SysEx vocabulary (`docs/devices/axe-fx-ii/axeedit-opcode-table.md`).
> This file tracks each downstream improvement so the findings don't go
> stale before they're exhausted.
>
> Status legend: ⏳ in progress · ✅ landed · 🔜 next · 🚫 dropped · ⏸ blocked
>
> **Repo layout note (corrects an earlier draft of this doc):** the
> `fractal-midi` codec has been extracted to its own repo. All
> codec-domain work lands HERE (you're reading the codec repo's doc).
> Tool-surface work happens in the consumer MCP server repo. See the
> consumer repo's `CLAUDE.md` "Two-repo layout" section for the
> cross-repo change workflow.

## Phase A, hardware-free, ship now

### A1. ✅ Opcode-table doc corrected with enum-vs-wire offset

The original `axeedit-opcode-table.md` listed raw enum values labeled
as "Wire" bytes. The preamble correctly stated `wire_byte = enum - 1`,
but the table rows didn't apply the offset, propagating confusion (e.g.
the row labeled `0x47 = SYSEX_PATCH_PLUS_CAB_DUMP` when the captured
fn 0x47 frame in `session-58-direct-sync.syx` is actually
`SYSEX_GET_SYSINFO`).

Fix: doc table rewritten with `wire = enum - 1` applied uniformly,
cross-checked against 15+ known wire bytes captured live on Q8.02.

### A2. ⏳ `docs/devices/axe-fx-ii/SYSEX-MAP.md` updated with new opcodes

9 wire bytes recovered from Ghidra that are not in the wiki:

| Wire | AxeEdit name | Notes |
|------|--------------|-------|
| 0x0C | SYSEX_SET_GRID | grid layout WRITE (write companion to fn 0x20 GET) |
| 0x0E | SYSEX_QUERY_STATES | atomic bulk state read (= PRESET_BLOCKS_DATA in wiki) |
| 0x16 | SYSEX_GET_PARAM_INFO | per-param metadata query |
| 0x18 | SYSEX_GET_MODIFIER_INFO | per-block modifier metadata |
| 0x1F | SYSEX_GET_ALL_PARAMS | bulk per-block param dump |
| 0x21 | SYSEX_RESYNC | request device state push (= FRONT_PANEL_CHANGE_DETECTED in wiki) |
| 0x28 | SYSEX_GET_PARAM_STRINGS | enum-value label query (firmware-version-tolerant) |
| 0x47 | SYSEX_GET_SYSINFO | device sysinfo (richer than fn 0x08) |
| 0x48 | SYSEX_FSGRID | footswitch grid |

Also rename or annotate 6 wiki entries where AxeEdit and wiki agree
semantically but use different names (`PARAM_RW` ↔ `PARAM_SET/DUMP`,
`STORE_PRESET` ↔ `SAVE_PATCH`, etc.).

### A3. 🔜 `fractal-midi/src/axe-fx-ii/opcodes.ts`, typed enum

A single source of truth for wire-byte constants. Replaces every
integer literal in `fractal-midi/src/axe-fx-ii/setParam.ts`
(`const FUNC_GET_PRESET_NUMBER = 0x14`) with
`OPCODES.GET_PRESET_NUMBER`. Generated from the Ghidra dump.

**Lives in this codec repo.** Cross-repo workflow per the consumer
repo's `CLAUDE.md` "Two-repo layout" section.

### A4. 🔜 fn 0x21 SYSEX_RESYNC sender + listener

Highest-value functional unlock that doesn't need a fresh capture. The device
emits state-broadcast triples (`0x74/0x75/0x76`) when it gets a
SYSEX_RESYNC. Our decoder already handles those triples
(`scripts/_research/decode-axefx2-chunk.ts` in mcp-midi-control).

The wire byte is **`0x21`** per the offset rule applied to AxeEdit's
enum table (enum 0x22 → wire 0x21). This MATCHES the wiki's
`FRONT_PANEL_CHANGE_DETECTED = 0x21`, semantically the same envelope
(device pushes current state).

Pipeline:

1. Codec side (in this repo: `src/axe-fx-ii/setParam.ts`): add
   `buildResync()` builder.
2. MCP side (the consumer's `packages/axe-fx-ii/` directory): add a
   `getWorkingBufferState()` method on the II reader that sends
   RESYNC, subscribes to inbound triples for ~1-2 s, decodes each
   via the existing position-as-paramId logic, and returns
   `Map<blockId, Map<paramId, wireValue>>`.
3. Wire it into a unified `get_preset(port)` v1 that turns the
   collected per-block state into a `PresetSpec`.
4. Goldens: send RESYNC, assert triples come back.

If fn 0x21 RESYNC pushes state-broadcast triples as named, this is
the atomic-read deliverable. No fresh capture needed.

### A5. 🔜 AM4-Edit binary opcode-table mining

Apply the same Ghidra approach (`DumpAxeEditIIOpcodeTable.java`
adapted) to `AM4-Edit.exe`. Likely outputs:

- Full AM4 opcode table.
- Confirmation that wire bytes match between AM4 vs II for shared
  envelopes.
- Identification of AM4-specific opcodes the wiki / our codec
  doesn't cover.

The AM4 binary is already in the Ghidra project. Script + run-CMD
should clone in ~20 min.

### A6. 🔜 AxeEdit III binary opcode-table mining

Same as A5 for III. `MineAxeEditIII.java` exists for params; opcode
table is a separate sweep. Likely reveals III's `SET_PARAMETER` wire
shape (still-pending pending hardware confirmation).

### A7. 🔜 `fn 0x0E SYSEX_QUERY_STATES` response decode, from existing capture

Originally queued behind a new bidirectional capture. Founder
pushback: `samples/captured/session-58-direct-sync.syx` IS
bidirectional, it contains the 768 inbound preset-name responses and
1217 inbound cab-name responses alongside the outbound queries. The
fn 0x0E request's RESPONSE bytes are in that file too; we just haven't
analyzed them yet.

Plan: write a research script (`scripts/_research/` in the consumer repo
or in this repo's `scripts/`) that walks session-58-direct-sync.syx
and extracts every inbound frame whose function byte is 0x0E or
0x18 (the 24 per-block state polls' responses). Decode each.

If this yields a clean response decode, **the fresh capture is no longer needed**
and Phase B items B1 / B2 / B3 move into Phase A.

### A8. 🔜 Cross-device opcode comparison

After A5 + A6 land, produce `docs/devices/cross-device-opcode-comparison.md`
listing each opcode and whether it exists in AM4 / II / III with each
device's wire byte. Reveals firmware-family-shared opcodes (one
decode unlocks all three).

## Phase B, after capture lands

### B1. ⏸ fn 0x0E response decode → atomic `get_preset`

The capture confirms the response binary layout. Then we ship the
atomic read primitive. ~1-2 s per call, no scene walk, no state
mutation.

### B2. ⏸ fn 0x1F response decode → per-block bulk param read

Alternative to per-param reads for "give me everything about Reverb 1
right now." ~1 round-trip per block.

### B3. ⏸ fn 0x47 response decode → enriched `device_info`

Capabilities, options, model variant beyond fn 0x08 firmware version.

### B4. ⏸ fn 0x28 SYSEX_GET_PARAM_STRINGS → runtime enum query

Eliminates the hardcoded amp-type-string drift between firmware
versions. `cross-device-enums.ts` becomes a runtime fallback rather
than the source of truth.

## Phase C, bigger initiatives

### C1. ⏸ Captures inventory for AM4 / III / Hydra

Currently II-focused. Apply the same inventory practice across
devices.

### C2. ⏸ `fractal-midi-opcodes.json` build artifact

Ghidra → JSON pipeline so the opcode table is regenerable. CI fails
if AxeEdit's table changes (firmware update) without a corresponding
refresh.

### C3. ⏸ `describe_device.capabilities.atomic_read` / `atomic_write` flags

Set true on devices where we've decoded the atomic read path. Agents
prefer atomic ops where available.

### C4. ⏸ Retire `axefx2_*` device-namespaced tools

Once `get_preset` lands, the agent's 22-call read pain
goes away and several namespaced tools become redundant.

### C5. ✅ Move `SYSEX-MAP.md` + `axeedit-opcode-table.md` into the
extracted fractal-midi package

The wire protocol docs are codec material and now live in
`fractal-midi/docs/devices/`: `am4/SYSEX-MAP.md`,
`axe-fx-ii/SYSEX-MAP.md` + `axe-fx-ii/axeedit-opcode-table.md`,
`axe-fx-iii/SYSEX-MAP.md`, `hydrasynth/SYSEX-MAP.md`. The same sweep
relocated the research narratives (`docs/research/*-research.md`) to
`fractal-midi/docs/research/`, and Ghidra mining scripts moved with
them to `fractal-midi/scripts/ghidra/`. Confirmed 
during a planned-doc-refactor audit; mcp-midi-control now holds only
MCP-contract material per the "Two-repo layout" section in its
CLAUDE.md.
