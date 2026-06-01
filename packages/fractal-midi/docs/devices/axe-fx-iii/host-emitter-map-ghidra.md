# Axe-Fx III, Host emitter direction map (Ghidra-verified)

**Status:** Closure-grade. **Updated 2026-05-21** with precise
data-flow-based fn-byte arg extraction (replaces earlier window-based
scan that had widespread false positives, see Appendix A).

For every CALL to one of the III's two generic SysEx builders
(`FUN_1403434b0`, `FUN_1403437d0`) plus the hardcoded `fn=0x77`
helper (`FUN_14014d2a0`), the fn-byte argument's Varnode is traced
through the decompiler's HighFunction pcode chain. Result: an
emit-site list keyed on the **actually-constant** fn-byte arg.

## Headline counts

- **28 distinct fn-bytes** host-emittable from constants (precise)
- **45 distinct host-side emit functions** call the two generic builders
- **3 emit sites with truly dynamic fn-bytes** (loaded from struct
  fields or function args, not constants at the call site)

The earlier window-based scan claimed 43 host-emittable fn-bytes
across many workflows the III editor doesn't actually emit directly
(`0x10` Save Preset, `0x14` Set Preset Name, `0x15` Change Scene,
`0x18` Swap Scenes, `0x20` Import User Cab (39 false-positive
emitters!), `0x30` Reset Block, `0x31` Move Block, etc.). The
"emitter" claims for those bytes came from window-matched immediate
constants that weren't actually the fn-byte arg of the call, they
were block IDs, scene indices, dialog-mode flags, or paragraph counts.

## Precise host-emit table (single source of truth)

| fn | Emits | Workflow label (from 44-workflow catalog) |
|---:|---:|---|
| `0x00` | 3 |, boilerplate sequence marker / inbound-dispatcher dummy |
| `0x01` | 1 | **SET_PARAMETER**: universal write primitive (see [`fn01-builder-ghidra.md`](fn01-builder-ghidra.md)) |
| `0x03` | 1 | (no workflow label): known to appear in block-list flows |
| `0x04` | 1 | (no workflow label): emitted from `FUN_14014d400` ("Save Preset" UI) |
| `0x08` | 6 | (no workflow label): **new**, not in prior catalog. 6 host-emit sites |
| `0x12` | 2 | **Revert Preset** |
| `0x19` | 1 | **File Snapshot / Export / Get Preset Data** |
| `0x1A` | 1 | **Export User Cab** |
| `0x1B` | 2 | **Import Preset Bundle** |
| `0x1F` | 1 | **Paste Preset (sub)** |
| `0x3F` | 1 | (no workflow label) |
| `0x40` | 1 | **LOAD/SELECT PRESET** (see [`fn40-load-preset-decoded.md`](fn40-load-preset-decoded.md)) |
| `0x43` | 2 | (no workflow label): **new**, not in prior catalog |
| `0x46` | 1 | **Query device version** |
| `0x47` | 4 | **Initialization / Param Definitions (sub)** |
| `0x5A` | 1 | (toggle-pair with `0x7A`) |
| `0x5B` | 1 | (toggle-pair with `0x7B`) |
| `0x5C` | 2 | (toggle-pair with `0x7C`) |
| `0x74` | 1 | **EFFECT_DUMP START** |
| `0x75` | 1 | **EFFECT_DUMP DATA** |
| `0x76` | 4 | **EFFECT_DUMP END** |
| `0x77` | 5 | **PRESET_DUMP HEADER** (2 via hardcoded `FUN_14014d2a0`, 3 via generic builders) |
| `0x78` | 1 | **PRESET_DUMP CHUNK** |
| `0x79` | 1 | **PRESET_DUMP FOOTER** |
| `0x7A` | 1 | (toggle-pair with `0x5A`) |
| `0x7B` | 1 | (toggle-pair with `0x5B`) |
| `0x7C` | 1 | (toggle-pair with `0x5C`) |
| `0xFF` | 1 | (no workflow label): likely sentinel / error-path emit from `FUN_14033db70` |

