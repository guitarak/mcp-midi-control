# Axe-Fx III, fn=0x01 SET_PARAMETER action codes (Ghidra-decoded)

**Status:** Decoded by parsing the existing Ghidra decompile dump
(`samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt`).
Each of the 93 callers of `FUN_14033ec70` (fn=0x01 wrapper) sets the
action code (Field A in `fn01-builder-ghidra.md`) into the first slot
of the action struct, which is reached via a class field at offset
+0x40 / +0x148 / +0x248 / +0x290 (varies per caller class).

## How action codes are computed

Contrary to the handoff doc's hypothesis (constructor-set per-class
constants), action codes are **selected inside the emit method itself**
via a switch on the model byte at `*(char *)(param_1 + 0x38)`:

| Model byte | Device |
|---|---|
| `0x10` | Axe-Fx III |
| `0x11` | FM3 |
| `0x12` | FM9 (and presumably III Mark II / III Turbo) |

Most emit methods have an `if (cVar1 == \x10/0x11/0x12)` chain that
maps each model to its own action code; some emit zero for unknown
models (probably a no-op safety fallthrough).

Three IIIs-only `0x52` (SET), `0x04 01` (STATE_BROADCAST), `0x01 00`
(long broadcast) were already known from public captures. This pass
extends the table with the per-emit-site III action codes.

## Per-caller table (III model 0x10)

