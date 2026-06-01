# Axe-Fx III, PATCH_DUMP wire format (Ghidra-decoded)

**Status:** wire format fully decoded. III preset-dump uses **the same
septet-packed native ushort encoding as Axe-Fx II**: NOT Huffman
compression as Forum #159885 community RE claimed.

## TL;DR

The III's 0x77/0x78/0x79 PATCH_DUMP envelope is byte-shape identical
to II's. The chunk parser, descriptor tables, and per-frame layout
all match within constant factors:

- Receiver dispatcher: `FUN_14022ef30` (III) ⟷ `FUN_00512f30` (II)
- 0x77 header parser:  `FUN_14033aa20` (III) ⟷ `FUN_0054d3d0` (II)
- 0x78 chunk parser:   `FUN_14033a780` (III) ⟷ `FUN_0054d0c0` (II)
- 0x79 footer:         inline checksum verify in receiver (both)
- Descriptor tables:   literally identical entries (see below)

This means **everything we learned about the II preset binary native
encoding applies directly to the III**:

- 64 chunks × N ushorts per chunk (≈64 for factory) = ~4096 native ushorts per preset
- Each ushort = 3 wire bytes via septet packing
- Per-chunk **14-bit count** at payload bytes 0..1 (low+high septets, descriptor key=0, val_b=6, val_c=2)
- Per-chunk **data** at payload byte 2 = N × 3 wire bytes per ushort (descriptor key=1, val_b=8 = data offset, val_c=3072 = max items)

The III's  analog is solved by porting II's parser with the
model byte swap (II = 0x07 → III = 0x10) and the chunk count check.

## Descriptor tables, III ⟷ II side-by-side

The III's PATCH_DUMP parsers consult tables at `.rdata` 0x1407aac70..
0x1407ab940. The II's equivalent tables are at `.rdata` 0x718090..
0xe04440. Entries are byte-for-byte identical:

| Purpose | II address | III address | Entries `(key, val_b, val_c)` |
|---|---|---|---|
| 0x77 header legacy | 0x718090 | 0x1407aac70 | `(0,6,1)`, `(1,7,1)`, `(2,8,2)` |
| 0x77 header modern | 0x7180c0 | 0x1407aacd0 | `(0,6,2)`, `(1,8,192)` |
| 0x79 footer | 0xdff900 | 0x1407ab020 | `(0,6,3)` |
| 0x78 chunk legacy | 0xe033a0 | 0x1407ab680 | `(0,6,1)`, `(1,7,1)`, `(2,8,3)` |
| 0x78 chunk modern | 0xe04440 | 0x1407ab940 | `(0,6,2)`, `(1,8,3072)` |

The semantic interpretation per  work:
- `key=0` entry, `(val_b=6, val_c=2)` means: at payload byte 0, read
  a 14-bit value spanning 2 wire bytes (the chunk's item-count N).
  The legacy table's `(0,6,1)` reads a 7-bit count instead.
- `key=1` entry, `(val_b=8, val_c=3072)` means: variable-length data
  array starts at payload byte 2 (val_b=8 is wire-frame offset; minus
  the 6-byte envelope = payload offset 2), with up to 3072 items
  total across all chunks. Each item is 3 wire bytes (3 septets) =
  one native ushort.

## III 0x78 PATCH_DATA chunk parser

`FUN_14033a780` from `Axe-Edit III.exe` v1.14.31 (decompiled
verbatim, with C variables renamed for clarity):

```c
char *parsePatchDataChunk(SysExFrame *frame, ushort *outState) {
    if (frame == NULL || outState == NULL) return 0;

    // Pick descriptor table by firmware version. Modern firmware (model
    // byte ≥ 0x10) uses the longer table at 0x1407ab940; the legacy
    // path remains at 0x1407aacd0 for older firmware backward-compat.
    DescriptorEntry *tbl = &DAT_1407ab940;
    if (frame->modelByte < 0x10) tbl = &DAT_1407aacd0;

    if (frame->fnByte == 'x') {  // 0x78 PATCH_DATA
        // Look up key=0: wire offset (val_b=6) + septet-count (val_c=2)
        // for the chunk count. Modern: 14-bit value at payload[0..1].
        DescriptorEntry *e = findKey(tbl, 0);
        ushort count = septetRead(frame, e->val_b, e->val_c & 0xffff);
        *outState = count;

        // Allocate ushort[count] for this chunk's data array.
        reallocUshortArray(&outState[4], count * 2, 1);

        // Look up key=1: data start wire offset (val_b=8) = payload[2].
        int dataOffset = findKey(tbl, 1)->val_b;

        // Decode count × 3-wire-byte septet-packed ushorts.
        long off = dataOffset;
        for (int i = 0; i < count; i++) {
            ushort v =
                ((ushort)(frame->bytes[off + 1] & 0x7F) |
                 (ushort)(frame->bytes[off + 2] << 7))   << 7  |
                 (ushort)(frame->bytes[off] & 0x7F);
            outState[4 + i] = v;
            off += 3;
        }
        return 1;
    }
    return 0;
}
```

Wire byte → native ushort decoder formula (equivalent to II):
```
v = (b0 & 0x7F) | ((b1 & 0x7F) << 7) | ((b2 & 0x7F) << 14)
  // upper bits get truncated to 16 on store via *ushort cast
```

## No compression in the III PATCH_DUMP path

The decompile of `FUN_14022ef30` (receiver), `FUN_14033aa20` (header),
`FUN_14033a780` (chunk), `FUN_140343370` (checksum), and all 1-level
callees shows **zero calls to inflate, zlib, Huffman build/decode, or
any decompression primitive**. Every chunk byte is consumed by the
septet decoder.

The Huffman claim from Fractal Forum thread #159885 community RE may
have been referring to the STORE_PRESET 0x40 envelope (a separate
operation), or to firmware-internal storage. It does NOT apply to the
PATCH_DUMP wire envelope.

## What this unlocks immediately

- **Atomic `get_preset` on the III**, same as II's  atomic-read
  workstream. Send 0x77 request, receive 1 × 0x77 + 64 × 0x78 + 1 ×
  0x79, decode 4096 native ushorts. ~1-2 s round trip.
- **`dump_preset` / `restore_preset` backup tools** for the III with
  byte-identical round-trip. Independent of per-scene decoding.
- **Cross-device parity** for the  `get_preset` family, III
  catches up to II on the wire-shape side without further protocol RE.

## What remains

The per-scene byte offsets inside the III's 4096-ushort native stream
are still TBD, same status as II's . Once  finishes the
II per-scene mapping, the same hardware-paired diff harness applies
to the III (the wire format is identical; only the value semantics
within specific chunks may differ between devices).

The III's STORE_PRESET 0x40 envelope (which Forum #159885 may
genuinely describe with Huffman) is a separate operation and not
covered by this decode.

## Source artifacts

- `scripts/ghidra/DumpAxeEditIIIPresetReceiver.java`, finds dispatcher
- `scripts/ghidra/DumpAxeEditIIIPatchParserDeep.java`, decompiles
  the parser triad + dumps descriptor tables
- `samples/captured/decoded/ghidra-axe-edit-iii-preset-receiver.txt`
- `samples/captured/decoded/ghidra-axe-edit-iii-patch-parsers.txt`