### Dynamic fn-byte emits (resolved 2026-05-21)

The 3 emit sites that the pcode tracer couldn't resolve to a constant
turned out to use arithmetic-computed fn-bytes, all evaluating to
already-known toggle-pair bytes in the catalog. The tracer simply
didn't model the bit-shift + INT_ADD pattern. No new fn-bytes:

| Caller | Call address | Builder | Computed fn-byte | Resolves to |
|---|---|---|---|---|
| `FUN_14014ced0` | `14014cfc0` | `FUN_1403434b0` | `((char)lVar13 << 5) + 0x5A` | `0x5A` / `0x7A` toggle |
| `FUN_1401a1a20` | `1401a2597` | `FUN_1403434b0` | `(bVar25 ^ 1) * 0x20 + 0x5A` | `0x5A` / `0x7A` toggle |
| `FUN_140335f50` | `140336009` | `FUN_1403437d0` | `CONCAT71(..., 0x5A)` (low byte) | `0x5A` |

These add 3 more emit sites to fn=0x5A / 0x7A's counts but introduce
no new fn-byte vocabulary. The closure script
`scripts/ghidra/DecodeAxeEditIIIDynamicEmits.java` produced the
arithmetic decompiles in `samples/captured/decoded/ghidra-axe-edit-iii-dynamic-emits-decode.txt`.

**No truly dynamic emit sites remain**: the III's complete host-emit
vocabulary is the 28 fn-bytes in the table above.

## What this changes about the III protocol model

### Block-state edits are uniformly fn=0x01 SET_PARAMETER

The earlier map's "host emits fn=0x30 Reset Block / 0x31 Move Block /
0x32 Swap Blocks" claims are **false positives**. All block-state
edits flow through fn=0x01 SET_PARAMETER (Field A action codes
documented in [`fn01-action-codes-decoded.md`](fn01-action-codes-decoded.md)).
The device's fn=0x2A-0x37 broadcasts are confirmation/echo events
the host SUBSCRIBES to, not opcodes it EMITS.

This is consistent with the existing host-emit count for fn=0x01 (only
1 direct call to `FUN_1403437d0`, via `FUN_14033ec70`, the wrapper
that handles the 6-field SET_PARAMETER payload internally). The 93
fn=0x01 callers all go through that wrapper, not the generic builders.

### Preset / scene management is split between PRESET_DUMP and dedicated bytes

- **Read/write whole preset** → `fn=0x77`/`0x78`/`0x79` PRESET_DUMP
  (5 host-emit sites for 0x77 alone)
- **Switch preset** → `fn=0x40` LOAD/SELECT
- **Revert in-buffer changes** → `fn=0x12`
- **Save Preset / Set Preset Name / Change Scene**: host does NOT
  emit a dedicated fn-byte. The host stages changes via PRESET_DUMP
  and SET_PARAMETER, then the device broadcasts the resulting
  fn=0x10 / 0x14 / 0x15 on completion. The agent SUBSCRIBES to these
  for confirmation, doesn't EMIT them.

### Initialization handshake is heavier than expected

- `fn=0x47` has **4 host-emit sites**: substantially more than a
  one-shot INIT/SESSION_START would need. Suggests the III editor
  re-emits 0x47 for parameter-definition queries, name refreshes,
  or library scans, all keyed on the same session-start fn-byte.
- `fn=0x08` has **6 host-emit sites**: entirely new, not in the
  prior catalog. Possibly a query/poll opcode (the spec PDF lists 0x08
  as part of a query-device-version cluster).

### File I/O is one-shot per fn-byte

- `fn=0x1A` Export User Cab, 1 emit
- `fn=0x1B` Import Preset Bundle, 2 emits
- `fn=0x19` File Snapshot, 1 emit (the prior map's claim of
  "multiple workflows distinguished by sub-action" still holds for
  the SINGLE emit site's payload, but there's no second emitter)

### Effect dump (fn=0x74/0x75/0x76) emits in expected ratio