| # | Caller | Field offset | III action code | Other models | Workflow context |
|---:|---|---:|---:|---|---|
| 1 | `FUN_1401e3310` @ 1401e3310 | 0x40 | (dynamic) |, | preset-buffer/scene state writes (UI control path) |
| 2 | `FUN_1401e38a0` @ 1401e38a0 | 0x40 | 0x84 | 0x83 (0x11), 0x7B (0x12) | preset-buffer/scene state writes (UI control path) |
| 3 | `FUN_1401e3a80` @ 1401e3a80 | 0x40 | 0x84 | 0x83 (0x11), 0x7B (0x12) | preset-buffer/scene state writes (UI control path) |
| 4 | `FUN_1401e3b40` @ 1401e3b40 | 0x40 | 0x4B |, | preset-buffer/scene state writes (UI control path) |
| 5 | `FUN_1401e4030` @ 1401e4030 | 0x40 | 0x50 |, | preset-buffer/scene state writes (UI control path, cont.) |
| 6 | `FUN_1401e4130` @ 1401e4130 | 0x40 | 0x51 |, | preset-buffer/scene state writes (UI control path, cont.) |
| 7 | `FUN_1401e41e0` @ 1401e41e0 | 0x40 | 0x72 | 0x79 (0x12) | preset-buffer/scene state writes (UI control path, cont.) |
| 8 | `FUN_1401e42a0` @ 1401e42a0 | 0x40 | 0x1C |, | preset-buffer/scene state writes (UI control path, cont.) |
| 9 | `FUN_1401e4350` @ 1401e4350 | 0x40 | 0x3B |, | preset-buffer/scene state writes (UI control path, cont.) |
| 10 | `FUN_1401e4400` @ 1401e4400 | 0x40 | 0x3A |, | preset-buffer/scene state writes (UI control path, cont.) |
| 11 | `FUN_1401e44b0` @ 1401e44b0 | 0x40 | 0x39 |, | preset-buffer/scene state writes (UI control path, cont.) |
| 12 | `FUN_1401e4560` @ 1401e4560 | 0x40 | 0x23 |, | preset-buffer/scene state writes (UI control path, cont.) |
| 13 | `FUN_1401e4610` @ 1401e4610 | 0x40 | 0x22 |, | preset-buffer/scene state writes (UI control path, cont.) |
| 14 | `FUN_1401e46c0` @ 1401e46c0 | 0x40 | 0x19 |, | preset-buffer/scene state writes (UI control path, cont.) |
| 15 | `FUN_1401e4770` @ 1401e4770 | 0x40 | 0x1A |, | preset-buffer/scene state writes (UI control path, cont.) |
| 16 | `FUN_1401e4820` @ 1401e4820 | 0x40 | 0x1B |, | preset-buffer/scene state writes (UI control path, cont.) |
| 17 | `FUN_1401e4a90` @ 1401e4a90 | 0x40 | (dynamic) |, | preset-buffer/scene state writes (UI control path, cont.) |
| 18 | `FUN_1401e4be0` @ 1401e4be0 | 0x40 | (dynamic) |, | preset-buffer/scene state writes (UI control path, cont.) |
| 19 | `FUN_1401e6bd0` @ 1401e6bd0 | ? | (dynamic) |, | preset-buffer/scene state writes (UI control path, cont.) |
| 20 | `FUN_1402263a0` @ 1402263a0 | 0x248 | 0x26 |, | block-editor operations (param dialog cluster A) |
| 21 | `FUN_140226860` @ 140226860 | 0x248 | 0x27 |, | block-editor operations (param dialog cluster A) |
| 22 | `FUN_140226d40` @ 140226d40 | 0x248 | 0x17 |, | block-editor operations (param dialog cluster A) |
| 23 | `FUN_140227220` @ 140227220 | 0x248 | 0x16 |, | block-editor operations (param dialog cluster A, cont.) |
| 24 | `FUN_140228410` @ 140228410 | 0x248 | (dynamic) |, | block-editor operations (param dialog cluster B) |
| 25 | `FUN_140227820` @ 140227820 | 0x248 | 0x01 |, | block-editor operations (param dialog cluster A, cont.) |
| 26 | `FUN_140227db0` @ 140227db0 | 0x248 | 0x2E |, | block-editor operations (param dialog cluster A, cont.) |
| 27 | `FUN_14020a5e0` @ 14020a5e0 | 0x148 | 0x2E |, | unclassified |
| 28 | `FUN_14020f6e0` @ 14020f6e0 | 0x290 | 0x39 |, | unclassified |
| 29 | `FUN_1402104f0` @ 1402104f0 | 0x290 | 0x27 |, | unclassified |
| 30 | `FUN_140210e60` @ 140210e60 | 0x290 | 0x01 |, | unclassified |
| 31 | `FUN_14020fb90` @ 14020fb90 | 0x290 | 0x34 |, | unclassified |
| 32 | `FUN_140210040` @ 140210040 | 0x290 | 0x26 |, | unclassified |
| 33 | `FUN_1402109a0` @ 1402109a0 | 0x290 | 0x16 |, | unclassified |
| 34 | `FUN_1402113c0` @ 1402113c0 | ? | (dynamic) |, | unclassified |
| 35 | `FUN_140211930` @ 140211930 | 0x290 | 0x1B |, | unclassified |
| 36 | `FUN_140211de0` @ 140211de0 | 0x290 | (dynamic) |, | unclassified |
| 37 | `FUN_14020cca0` @ 14020cca0 | 0x290 | 0x4B |, | unclassified |
| 38 | `FUN_14020d580` @ 14020d580 | 0x290 | 0x26 |, | unclassified |
| 39 | `FUN_140340560` @ 140340560 | 0x08 | 0x28 |, | unclassified |
| 40 | `FUN_140213ac0` @ 140213ac0 | 0x248 | 0x27 |, | unclassified |
| 41 | `FUN_140214af0` @ 140214af0 | 0x248 | 0x73 |, | unclassified |
| 42 | `FUN_140225630` @ 140225630 | ? | (dynamic) |, | unclassified |
| 43 | `FUN_140225ba0` @ 140225ba0 | 0x248 | 0x1B |, | unclassified |
| 44 | `FUN_140218f80` @ 140218f80 | 0x248 | 0x30 |, | unclassified |
| 45 | `FUN_1403404a0` @ 1403404a0 | 0x08 | 0x2B |, | unclassified |
| 46 | `FUN_14021a340` @ 14021a340 | 0x248 | 0x1B |, | unclassified |
| 47 | `FUN_14021afb0` @ 14021afb0 | 0x248 | 0x35 |, | unclassified |
| 48 | `FUN_14021b4c0` @ 14021b4c0 | 0x248 | 0x83 | 0x9C (0x11), 0x95 (0x12) | unclassified |
| 49 | `FUN_14021beb0` @ 14021beb0 | 0x248 | 0x4F |, | unclassified |
| 50 | `FUN_14021d580` @ 14021d580 | 0x248 | 0x3A |, | unclassified |
| 51 | `FUN_14021da30` @ 14021da30 | 0x248 | 0x39 |, | unclassified |
| 52 | `FUN_14021f270` @ 14021f270 | 0x248 | 0x12 |, | unclassified |
| 53 | `FUN_14021f780` @ 14021f780 | 0x248 | 0x25 |, | unclassified |
| 54 | `FUN_140220860` @ 140220860 | 0x248 | 0x25 |, | unclassified |
| 55 | `FUN_140221940` @ 140221940 | 0x248 | 0x47 |, | unclassified |
| 56 | `FUN_140222690` @ 140222690 | 0x248 | 0x2A |, | unclassified |
| 57 | `FUN_1402230d0` @ 1402230d0 | ? | (dynamic) |, | unclassified |
| 58 | `FUN_1402248b0` @ 1402248b0 | 0x248 | 0x1C |, | unclassified |
| 59 | `FUN_14028c210` @ 14028c210 | ? | (dynamic) |, | unclassified |
| 60 | `FUN_1402a5cf0` @ 1402a5cf0 | 0x40 | 0x3B |, | unclassified |
| 61 | `FUN_1402df240` @ 1402df240 | 0x138 | 0x16 |, | unclassified |
| 62 | `FUN_1402da380` @ 1402da380 | ? | (dynamic) |, | unclassified |
| 63 | `FUN_1402da550` @ 1402da550 | 0x158 | 0x2B |, | unclassified |
| 64 | `FUN_1402dc250` @ 1402dc250 | ? | (dynamic) |, | unclassified |
| 65 | `FUN_1402de010` @ 1402de010 | 0x138 | 0x57 |, | unclassified |
| 66 | `FUN_1402de210` @ 1402de210 | 0x138 | 0x59 |, | unclassified |
| 67 | `FUN_1402df370` @ 1402df370 | 0x138 | 0x12 |, | unclassified |
| 68 | `FUN_1402dff20` @ 1402dff20 | 0x138 | 0x58 |, | unclassified |
| 69 | `FUN_1402f0f10` @ 1402f0f10 | 0x178 | 0x27 |, | unclassified |
| 70 | `FUN_1402f5360` @ 1402f5360 | 0x40 | 0x68 |, | unclassified |
| 71 | `FUN_140340930` @ 140340930 | 0x08 | 0x50 |, | unclassified |
| 72 | `FUN_14038b530` @ 14038b530 | ? | (dynamic) |, | unclassified |
| 73 | `FUN_140395eb0` @ 140395eb0 | ? | (dynamic) |, | unclassified |
| 74 | `FUN_140396060` @ 140396060 | 0x1A0 | 0x00 |, | unclassified |
| 75 | `FUN_14033f550` @ 14033f550 | 0x08 | 0x59 |, | unclassified |
| 76 | `FUN_14033f630` @ 14033f630 | 0x08 | 0x57 |, | unclassified |
| 77 | `FUN_14033f9e0` @ 14033f9e0 | 0x08 | 0x35 |, | unclassified |
| 78 | `FUN_140340050` @ 140340050 | 0x08 | 0x4E |, | unclassified |
| 79 | `FUN_140340270` @ 140340270 | 0x08 | 0x7A | 0x81 (0x12) | unclassified |
| 80 | `FUN_140340ae0` @ 140340ae0 | 0x08 | 0x72 | 0x79 (0x12) | unclassified |
| 81 | `FUN_140341590` @ 140341590 | 0x08 | 0x1F |, | unclassified |
| 82 | `FUN_1402991a0` @ 1402991a0 | 0x40 | 0x4B |, | unclassified |
| 83 | `FUN_14039a4b0` @ 14039a4b0 | 0x248 | 0x4B |, | unclassified |
| 84 | `FUN_1401f4390` @ 1401f4390 | ? | (dynamic) |, | unclassified |
| 85 | `FUN_140340170` @ 140340170 | 0x08 | 0x16 |, | unclassified |
| 86 | `FUN_140340610` @ 140340610 | 0x08 | 0x26 |, | unclassified |
| 87 | `FUN_140340440` @ 140340440 | 0x08 | 0x27 |, | unclassified |
| 88 | `FUN_140340670` @ 140340670 | 0x08 | 0x24 |, | unclassified |
| 89 | `FUN_1403403e0` @ 1403403e0 | 0x08 | 0x30 |, | unclassified |
| 90 | `FUN_1403401d0` @ 1403401d0 | 0x08 | 0x33 |, | unclassified |
| 91 | `FUN_140340110` @ 140340110 | 0x08 | 0x12 |, | unclassified |
| 92 | `FUN_140340220` @ 140340220 | 0x08 | 0x34 |, | unclassified |
| 93 | `FUN_14014f690` @ 14014f690 | 0x298 | 0x1B |, | main-app UI driver |

