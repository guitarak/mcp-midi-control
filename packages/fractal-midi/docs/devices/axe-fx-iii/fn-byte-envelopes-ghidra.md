# Axe-Fx III, fn-byte envelope catalog (Ghidra-decoded)

Comprehensive mapping of every AxeEdit III fn-byte caller to its
descriptor table + resulting wire envelope shape. Recovered from
`Axe-Edit III.exe` v1.14.31 via:

- `scripts/ghidra/DumpAxeEditIIIPatchParserDeep.java`
- `scripts/ghidra/DumpAxeEditIIIMiscDescriptors.java`

## Descriptor table convention

Each table is a 12-byte-stride array of `{key, val_b, val_c}` ints
terminated by `key == -1`:

- `key`, field index within the frame (0 = first field, 1 = second, etc.)
- `val_b`, **wire-frame offset** where the field starts (counting
  from `F0` of the SysEx envelope; payload starts at offset 6)
- `val_c`, for the LAST entry (often key=N): **count** of items
  in the variable-length array, OR **byte count** for the count
  field itself

For fields with `val_c=1`, `val_b` is the wire offset of a single
septet (7-bit) value. For 2-byte counts (`val_c=2` at key=0), the
field is a 14-bit septet pair.

## fn-byte → descriptor table → wire envelope summary

| fn | Caller | Descriptor table | Fields (key, val_b, val_c) | Wire envelope shape |
|---|---|---|---|---|
| 0x01 | `FUN_14033ec70` | (none, bespoke builder) | n/a | 6-field fixed builder; see `fn01-builder-ghidra.md` |
| 0x03 | `FUN_14033bee0` | `0x1407ab330`, `0x1407abad0` | (0,6,1)(1,7,1)(2,8,1) | 3-byte payload, 3 fields |
| 0x12 | `FUN_1401e3fb0`, `FUN_140253360` |, | n/a (1-byte raw payload) | **FS_PASSTHRU_MESSAGE**: 9-byte wire, 1-byte status (see `fn12-fs-passthru-decoded.md`) |
| 0x19 | `FUN_14033c6e0` | `0x1407abb00`, `0x1407ab490`, `0x1407ab590` | multi-table | FOOTSWITCH-adjacent |
| 0x1A | `FUN_14033ce70` |, | n/a | 3-byte payload |
| 0x1B | `FUN_140211fe0` | `0x1407ab560` | (0,6,1)(1,7,1) | 2-byte payload |
| 0x1F | `FUN_140339ed0` | `0x1407ab850` | (0,6,2) | **2-byte payload** (single 14-bit value) |
| 0x3F | `FUN_140336dd0` | `0x1407ab8b0` | (0,6,2)(1,8,31) | 14-bit header + 31×1B array = 33 bytes |
| **0x40** | `FUN_140337060` | `0x1407ab2f0` | (0,6,1)(1,7,1) | 2-byte payload, **LOAD/SELECT PRESET** (NOT STORE BEGIN, see `fn40-load-preset-decoded.md`); community RE was wrong |
| **0x46** | `FUN_140333350` | `0x1407abad0` | (0,6,1)(1,7,1) | **2-byte payload, DSP_MESSAGE candidate** |
| 0x47 | `FUN_140150400`, `FUN_14015d6f0` |, | n/a (paramless) | 0-byte payload INIT |
| 0x5A | `FUN_140328a10`, `FUN_1401a1a20` |, | n/a | toggle-pair with 0x7A |
| 0x5B | `FUN_1403359b0` |, | n/a | toggle-pair with 0x7B |
| 0x5C | `FUN_140328a10` |, | n/a | toggle-pair with 0x7C |
| 0x74 | `FUN_140338fb0` | `0x1407aaca0` (legacy), `0x1407aaf00` (modern) | (0,6,2)(1,8,2)(2,10,1) | **EFFECT_DUMP START**: 5 wire bytes header |
| 0x75 | `FUN_140339c40` | `0x1407ab440` (legacy 768), `0x1407aba40` (modern 192) | (0,6,2)(1,8,3072 or 768) | **EFFECT_DUMP DATA**: header + N×3-byte cells |
| 0x76 | `FUN_1401e7a70`, `FUN_14021ce90`, `FUN_14021e300` |, | n/a | **EFFECT_DUMP END**: empty payload |
| **0x77** | 4 callers (incl `FUN_14014d2a0`) | `0x1407ab680` (legacy), `0x1407aac70` (modern) | (0,6,1)(1,7,1)(2,8,2 or 3) | **PRESET_DUMP HEADER**: 3-field header |
| 0x78 | `FUN_14033ae30` | `0x1407aacd0` (legacy 192), `0x1407ab940` (modern **3072**) | (0,6,2)(1,8,N) | **PRESET_DUMP CHUNK**: see `preset-dump-decoded.md` |
| 0x79 | `FUN_14033ac00` | `0x1407ab020` | (0,6,3) | **PRESET_DUMP FOOTER**: 3-byte checksum |
| 0x7A | `FUN_140336060`, `FUN_1401a1a20` | `0x1407abb60`, `0x1407aba00`, `0x1407ab410` | multi-table | toggle-pair with 0x5A |
| 0x7B | `FUN_140335000` | `0x1407ab0a0` (1280), `0x1407ab910` (160) | (0,6,2)(1,8,N) | toggle-pair with 0x5B; **FOOTSWITCH_DATA**? |
| 0x7C | `FUN_140335370` | `0x1407aba70` | (0,6,5) | 5-byte payload; toggle-pair with 0x5C |

