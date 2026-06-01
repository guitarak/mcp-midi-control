---
name: juce-binarydata-zip
class: label-extraction
status: matched
discovered:  (replaced WinDbg dead-end with JUCE BinaryData ZIP path)
verified_on:
  - am4-edit-binary
  - axe-edit-iii-binary
firmware_sensitive: false
golden: scripts/cookbook-verify.ts#case-juce-binarydata-zip
relates_to: [param-descriptor-16byte]
consumed_in:
  - scripts/_research/extract-exe-strings.ts
  - scripts/_research/extract-xml-from-dump.ts
  - scripts/_research/mine-axeedit3-xml-labels.ts
---

# JUCE BinaryData ZIP extraction

JUCE-based editor binaries (AM4-Edit, AxeEdit, AxeEdit III) embed their
resource files as a ZIP archive inside the `BinaryData` static. Label
extraction takes 5 minutes via standard ZIP tooling — no debugger
attachment, no runtime instrumentation.

## Formal definition

The JUCE framework generates `BinaryData::namedResource` static arrays
at compile time. The named resources are typically a ZIP archive
containing XML, image, and string-table resources. The archive can be
located in the binary by:

1. Search for the ZIP central-directory signature `0x06054b50` in the
   binary.
2. Walk backward to the local-file-header signature `0x04034b50`.
3. Extract the ZIP from offset to offset+sizeof(zip) using any standard
   ZIP library.

The resulting archive contains files like `__block_layout.xml` (the
parameterName + displayLabel + controlType registry) and
`__amp_layout.xml`.

## Where it's used

- AM4-Edit binary: 1,299 labels recovered.
- AxeEdit III binary: 10,250 labels recovered. The `__block_layout.xml`
  contains 2,017 III parameterName entries (90.1% catalog coverage)
  with displayLabel + controlType — zero hardware.
- AxeEdit II binary: **transfer candidate** per the cross-device
  protocol. The synthesis pass 2026-05-22 flagged this as untried.
  Expected yield: ~2,500 II parameterName entries with display metadata.

## Applicability

When mining labels for a new vendor binary that uses JUCE, this is the
FIRST method to try (5 minutes vs. ~3 days of WinDbg / Frida / Procmon
investigation that the  baseline took before pivoting).

## Misapplication failure modes

- **DO NOT** assume enum-value labels (amp model names, etc.) are in
  the XML. They aren't — XML carries parameter metadata, not enum
  string tables. Use [[fn28-enum-dump]] for II enum values; III + AM4
  enum value labels are transfer candidates.

## Where it does NOT apply

- Non-JUCE editors (Hydrasynth Editor — uses a different framework).

## Verification path

`scripts/cookbook-verify.ts#case-juce-binarydata-zip` runs against
captured AM4 + III binaries, asserting:
- ZIP signatures locatable at expected offsets
- `__block_layout.xml` parseable
- Known parameterName entries match expected canonical names

## Refinement history

- : WinDbg trap-after-launch, Frida hooks, Procmon traces all
  failed to locate the label loader (stack-frame too shallow, label
  written before trap arms).
- : JUCE BinaryData ZIP path discovered via static
  binary inspection. Immediate success on AM4-Edit. Cookbook entry's
  Refinement history documents the dead-end pivot so future agents
  don't repeat WinDbg.
- Synthesis pass 2026-05-22: AxeEdit II + Hydrasynth Editor flagged
  as untried — transfer candidates filed.