## Unique III (model 0x10) action codes recovered

Total distinct codes: **42**

| Action code (14-bit Field A) | Caller count | Example caller |
|---:|---:|---|
| 0x0000 | 1 | `FUN_140396060 @ 140396060` |
| 0x0001 | 2 | `FUN_140227820 @ 140227820` |
| 0x0012 | 3 | `FUN_14021f270 @ 14021f270` |
| 0x0016 | 4 | `FUN_140227220 @ 140227220` |
| 0x0017 | 1 | `FUN_140226d40 @ 140226d40` |
| 0x0019 | 1 | `FUN_1401e46c0 @ 1401e46c0` |
| 0x001A | 1 | `FUN_1401e4770 @ 1401e4770` |
| 0x001B | 5 | `FUN_1401e4820 @ 1401e4820` |
| 0x001C | 2 | `FUN_1401e42a0 @ 1401e42a0` |
| 0x001F | 1 | `FUN_140341590 @ 140341590` |
| 0x0022 | 1 | `FUN_1401e4610 @ 1401e4610` |
| 0x0023 | 1 | `FUN_1401e4560 @ 1401e4560` |
| 0x0024 | 1 | `FUN_140340670 @ 140340670` |
| 0x0025 | 2 | `FUN_14021f780 @ 14021f780` |
| 0x0026 | 4 | `FUN_1402263a0 @ 1402263a0` |
| 0x0027 | 5 | `FUN_140226860 @ 140226860` |
| 0x0028 | 1 | `FUN_140340560 @ 140340560` |
| 0x002A | 1 | `FUN_140222690 @ 140222690` |
| 0x002B | 2 | `FUN_1403404a0 @ 1403404a0` |
| 0x002E | 2 | `FUN_140227db0 @ 140227db0` |
| 0x0030 | 2 | `FUN_140218f80 @ 140218f80` |
| 0x0033 | 1 | `FUN_1403401d0 @ 1403401d0` |
| 0x0034 | 2 | `FUN_14020fb90 @ 14020fb90` |
| 0x0035 | 2 | `FUN_14021afb0 @ 14021afb0` |
| 0x0039 | 3 | `FUN_1401e44b0 @ 1401e44b0` |
| 0x003A | 2 | `FUN_1401e4400 @ 1401e4400` |
| 0x003B | 2 | `FUN_1401e4350 @ 1401e4350` |
| 0x0047 | 1 | `FUN_140221940 @ 140221940` |
| 0x004B | 4 | `FUN_1401e3b40 @ 1401e3b40` |
| 0x004E | 1 | `FUN_140340050 @ 140340050` |
| 0x004F | 1 | `FUN_14021beb0 @ 14021beb0` |
| 0x0050 | 2 | `FUN_1401e4030 @ 1401e4030` |
| 0x0051 | 1 | `FUN_1401e4130 @ 1401e4130` |
| 0x0057 | 2 | `FUN_1402de010 @ 1402de010` |
| 0x0058 | 1 | `FUN_1402dff20 @ 1402dff20` |
| 0x0059 | 2 | `FUN_1402de210 @ 1402de210` |
| 0x0068 | 1 | `FUN_1402f5360 @ 1402f5360` |
| 0x0072 | 2 | `FUN_1401e41e0 @ 1401e41e0` |
| 0x0073 | 1 | `FUN_140214af0 @ 140214af0` |
| 0x007A | 1 | `FUN_140340270 @ 140340270` |
| 0x0083 | 1 | `FUN_14021b4c0 @ 14021b4c0` |
| 0x0084 | 2 | `FUN_1401e38a0 @ 1401e38a0` |