## Headline closures from this catalog

###  (DSP-meter decode): partial closure

**Hypothesis confirmed: fn=0x46 is the DSP_MESSAGE query envelope.**

- Caller `FUN_140333350` emits a **2-byte payload** with descriptor
  table `0x1407abad0` declaring `(key=0, val_b=6, val_c=1)` + `(key=1,
  val_b=7, val_c=1)`.
- Wire envelope: `F0 00 01 74 10 46 [byte0] [byte1] [cksum] F7` =
  10 bytes total.
- The builder writes bytes as `0x7F >> shift` (decreasing pattern),
  which is consistent with a query envelope that doesn't carry value
  data, just a "request DSP usage" request.

**To close  fully** (verify direction + response shape):
1. USBPcap AxeEdit III while CPU% display updates. A 10-byte query
   ticking at ~10 Hz with `F0 00 01 74 10 46 ...` is the fn=0x46
   request signature.
2. Examine the device's RESPONSE, likely a different fn-byte (maybe
   the 0x64 ACK with the DSP percent in the payload, or fn=0x46 as a
   bidirectional setget). Hardware capture is the only way to know.

Estimated effort: 2-min capture + ~30-min response decode.

###  (III routing-matrix): strengthened

The 0x74/0x75/0x76 EFFECT_DUMP family declarations gained precision:

- `0x74` (START) uses `(0,6,2)(1,8,2)(2,10,1)` → **5-byte payload**
  (2 + 2 + 1 wire bytes). NOT the 768-byte payload I previously
  hypothesized, that 768 belongs to the 0x75 DATA frame.
- `0x75` (DATA) uses `(0,6,2)(1,8,3072 or 768)` → modern 3072 / legacy
  768 item count. With each item = 3 wire bytes, that's up to 9216 or
  2304 wire bytes per chunk.

Hardware capture of an actual EFFECT_DUMP write would confirm whether
the III chunks split across multiple 0x75 frames (per the larger 3072
count) or all fit in one (smaller payloads).

### fn=0x40, LOAD/SELECT PRESET (NOT STORE, correction)

