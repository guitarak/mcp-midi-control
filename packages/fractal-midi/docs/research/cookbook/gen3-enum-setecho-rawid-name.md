---
name: gen3-enum-setecho-rawid-name
class: protocol-exchange
status: partial-N1
discovered: 2026-06-04 (capture3 re-decode at offset 5, tester Harp)
verified_on:
  - fm9-fw-11.00
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-gen3-enum-setecho-rawid-name
relates_to: [gen3-enum-label-septet-stream, iii-fn01-set-parameter-envelope]
consumed_in: []
---

# gen-3 typed-SET echo pairs {raw-id → name} (BK-093 write leg)

The gen-3 enum "two-leg" problem: the broadcast/GET wire carries an ORDINAL
that joins the enum vocabulary (read leg), but a typed SET wants a different
RAW enum id (a permutation of the ordinal, not a formula). This entry is the
primitive that recovers the {raw-id → name} table directly from the wire,
closing the write leg without a getBlockString opcode.

## Formal definition

```
OUT  F0 00 01 74 [model] 01 09 00 [eff:14b LE] [pid:14b LE] [raw-id:14b LE @bytes15-16] ... [cs] F7   (23 B)
IN   F0 00 01 74 [model] 01 09 00 [eff:14b LE] [pid:14b LE] ...float(ordinal)... [name septet] [cs] F7  (60 B)
```

- The OUT SET carries the **raw-id** in its value field (bytes 15-16, LE).
- The IN response carries that value's **NAME** in the septet layer
  (byte-5 8→7 unpack, see [[gen3-enum-label-septet-stream]]) and the
  **ordinal** as a float32.

Zip OUT.raw-id with IN.name per (effectId, paramId) ⇒ a {raw-id → name}
row, ready to register as a gen-3 device-true enum table + name→raw-id
resolver.

## Evidence (FM9 fw 11.00, capture3)

| eff | pid | raw-id (OUT) | name (IN septet) |
|---|---|---|---|
| 66 (Reverb) | 10 | 524 | Medium Spring |
| 66 (Reverb) | 10 | 529 | Music Hall |
| 118 (Drive) | 0 | 523 | Blues OD |

Triply corroborated: the septet label, the captured raw-id, and the AM4
ordinal-table name all agree. Reproduced by hand + the `fm9-decode-verify`
workflow.

## Where this does NOT apply

- **Amp (eff=58)**: the SET echo renders the ordinal NUMERICALLY ("65",
  "179"), not as a model name. Amp names must come from the value-list dump
  (`sub=0x2e`, [[gen3-enum-label-septet-stream]]) instead.
- Only values the editor actually SETS produce a pair, so a type-change
  sweep is needed for full per-block coverage. We hold ~3 pairs; the rest
  await a dropdown-open / type-step capture. The untested-wire guard holds:
  register only raw-ids seen in a real SET echo or positional list.
- N=1 axis (FM9 only).

## Refinement history

- 2026-06-04: discovered + `partial-N1`. The 2 reverb pairs are already in
  the `enumRawId` write-leg scaffold; drive lacks a read-leg overlay vocab.