## Cross-model action-code map

Where a caller emits different codes per model byte, the mapping is:

| Caller | III (0x10) | FM3 (0x11) | FM9/IIITurbo (0x12) |
|---|---:|---:|---:|
| `FUN_1401e38a0` @ 1401e38a0 | 0x84 | 0x83 | 0x7B |
| `FUN_1401e3a80` @ 1401e3a80 | 0x84 | 0x83 | 0x7B |
| `FUN_140340270` @ 140340270 | 0x7A | 0x7A | 0x81 |
| `FUN_140340ae0` @ 140340ae0 | 0x72 | 0x72 | 0x79 |

## Unresolved callers

15 of 93 callers had no extractable III action code.
Typical reasons: RHS is `*puVar5` (read from a UI control struct),
`*(undefined4 *)(param_2 + 2)` (read from an argument), or `param_4`
(passed as a function arg). These are runtime-determined operations
where the action code is set by the CALLER of the emit method.

| Caller | Note |
|---|---|
| `FUN_1401e3310` @ 1401e3310 | no constant assignments to action-code var |
| `FUN_1401e4a90` @ 1401e4a90 | RHS not parseable as variable: "*(param_2 + 2)" |
| `FUN_1401e4be0` @ 1401e4be0 | RHS not parseable as variable: "*(param_2 + 2)" |
| `FUN_1401e6bd0` @ 1401e6bd0 | no action-struct write found (caller may use a different builder path) |
| `FUN_140228410` @ 140228410 | no constant assignments to action-code var |
| `FUN_1402113c0` @ 1402113c0 | no action-struct write found (caller may use a different builder path) |
| `FUN_140211de0` @ 140211de0 | no constant assignments to action-code var |
| `FUN_140225630` @ 140225630 | no action-struct write found (caller may use a different builder path) |
| `FUN_1402230d0` @ 1402230d0 | no action-struct write found (caller may use a different builder path) |
| `FUN_14028c210` @ 14028c210 | no action-struct write found (caller may use a different builder path) |
| `FUN_1402da380` @ 1402da380 | no action-struct write found (caller may use a different builder path) |
| `FUN_1402dc250` @ 1402dc250 | no action-struct write found (caller may use a different builder path) |
| `FUN_14038b530` @ 14038b530 | no action-struct write found (caller may use a different builder path) |
| `FUN_140395eb0` @ 140395eb0 | no action-struct write found (caller may use a different builder path) |
| `FUN_1401f4390` @ 1401f4390 | no action-struct write found (caller may use a different builder path) |