**Initial hypothesis (STORE_PRESET BEGIN) is wrong.** Tracing the
save-workflow caller `FUN_14014d400` (the AxeEdit III "Save Preset"
UI handler, identifiable by its embedded "permanently overwrite ...
presets in your ..." dialog string) shows it calls `FUN_14014d2a0`
(the fn=0x77 PRESET_DUMP HEADER emitter) directly with **no fn=0x40
emit anywhere in the chain**.

fn=0x40 is emitted by `FUN_1402990d0` (entry point) which takes a
single `byte presetNum` and allocates a 3000-byte inbound buffer
before sending, consistent with **LOAD PRESET REQUEST**: "device,
send me preset N".

The III's actual STORE_PRESET workflow has **no separate BEGIN
marker**: target preset is encoded in the fn=0x77 PRESET_DUMP_HEADER.
See `fn40-load-preset-decoded.md` for the full chain.

### fn=0x1F, fn=0x3F, tiny query envelopes

Both single-callers with very short payloads (2 and 33 bytes
respectively). Likely UI-state queries that the agent doesn't need
unless we're building an exhaustive III mirror.

## Pattern: every III wire envelope is septet-packed

Across 20+ descriptor tables, the val_b values are always in the set
`{6, 7, 8, 10}`, meaning every wire field starts at a small wire
offset and packs into 1-3 septet bytes. There is **no compression**
in any III wire envelope we've decompiled, neither in the PATCH_DUMP
path nor in any other fn-byte caller. Forum #159885's "Huffman" claim
applies to a different envelope (possibly the firmware's internal
preset storage, not the wire), or is simply wrong about the III.

## Source artifacts

- `samples/captured/decoded/ghidra-axe-edit-iii-misc-descriptors.txt`
, full per-caller table reference + table contents
- `samples/captured/decoded/ghidra-axe-edit-iii-patch-parsers.txt`
, PATCH_DUMP receiver + per-frame parsers
- `samples/captured/decoded/ghidra-axe-edit-iii-preset-receiver.txt`
, receiver dispatcher candidate ranking
- `samples/captured/decoded/ghidra-axe-edit-iii-sysex-xref-attempt.txt`
, SYSEX_* name xref negative result (H1+H2+H3 all returned 0)

---

## Addendum 2026-05-21, device-discovery family (fn=0x00 / 0x08 / 0x47 / 0xFF)

The precise host-emit scan surfaced four undocumented fn-bytes on the
III's host-emit list, none of them in the 44-workflow Rosetta Stone.
Decompiling the emit functions (`scripts/ghidra/DecodeAxeEditIIINewFnBytes.java`)
shows they are all **paramless queries forming the device-discovery
handshake sequence**.

### The discovery state machine (FUN_1401f4390)

`FUN_1401f4390` is a per-step state machine driven by a switch on
an internal step counter. Each case emits one frame:

```c
case 5:  FUN_1403437d0(&local_208, 0x00, 0, 0, 0x7F);          // ping all
case 6:  FUN_1403437d0(&local_208, 0x08, 0, 0, bVar2);         // identify model
case 7:  // build response struct ... (no emit)
case 8:  FUN_1403437d0(&local_208, 0x47, 0, 0, DAT_1412633f8); // INIT
```

Each step waits for a device response (`FUN_1401f42e0` with a per-step
timeout) before advancing. Step 6's `bVar2` is the model byte just
discovered from step 5's broadcast. Step 8 uses the now-known model
byte from the global `DAT_1412633f8` (which step 6 writes).

### Per-fn-byte decode

| fn | Payload | Model byte | Role |
|---|---|---|---|
| `0x00` | empty | `0x7F` (broadcast) | **DEVICE PING**: "any Fractal device respond". Step 5 of discovery. Wire: `F0 00 01 74 7F 00 [cs] F7`. |
| `0x08` | empty | per-device (e.g. `0x10` for III) | **MODEL IDENTIFY**: "are you device X?" handshake. Step 6 of discovery. Wire: `F0 00 01 74 10 08 [cs] F7`. |
| `0x43` | empty | III's `DAT_1412633f8` | **LIBRARY / BUNDLE QUERY**: emitted from `case 0xb` of `FUN_14014bcd0` (preset-bundle export). Nearby strings: `"Bank %c, patch %d (%d of %d)"`, `"System + Global Blocks + FC"`. Likely "begin bundle export session". Wire: `F0 00 01 74 10 43 [cs] F7`. |
| `0x47` | empty | III's model | **INIT / SESSION START**: already known; closing the loop |
| `0xFF` | caller-supplied byte | caller-supplied | **CROSS-MODEL DISCOVERY**: single emit in `FUN_14033db70`, called from a multi-device aggregator in `FUN_1401a1a20`. Pattern is `FUN_1403434b0(buf, 0xFF, model_byte, payload)`, i.e. fn=0xFF acts as a discovery probe with the model byte set by the caller, used to enumerate devices across model bytes. The aggregator collects each responding device into a list. |

### Why these weren't in the workflow catalog

The 44-workflow Rosetta Stone is recovered from `FUN_1401f0f10`, which
registers *named* workflows that the inbound-dispatcher state machine
subscribes to. The discovery sequence above is one level BELOW that, it runs before any workflow is registered (because workflow
registration depends on knowing what device is attached). So these
bytes appear in the host-emit vocabulary but not in any named
workflow.

### Implications for MCP integration

`fn=0x08` is the cheapest "is this III actually here / alive" ping
the III editor uses. The MCP could use the same pattern for liveness
checks, a 4-byte paramless query that's cheaper than fn=0x46
(2-byte payload + version response) for cases where we only want
presence detection, not version info.

`fn=0x43` is plausibly "send me your library catalog", a precondition
to the bundle-export flow. If we want a `list_user_cabs` or
`list_library_presets` tool that doesn't need to traverse each
preset's PRESET_DUMP, this is the candidate envelope. Needs one
hardware capture to confirm the response payload shape.

`fn=0x00` and `fn=0xFF` are mostly diagnostic, useful if we ever
need to multiplex MCP control across an Axe-Fx III + FM3 + FM9 chain
on the same USB hub, but not on the path to baseline III control.

### Source

- `samples/captured/decoded/ghidra-axe-edit-iii-new-fnbytes-decode.txt`
- `scripts/ghidra/DecodeAxeEditIIINewFnBytes.java`
- `scripts/ghidra/run-axeedit3-new-fnbytes.cmd`
