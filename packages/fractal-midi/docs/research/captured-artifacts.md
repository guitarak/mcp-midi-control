# Captured Artifacts, Public Manifest

Organized by **decode purpose**, not by session ID. This is the public
half of the captured-artifacts manifest, forum captures, third-party
public captures, and non-sensitive probe outputs that ship with the
OSS repo. Founder-private artifacts (decompile dumps, founder USB
captures, factory `.syx` files) live in the consumer repo's
founder-private captured-artifacts manifest (gitignored).

Both files share the same five-class schema (a, e). The public file
omits the sensitive entries; the private file has the full set.

The **artifact bytes themselves are gitignored** in both repos'
`samples/captured/` directories. Only the manifest text, what exists
+ what's been mined, is committed.

---

## How to use this manifest

Before proposing a new capture or Ghidra run, scan the relevant
section. If an artifact already exists with un-mined material:

1. Open the artifact (or its decode in the private dump corpus).
2. Apply the relevant cookbook primitive(s) from `cookbook/INDEX.md`
, most decode work is "apply a known primitive to new bytes."
3. Write or extend a TS parser script in `scripts/_research/` that
   extracts the cookbook-relevant payload.
4. Register your findings: refine cookbook entries (with new
   fixtures), file new entries if they're genuinely new primitives.

If no existing artifact applies, then propose the new capture. Always
file `[hardware-task]` or `[capture-needed]` follow-ups in the
relevant device's `STATE-<DEVICE>.md` rather than blocking the
session.

---

## d. Public / forum / third-party captures

Provenance from outside our hardware. We don't control the conditions,
so the "one input per capture" rule may not hold. Value: cross-
validation against decoded behavior + decode confirmation for devices
we don't own.

### Axe-Fx III SET_PARAMETER captures (10 captures)
- **Source**: FC-12 controller public capture + a Mountain Utilities
  forum thread (2019)
- **Locks**: III fn=0x01 SET_PARAMETER wire shape (pivot from initial
  fn=0x02 hypothesis)
- **Captures archived inline** in
  [`docs/devices/axe-fx-iii/set-parameter-captures.md`](../devices/axe-fx-iii/set-parameter-captures.md)
- **Cookbook**: applies [[../research/cookbook/septet-14bit]] for
  paramId encoding; sub-action codes still un-mined (one row per
  caller body in the III decompile)
- **Status**: ✅ wire shape locked

### Axe-Fx III preset format research (community RE)
- **Source**: Fractal Forum community RE thread #159885
- **Hypothesis**: III preset binary body uses Huffman codebook compression
- **Status**: 🟡 not byte-verified against device. Lives in
  `cookbook/_scratch/iii-preset-huffman-codebook.md` pending hardware
  verification.
- **Synthesis pass 2026-05-22 finding**: the III envelope wrapper is
  byte-identical to II (descriptor tables at `0x1407ab440` +
  `0x1407aba40` match II's `0xe04440` + `0xdff900` shape, see
  [[../research/cookbook/vendor-envelope-descriptor-table]]). The
  Huffman hypothesis is about the BODY content; the envelope is
  decodable from existing dumps without hardware.

### Independent III MCP cross-reference
- **Source**: forum thread #219503; independent OSS author building a
  parallel III MCP
- **Status**: 🟡 monitor for cross-validation; no merged findings yet
- **Cookbook**: may surface III analogs of II primitives if their
  decode work overlaps

### General purpose: any Fractal envelope from a third party
- Apply [[../research/cookbook/xor-7f-envelope-checksum]], universal
  Fractal envelope checksum across II, III, AM4.
- Apply [[../research/cookbook/septet-14bit]] for any 14-bit field.
- Apply [[../research/cookbook/msb-first-14bit-preset-payload]] for
  preset-number REPLY payloads (LSB-first vs MSB-first easy to confuse).

---

## e. Probe-script-generated captures + decode outputs (non-sensitive subset)

Captures produced by our own probe scripts (`scripts/_research/probe-*.ts`)
+ the decode JSONs/tables they emit. The subset listed here is
publishable, output that doesn't reveal device-serial / firmware-
specific fingerprints. The full set lives in the founder-private
manifest.

### probe-axefx2-enum-dump output
- **Producer**: `scripts/_research/probe-axefx2-enum-dump.ts`
- **Output (gitignored)**: `samples/captured/probe-axefx2-enum-dump-findings.md`
  + `.syx`
- **Contents**: every Axe-Fx II enum table dumped via fn 0x28 (device-
  emitted labels). 145 probes, 1112 strings captured, 1/145
  truncated (amp.effect_type, node-midi 2048-byte cap)
- **Mined**: 54 ENUM_VALUE_OVERRIDES + 4 wiki transcription
  corrections (CORNCOB → CORNFED) shipped in fractal-midi.
  Re-running probe against shipped catalog: 0 mismatches after
  trim-tolerant comparison.
- **Un-mined**: nothing, fully consumed.
- **Cookbook**: [[../research/cookbook/fn28-enum-dump]] +
  [[../research/cookbook/trim-tolerant-display-match]]

---

## a, c. Founder-private artifact classes (manifest location)

These sections live in the consumer repo's founder-private manifest
(gitignored):

- **(a) Decompile dumps + binary extracts**: Ghidra output from
  AxeEdit, AM4-Edit, AxeEdit III binaries. ~30 files totaling ~4.3 MB
  per the synthesis pass 2026-05-22 inventory. **The III preset binary
  envelope spec is sitting decoded in
  `ghidra-axe-edit-iii-dump-descriptors.txt` (lines 7-23): byte-
  identical shape to the II envelope spec recently decoded via hardware
  probes.** A 100-line TS parser closes that without hardware.
- **(b) USBpcap + Wireshark captures (.pcapng)**: founder USB
  captures of editor → device write paths
- **(c) Factory default .syx + reference dumps**: vendor-provided or
  founder-saved baseline state, used for cross-validation + byte-diff
  baselines

OSS contributors won't have access to (a)/(b)/(c). The narrative + the
cookbook primitives the decompiles supported are public; the raw
bytes are not. See `AGENTS.md` § "Decompile-derived contributions" for
the contributor IP rule.

---

## Adding to this manifest

When a new public capture, third-party reference, or non-sensitive
probe output is acquired or generated, register it in the same
session in this file. Manifest entries link to the doc that interprets
the artifact, not the other way around, so when a doc is refactored,
the manifest stays correct.

Cookbook entries that cite an artifact use the relative path from
this file when possible.