## Addendum 2026-05-21, caller-of-caller walk for the 15 unresolved

Walked one level up to the immediate callers of each of the 15
unresolved emit fns
(`scripts/ghidra/DecodeAxeEditIIIDynamicActionCodes.java`,
output in `samples/captured/decoded/ghidra-axe-edit-iii-dynamic-action-codes-decode.txt`).
The 15 unresolved fall into three structural groups:

### Group A, pass-through helpers (parent passes action code as constant)

The emit fn is a reusable helper that takes the action code as a
function arg. The parent caller chooses a constant. Pattern:

```c
// in parent (e.g. FUN_140253780, caller of FUN_1401e4a90):
local_14 = CONCAT44(*(undefined4 *)(lVar1 + 700), 0x52);  // action 0x52 SET
// ... or ...
local_14 = 0xf;                                            // action 0x0F (new)
FUN_1401e4a90(...);
```

Codes recovered from Group A parents:

| Code | Where found | Notes |
|---:|---|---|
| `0x52` | FUN_140253780 → FUN_1401e4a90 (`DynaCabControl` writes) | Known SET (already in fn01-decode.md) |
| `0x0F` | FUN_140253780 → FUN_1401e4a90 (alternate branch) | **NEW**: alternate "dynacab" action when param_3 != 0 |
| `0x01` | FUN_1402a5cf0 → FUN_1401e4be0 (`AxeManageDialog` write) | Already in extracted table (long broadcast variant) |