- 1× START, 1× DATA, 4× END, consistent with an UNSOLICITED EFFECT_DUMP
  flow that can terminate from multiple code paths.

## Implications for the unified MCP surface

The clean fn-byte vocabulary makes the III's wire surface significantly
smaller than the v1.4 PDF (or the workflow catalog) suggests:

| Operation | Wire envelope | MCP unified verb |
|---|---|---|
| Read whole preset | fn=0x77 → fn=0x78 (N) → fn=0x79 | `get_preset` |
| Write whole preset | host-emit fn=0x77 → fn=0x78 (N) → fn=0x79 | `save_to_location` / `apply_preset` |
| Switch preset | fn=0x40 | `switch_preset` |
| Revert buffer | fn=0x12 | `revert_preset` |
| Set any param | fn=0x01 + action code | `set_param`, `set_bypass`, `set_channel`, `set_routing` |
| Subscribe to state | inbound fn=0x2A-0x37 (device-initiated) | `listen_state(port)` |
| Query device | fn=0x46 | `describe_device` |
| Session start | fn=0x47 | (handshake, agent-invisible) |

Everything else in the workflow catalog (Save Preset / Move Block /
Bypass Block / etc.) is **inbound observation**, not outbound action.
The agent learns these happened by listening; it doesn't emit them.

## Appendix A, comparison with prior window-based map

The earlier [`MapAxeEditIIIHostEmitters.java`](../../scripts/ghidra/MapAxeEditIIIHostEmitters.java)
used a 14-instruction lookback window: for every CALL to a builder, it
scanned the prior 14 instructions for any byte literal matching a known
fn-byte and attributed the call to that byte. This had widespread false
positives because emit functions commonly contain block IDs, scene
indices, dialog-mode flags, and paragraph counts in the same byte range
as the fn-byte vocabulary.

Confirmed false-positive examples (window-based claim vs precise data-flow):

| fn | Window-based claim | Precise data-flow | Likely false-positive source |
|---:|---:|---:|---|
| `0x10` | 1 emit (Save Preset) | 0 emits | `0x10` appears as a magic / dialog mode constant near the save flow |
| `0x14` | 1 emit (Set Preset Name) | 0 emits | `0x14` is a small enum |
| `0x15` | 2 emits (Change Scene) | 0 emits | `0x15` is `scene index` or `block id` constant |
| `0x18` | 2 emits (Swap Scenes) | 0 emits | `0x18` is `block size` constant |
| `0x1C` | 2 emits (Export Preset Bundle) | 0 emits | `0x1C` is a string-table offset |
| `0x20` | **39 emits** (Import User Cab) | 0 emits | `0x20` = ASCII space; pervasive immediate. Single largest false-positive source |
| `0x22` | 1 emit | 0 emits | `0x22` = `"`; appears in format strings near calls |
| `0x24` | 1 emit | 0 emits | `0x24` = `$`; pervasive |
| `0x28` | 1 emit | 0 emits | `0x28` = `(`; pervasive |
| `0x30` | 6 emits (Reset Block) | 0 emits | `0x30` = ASCII `0`; appears everywhere |
| `0x31` | 1 emit (Move Block) | 0 emits | `0x31` = ASCII `1`; pervasive |

The precise count is reliable because it follows the actual fn-byte
Varnode (the second positional arg to the generic builders) through
COPY / CAST / INT_ZEXT / INT_SEXT / INT_AND / MULTIEQUAL pcode ops
to find its constant origin.

## Source

- `samples/captured/decoded/ghidra-axe-edit-iii-host-emitters-precise.txt`
- `scripts/ghidra/PreciseAxeEditIIIHostEmitters.java`
- `scripts/ghidra/run-axeedit3-precise-host-emitters.cmd`

Earlier (superseded) work:
- `samples/captured/decoded/ghidra-axe-edit-iii-host-emitter-map.txt`
  (kept for diff / forensic reference)
- `scripts/ghidra/MapAxeEditIIIHostEmitters.java` (superseded; do not
  re-run for new findings)
