# Axe-Fx Standard / Ultra (gen-1) SysEx map

Model byte `0x01`. The first-generation Fractal flagship. Its own codec — it
shares only the Fractal manufacturer envelope with the later gen-2 (Axe-Fx II,
septet-packed) and gen-3 (modern, sub-action) families.

Sources, two documents:
- The published "Axe-FX Ultra System Exclusive Messages" doc (Ultra firmware
  10.02-10.05) — the parameter-SET catalog. The wire is decoded **byte-exactly
  from that doc's worked examples and its full 0..255 conversion table**.
- The community-maintained gen-1 wiki "Axe-Fx System Exclusive Message Spec"
  (wiki.fractalaudio.com/gen1, saved at
  `docs/manuals/AxeFx-gen1-SysEx-Spec-wiki.wikitext.txt`) — the fuller protocol
  doc that documents the bidirectional half (queries + responses + patch dump)
  the param-set catalog omits. Its SET example matches our builder byte-for-byte.

NOT hardware-verified (the project owns no gen-1 hardware), so gen-1 ships
**community-beta**.

## Parameter set / query message (function 0x02)

```
F0 00 01 74 01 02 [bb bb] [pp pp] [vv vv] 01 F7
```

| byte(s) | meaning |
|---|---|
| `F0` | SysEx start |
| `00 01 74` | Fractal manufacturer id |
| `01` | model byte (Ultra; Standard presumed same, unconfirmed) |
| `02` | function = set / query parameter value |
| `bb bb` | block id (nibble-split) |
| `pp pp` | parameter id (nibble-split) |
| `vv vv` | value (nibble-split; irrelevant when querying) |
| `01` | **query(0)/set(1) flag** (NOT a checksum, see below). Set builder emits `1`; the read path emits `0` |
| `F7` | SysEx end |

## The nibble-split encoding (the key primitive)

Every addressable field — block id, param id, AND value — is an 8-bit value
0..255 transmitted as **two MIDI bytes, low nibble first**:

```
toWire(v)   = [v & 0x0f, (v >> 4) & 0x0f]     // each byte is a single nibble 0..15
fromWire(lo,hi) = (hi << 4) | lo
```

Each transmitted byte holds one nibble (0..15), so the high bit is always clear
(MIDI-safe by construction). This is **not** the gen-2 septet pack and **not**
the gen-3 sub-action layout.

Proven from the doc:
- value 163 = 0xA3 → `0v 0v` = `03 0A` (doc's own worked example)
- Compressor 1 block decimal 100 = 0x64 → `04 06`; Amp TYPE max 70 = 0x46 → `06 04`
- Full worked example: set Compressor 2 (block 101) Knee (param 5) = SOFTER
  (value 2) → `F0 00 01 74 01 02 05 06 05 00 02 00 01 F7`
- The doc's complete **0..255 decimal→hexpair conversion table validates 256/256**
  against this encoder (see `scripts/_research/parse-gen1-sysex.ts`).

## The flag byte is set/query, not a checksum

The byte before `F7` is the **query(0)/set(1) flag**, not a checksum: the XOR of
the worked example's payload is `0x02`, not `0x01`, so no checksum is applied.
(Contrast gen-2/AM4, which DO use `fractalChecksum` XOR&0x7F.) Do not call
`fractalChecksum` for gen-1.

It read as a "fixed trailer" only because our original source — the narrow
"Ultra System Exclusive Messages" param-set doc — shows nothing but SET
messages, where this byte is always `1`. The fuller gen-1 wiki spec documents it
as the set/query selector: clear it to `0` to query.

## Reads (function 0x02 query → MIDI_PARAM_VALUE)

Read-back IS part of the gen-1 protocol (decoded from the gen-1 wiki spec;
community-beta, hardware-unconfirmed). Implemented in `readParam.ts`
(`buildGetParam` / `parseParamValue` / `isParamValueResponse`) and wired into the
device package's `DeviceReader` as `get_param` / `get_params`.

Query (value irrelevant, flag = 0):

```
F0 00 01 74 01 02 [bb bb] [pp pp] 00 00 00 F7
```

`MIDI_PARAM_VALUE` response (function 0x02, value + the device's own label):

```
F0 00 01 74 01 02 [bb bb] [pp pp] [vv vv] <ascii label…> 00 F7
```

The device returns the live value (0..254) and a null-terminated label string
("1.234 Hz", "5.00"); the label is ground truth. Older firmware used
manufacturer id `00 00 7D` (10.02+ uses `00 01 74`); the parser currently
matches the `00 01 74` envelope our SET path also uses.

## Still not wired (capability boundary)

Documented in the wiki spec but NOT yet implemented: whole-patch dump
(`MIDI_GET_PATCH` 0x03 → `MIDI_PATCH_DUMP` 0x04 — the ~2060-byte body is only
partially decoded: header, 20-char name in nibble pairs, 4×12 effect grid at
offset 77; the param block is undetermined), modifier query (0x07),
get-firmware (0x08), get-preset-name (0x0f). Not in the protocol at all: save /
store-to-location, preset-change / bank-select, scenes, X/Y channels. The device
package omits those ops; the dispatcher returns `capability_not_supported`.

## Catalog

35 blocks (68 instances), 922 parameters, 246 enum tables (3,482 enum values).
Generated from the doc via the committed pipeline (never hand-transcribed):

```
docs/manuals/AxeFx-Ultra-SysEx-Messages.htm
  → scripts/_research/parse-gen1-sysex.ts        (parse + nibble validation, 0 mismatches)
  → scripts/_research/gen1-canonicalize.ts       (snake_case keys + scaling flags)
  → packages/fractal-midi/scripts/generate-gen1-catalog.ts  (emits src/axe-fx-gen1/{params,blockTypes}.ts)
```

Display-first: continuous params with a documented linear range convert
display↔wire; params the doc marks non-linear (`*`) carry `scaling: 'pending'`
and refuse display conversion (raw wire pass-through) until a curve is supplied —
no fabricated linear interpolation.

## Open items

- **Standard model byte:** the doc covers the Ultra (`0x01`); the Standard is
  presumed to share it but is unconfirmed. Ship Ultra first.
- **Hardware verification:** nothing is confirmed on a physical gen-1 unit.
- **Cookbook:** the nibble-split primitive warrants a cookbook entry + golden
  (follow-up; the gen-1 golden in `test/axe-fx-gen1/setparam.test.ts` already
  locks the encoder).