### Group B, UI broadcast iteration (action code is data, not code)

The emit fn iterates over an array of UI control structs. Each
control carries its own action code as a struct field. Example
(FUN_1401e3310):

```c
do {
    if ((uVar2 != 0) && (*(longlong *)(puVar5 + 2) == 0)) {
        **(undefined4 **)(param_1 + 0x40) = *puVar5;  // action code from UI struct field
        // ...
        FUN_14033ec70(...);
    }
    puVar5 = puVar5 + 10;
} while (iVar6 < 2);
```

These emit MANY different action codes at runtime, one per UI
control. Static analysis cannot enumerate them, they're populated
in the UI control init code (likely the dialog/panel constructor
that registers each knob with its wire action code). Full
enumeration needs a hardware capture pass with the agent watching
the wire while AxeEdit III walks through each UI panel.

Callers in this group:
- `FUN_1401e3310`, `FUN_1401e6bd0`, UI control broadcast loops
- `FUN_140228410` (24 indirect callers): generic UI emit helper
- `FUN_140225630`, `FUN_1402230d0`, block-editor UI helpers
- `FUN_1402113c0`, `FUN_140211de0`, preset-list UI helpers

### Group C, virtual dispatch (action code on receiving object)

The emit fn is reached via a virtual call; the action code is a
member of the polymorphic operation object. Example caller
(FUN_1402a5cf0):

```c
local_28 = 0x720001;  // packed (action14, blockId14)
local_24 = 9;
local_20 = 0;
(**(code **)(param_1[0x2c] + 0x98))(param_1 + 0x2c, &local_28, 0, 0);
```

Codes recovered from Group C virtual call sites generally match the
codes already in the table above (0x01 is the most common). Full
enumeration would require walking every class whose vtable slot
0x98 dispatches to one of the unresolved emit fns, substantial
Ghidra work for a likely-low-yield result.

### Conclusion

The 42 codes already extracted by the parser cover the **static**
action-code vocabulary. The 15 unresolved sites contribute:

- **1 new code (`0x0F`)** from Group A pass-through helpers
- **Group B & C** add runtime-determined codes that can only be
  enumerated by USBPcap watching AxeEdit III emit each UI action
  in turn (beta-user capture, not a Ghidra task)

Updated unique-code count: **43** (was 42).

## Source

- Decompile dump: `samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt`
- Generator: `scripts/ghidra/MineAxeEditIIIActionsAndShapes.java`
- Parser: `scripts/axe-fx-iii/parse-fn01-action-codes.ts`
- Caller-walk dump: `samples/captured/decoded/ghidra-axe-edit-iii-dynamic-action-codes-decode.txt`
- Caller-walk script: `scripts/ghidra/DecodeAxeEditIIIDynamicActionCodes.java`
- Builder wire shape: [`fn01-builder-ghidra.md`](fn01-builder-ghidra.md)
- Empirical (capture-side): [`fn01-decode.md`](fn01-decode.md)

Re-run via: `npx tsx scripts/axe-fx-iii/parse-fn01-action-codes.ts > docs/devices/axe-fx-iii/fn01-action-codes-decoded.md`
