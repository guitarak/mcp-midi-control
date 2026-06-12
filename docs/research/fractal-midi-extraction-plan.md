# `fractal-midi` extraction plan

> Companion to [`MULTI-DEVICE-ROADMAP.md`](MULTI-DEVICE-ROADMAP.md)
> §"Vendor protocol-package extraction." That doc states the *why* and
> the repo-level shape; this doc is the actionable *how*: per-file moves,
> consumer surface, prerequisites, dev workflow during dual-repo work.
>
> **Status:** PLANNED, not started. Authored as the durable plan to
> revisit when the extraction trigger fires (the project ships polish
> on Axe-Fx II writes plus Hydrasynth patch sends, OR the AM4 surface is
> mature enough that extraction earns its keep without slowing core
> iteration).

## TL;DR

Two public GitHub repos at the end of this work:

1. **`mcp-midi-control`** (this repo): the MCP server, MIDI transport,
   tool registrations, MCP-specific agent guidance. Depends on
   `fractal-midi` as an npm package.
2. **`fractal-midi`** (new): pure data plus pure codec for the Fractal
   product family (AM4, Axe-Fx II, Axe-Fx III, and future FM3 / FM9 /
   VP4). **No MIDI library dependency.** Consumers wire up their own
   transport.

Per-vendor split, not per-device, confirmed in
[`MULTI-DEVICE-ROADMAP.md`](MULTI-DEVICE-ROADMAP.md) §"Two-tier
architecture." `fractal-midi/am4`, `fractal-midi/gen2/axe-fx-ii`,
`fractal-midi/gen3/axe-fx-iii` are subpath exports.

## Naming: `fractal-midi`, not `fractal-protocol`

An early conversation that prompted this doc proposed
`fractal-protocol`; the pre-existing
[`MULTI-DEVICE-ROADMAP.md`](MULTI-DEVICE-ROADMAP.md) already names it
`fractal-midi`. **`fractal-midi` wins** for three reasons:

1. Already documented across the project as the target name (would have
   to flip the roadmap, the decision log, and the project announcement
   if we changed it).
2. Search and discovery: guitarists and tool authors search "fractal
   midi library," not "fractal protocol library."
3. Consistent with the planned siblings (`asm-midi`, `roland-midi`) per
   the same roadmap doc.

`fractal-rosetta` was a strong alternative that ties to the RE story
but doesn't survive the consistency test against `asm-midi` /
`roland-midi`. Park it as a marketing/story phrase, not the package
name.

## Scope decision: codec only, no MIDI dependency

**`fractal-midi` ships JSON tables plus pure-TS codec only. It does NOT
depend on `node-midi` or any other MIDI library.** Callers route bytes
through whatever transport they prefer.

Tradeoff: codec-only maximizes audience. DAW plugins (JUCE/Rust/Swift),
mobile editors, browser tools, and Python wrappers via FFI/transpile
can all consume `fractal-midi` without a Node native build. Bundling
`node-midi` would give a turnkey Node experience but lock out the ~80%
of realistic consumers who aren't writing Node CLIs.

The convenience layer (a `fractal-midi-node` helper that bundles
`node-midi` plus safe-edit gates) is **deferred**. Re-evaluate if real
consumers ask for it; do not preemptively ship.

## Boundary: per-file move plan

Tested against the current `packages/` layout. Files marked **MOVE**
go to `fractal-midi`; files marked **STAY** remain in
`mcp-midi-control`.

### `packages/core/src/` (cross-cutting)

| File / dir | Disposition | Notes |
|---|---|---|
| `core/src/fractal-shared/checksum.ts` | **MOVE** → `fractal-midi/shared/` | Pure XOR-and-mask |
| `core/src/fractal-shared/packValue.ts` | **MOVE** → `fractal-midi/shared/` | Septet pack/unpack, packed-float |
| `core/src/fractal-shared/device.ts` | **MOVE** → `fractal-midi/shared/` | Vendor-shared device-type primitives |
| `core/src/fractal-shared/types.ts` | **MOVE** → `fractal-midi/shared/` | Vendor-shared TS types |
| `core/src/fractal-shared/lineage/` | **MOVE** → `fractal-midi/shared/lineage/` | JSON data: the OSS crown jewel for amp/cab tone authors |
| `core/src/fractal-shared/lineageLookup.ts` | **MOVE** → `fractal-midi/shared/` | Pure-data lookup engine |
| `core/src/protocol-generic/` | **STAY** | MCP-coupled (DeviceDescriptor + dispatcher + unified tools) |
| `core/src/server-shared/` | **STAY** | MCP-coupled (bufferDirty, safeEdit gates, connection mgmt) |
| `core/src/midi/` | **STAY** | node-midi transport + SysEx assembler |
| `core/src/types/` | **STAY** | MCP-shared types |

### `packages/am4/src/` (highest-value MOVE candidates)

| File / dir | Disposition | Notes |
|---|---|---|
| `params.ts`, `paramNames.ts`, `paramNamesGenerated.ts` | **MOVE** → `fractal-midi/am4/` | Parameter dictionary: crown jewel |
| `blockTypes.ts` | **MOVE** → `fractal-midi/am4/` | Block type table + enum |
| `setParam.ts` | **MOVE** → `fractal-midi/am4/` | Wire-byte builder (pure) |
| `locations.ts` | **MOVE** → `fractal-midi/am4/` | A01 to Z04 parsing |
| `applicability.ts`, `typeApplicability.ts` | **MOVE** → `fractal-midi/am4/` | Type/applicability tables |
| `cacheParams.ts`, `cacheEnums.ts` | **MOVE** → `fractal-midi/am4/` | RE-derived data |
| `editorControlLabels.ts` | **MOVE** → `fractal-midi/am4/` | JUCE BinaryData mining output |
| `factoryBank.ts` | **MOVE** → `fractal-midi/am4/` | Factory bank data |
| `symbolicIds.ts` | **MOVE** → `fractal-midi/am4/` | Symbolic ID table |
| `variantResolverTables.ts` | **MOVE** → `fractal-midi/am4/` | Variant resolver data |
| `parameterBridge.ts` | **MOVE** → `fractal-midi/am4/` | Display↔wire bridge (pure) |
| `descriptor/schema.ts`, `descriptor/reader.ts`, `descriptor/writer.ts` | **MOVE** → `fractal-midi/am4/descriptor/` | DeviceDescriptor data + adapters (pure) |
| `descriptor/agentGuidance.ts` | **STAY** | MCP-flavored agent prompt text |
| `descriptor.ts` (top-level) | **SPLIT** | Data part moves; the MCP-registration wrapper stays |
| `ir/preset.ts`, `ir/transpile.ts` | **MOVE** → `fractal-midi/am4/ir/` | Preset IR: useful to any AM4 tool, not just MCP |
| `bufferFingerprint.ts` | **SPLIT** | Pure hash + diff logic moves; the gate that invokes node-midi stays |
| `shared/channels.ts`, `shared/paramHelpers.ts` | **MOVE** → `fractal-midi/am4/` | Pure helpers |
| `shared/readOps.ts`, `shared/wireOps.ts` | **STAY** | MIDI-coupled (read/write ops over a connection) |
| `presetDump.ts` | **STAY** | MIDI-coupled (dumps via connection) |
| `safety/` | **STAY** | MCP safe-edit policy + connection-coupled gates |
| `midi.ts`, `device.ts` | **STAY** | node-midi I/O wrapper |
| `tools/` | **STAY** | MCP tool registrations |

### `packages/fractal-gen2/src/` and `packages/fractal-gen3/src/`

Same pattern as AM4:

- **MOVE:** `params.ts`, `blockTypes.ts`, `setParam.ts`, `lineageLookup.ts`,
  `paramAliases.ts`, `descriptor/{schema,reader,writer}.ts`, the
  type-only parts of `descriptor.ts`.
- **STAY:** `descriptor/agentGuidance.ts`, `midi.ts`, `device.ts`,
  `tools/*`, the descriptor-registration wrapper.

### `packages/hydrasynth/src/`

Out of scope for `fractal-midi`. The Hydrasynth line (Explorer / KB /
Deluxe / Desktop) is the seed of a future `asm-midi` package per the
same roadmap doc: separate extraction, same pattern.

### `packages/server-all/`

100% **STAY**. This is the MCP entrypoint.

## Consumer surface (what `fractal-midi` exports)

```ts
// Pure data: copy-paste-able into any language
import { params, blocks, lineage, applicability } from 'fractal-midi/am4';
import { params as iiParams } from 'fractal-midi/gen2/axe-fx-ii';
import { params as iiiParams } from 'fractal-midi/gen3/axe-fx-iii';

// Pure codec: display value in, SysEx bytes out
import { buildSetParam, parseSetParam } from 'fractal-midi/am4/codec';
import { checksum, packValue } from 'fractal-midi/shared';

const bytes = buildSetParam({ block: 'amp', param: 'gain', value: 7.5 });
// Returns Uint8Array. Caller routes through their own MIDI library.

// Pure validators: given captured bytes, parse back to display values
import { parseSetParam } from 'fractal-midi/am4/codec';
const display = parseSetParam(bytes); // { block, param, value }
```

Three layers per device subpath:

1. **JSON tables** (`params`, `blocks`, `lineage`, `applicability`):
   the data, language-agnostic at the byte level (parsed once into
   typed TS objects on import).
2. **TS codec** (`/codec`): `buildSetParam`, `parseSetParam`,
   envelope builders, checksum integration.
3. **Validators / fingerprints**: pure functions for buffer-dump
   hashing, preset round-trip equality, applicability checks.

## Prerequisites (work to do BEFORE the move)

These are the conditions that, if not satisfied at extraction time,
make the resulting `fractal-midi` lower-quality than it should be.

### AM4 coverage audit closeout
- **State:** AM4 catalog coverage is partial; the cross-ref audit shows
  a meaningful count of mislabeled, UI-missing, and ghost entries (see
  the audit script output).
- **What's needed:** either close most of these, or add a `coverage`
  status field per param entry so downstream consumers can filter by
  confidence. Don't ship a public dictionary that quietly carries a
  meaningful fraction of mislabeled entries.
- **Effort:** medium. The cross-ref audit script already produces
  the input; either hand-closeout passes or generator-side fixes
  resolve the bulk.

### Axe-Fx III calibration coverage
- **State:** III calibration covers a small fraction of catalog entries
  after the most recent alias work.
- **What's needed:** a decision: does the first release of
  `fractal-midi` ship III as "experimental, sparsely calibrated, names
  only" with the rest as `unit: 'enum'` placeholders, or do we wait
  for the BinaryData XML mining plus universal-fallback work to land?
- **Recommendation:** ship II as headline, AM4 as second, III as
  experimental, the same posture the project announcement already
  takes. III's catalog (thousands of names) is itself the headline win
  even with sparse calibration.

### Display-to-wire boundary cleanup
- **State:** the display-first decision is honored at the MCP boundary,
  but some `setParam.ts` paths may still expect pre-translated wire
  values from callers.
- **What's needed:** audit per-device `setParam.ts` for any
  caller-side wire assumptions; ensure the public codec API is
  display-in / bytes-out end-to-end.
- **Effort:** small if the contract is already clean; may surface
  one or two leak spots.

### `bufferFingerprint` purification
- **State:** `packages/am4/src/bufferFingerprint.ts` mixes pure hashing
  logic with connection-aware polling.
- **What's needed:** split into `fingerprint.ts` (pure: buffer bytes to
  hash) and `safeEdit/poller.ts` (connection-aware). The pure half
  moves to `fractal-midi`; the poller stays in `mcp-midi-control`.
- **Effort:** small refactor.

### Descriptor schema portability
- **State:** `descriptor/schema.ts` per device is TS-native. For non-TS
  consumers (Python, Rust, JUCE/C++) to use the param catalog, the
  schema needs a JSON Schema or Protobuf equivalent.
- **What's needed:** decide whether `fractal-midi` ships JSON Schema
  alongside the TS types (recommended) or TS-only (faster, less
  inclusive).
- **Recommendation:** JSON Schema. The whole point of extraction is
  cross-language reuse; the marginal cost of generating JSON Schema
  from the existing Zod schemas is low.

### Captures and licensing
- **State:** captures are gitignored. Some ride-along bytes appear in
  `verify-msg.ts` goldens.
- **What's needed:** confirm none of the goldens that would move with
  the codec embed any user data (preset names, factory bank
  contents). Spot-check before publishing.
- **Effort:** quick audit.

## Dev workflow during dual-repo work

When the extraction starts, the two repos need to coexist during a
transition window where `mcp-midi-control` is still iterating fast.

**Recommended setup:**

1. Sibling clones under one parent dir (consumer repo +
   `fractal-midi`).
2. `npm link` the in-development `fractal-midi` into the consumer repo
   so edits in the protocol lib show up live in the MCP server's
   `node_modules`.
3. CI publishes `fractal-midi` to npm on tagged releases; the
   consumer repo pins a specific `fractal-midi` version in its
   `package.json` and bumps it explicitly when consuming new features.

**Don't** try to maintain a git submodule or a path-dependency in
production `package.json`; both create release-coordination friction
that npm version pinning solves cleanly.

## Migration sequencing (execution order)

When the extraction is triggered, this is the order I'd run it:

1. **Snapshot the current monorepo** under a release tag
   (`pre-fractal-midi-extraction`).
2. **Close the prerequisites above** (coverage audit, display-to-wire
   cleanup, fingerprint purification, captures/licensing) in the
   monorepo before any files move. Easier to fix things in one repo
   than across two.
3. **Create the new repo** with the proposed layout and a minimal
   skeleton (`package.json`, `tsconfig.json`, CI for typecheck plus
   tests).
4. **Move `fractal-shared/` first** (smallest, most-shared); it's
   the dependency root for every per-device subpath.
5. **Move AM4** as the second package; it's the deepest-RE'd device,
   so any cross-cutting design issues surface here first.
6. **Move Axe-Fx II**: fast, since the patterns are now proven.
7. **Move Axe-Fx III** last, since its catalog is largest but its
   per-param calibration is sparsest (calibration decision deferred per
   the prerequisites above).
8. **Cut the first `fractal-midi` release** to npm.
9. **Update `mcp-midi-control` to depend on the released
   `fractal-midi`**; remove the moved files from
   `packages/{core/src/fractal-shared,am4,axe-fx-ii,axe-fx-iii}/`.
10. **Hardware-verify the dispatch path end-to-end** (run
    `launch-verify` against real AM4 plus Axe-Fx II hardware); this is
    the only way to confirm the cross-repo wiring didn't lose any
    runtime-resolution invariants.

## Post-extraction: III calibration ✅ plus FM3 / FM9 add

After the initial extraction landed, the III device was lifted from
"experimental, sparse calibration" to **Codec ✅ + Calibration ✅**
entirely in the sibling `fractal-midi` repo without hardware. The
mechanical path is documented because it generalizes to FM3 and FM9.

### What landed for III in `fractal-midi`

- **Round-trip codec goldens.** `test/axe-fx-iii/setparam.test.ts`
  jumped from 36 to 302 goldens. Added 264 `build, parse, equality`
  cases across {4 effectIds × 6 paramIds × 11 values}, plus 2
  `parseStateBroadcast` assertions. Added a named `parseStateBroadcast`
  helper plus an `AxeFxIIIParameterFrameKind` discriminator union so
  callers can branch on `'set_echo'` vs `'state_broadcast'` without
  re-reading sub-action bytes.
- **Enum vocabulary overlay.** New module
  `src/axe-fx-iii/enumOverlay.ts` ships universal-Fractal vocabularies
  (binary OFF/ON, channel A/B/C/D, filter slopes, LFO waveforms,
  tempo divisions) plus III-specific direct overrides, each tagged with
  a `provenance: 'am4-shared' | 'fractal-convention' | 'iii-spec'`
  field. Resolves a small fraction of III's enum-typed entries; the
  remainder return `undefined` and are user-facing reminders for
  GitHub issue contribution.
- **Post-generation overlay script.** New script
  `scripts/axe-fx-iii/apply-calibration-overlay.ts` extends the
  upstream generator's universal-suffix fallback with a much broader
  table (`_MODE`/`_TYPE`/`_BEGIN`/`_LAYOUT*`/`_FC*`/`_FEEDBACK*` etc.).
  Drove `unit: 'unverified'` from hundreds of entries down to a few
  dozen (all string-typed `_NAME` / `_LABEL*` / `_MSG` exempted by the
  calibration gate). Each modified entry carries a trailing
  `// post-gen overlay: <reason>` audit tag.
- **Calibration acceptance gate.** New
  `test/axe-fx-iii/calibration.test.ts` asserts every non-string-typed
  catalog entry carries a non-`'unverified'` unit (the hard gate
  behind the README ✅) and reports coverage of numeric range and enum
  vocabulary as soft metrics. Wired into the test runner.

Final III state at the time of writing: full catalog with 100% unit
coverage; enum vocabulary and numeric ranges each populated for a
fraction of entries.

### Adding FM3 (Catalog + Codec + Calibration, all ❌ to ✅)

Once the FM3-Edit installer is in hand:

1. **Obtain the binary.** Download the FM3-Edit installer from
   `fractalaudio.com/fm3-downloads`. Extract the JUCE BinaryData zip
   into `samples/captured/decoded/binarydata/fm3-edit-allzips/extracted/`
   (mirrors the III path already in place).
2. **Catalog mining** (no hardware needed once binary is in hand):
   adapt `mine-axeedit3-xml-labels.ts` to FM3-Edit's
   `__block_layout.xml`. Ghidra-mine the FM3-Edit dispatcher using
   the `SeekParamTablesII.java` direct-pattern-scan technique. Output
   `(paramId, symbolicName)` pairs by family.
3. **Generate catalog.** Adapt
   `scripts/_research/generate-axefx3-params-from-catalog.ts` to
   produce `packages/fm3/src/params.ts` (or, post-extraction, write
   directly to `fractal-midi/src/gen3/fm3/`). Same Param interface shape
   as III.
4. **Codec.** Clone III's `setParam.ts` and swap `AXE_FX_III_MODEL_ID
   = 0x10` to `FM3_MODEL_ID = 0x11`. Wire envelope, sub-action codes,
   `packValue16`, `encode14` are family-shared per Fractal's v1.4
   PDF. Add the same 302+ round-trip goldens.
5. **Calibration.** Re-run the III calibration pipeline:
   `apply-calibration-overlay.ts` so the universal suffix table closes
   `'unverified'`. Clone `enumOverlay.ts` and re-tune direct overrides
   for FM3-specific names.
6. **Acceptance gate.** Clone `calibration.test.ts` and assert
   100% unit-coverage for FM3.
7. **README footnote.** Same form as III's: "FM3 codec and
   calibration derived from FM3-Edit binary mining and the Fractal
   v1.4 MIDI spec; hardware verification welcome via GitHub issue."

Estimate: roughly 2.5 days once the binary is pulled.

### Adding FM9 (mirror of the FM3 path)

Identical to the FM3 path; swap `0x11` to `0x12`, FM3-Edit to FM9-Edit.
Estimate: roughly 2.5 days once the binary is pulled.

### Generalizing the III lift

The III calibration scripts in `fractal-midi/scripts/axe-fx-iii/` are
device-specific by data only, not by mechanism. For FM3/FM9 the same
suffix table, enum overlay shape, and calibration gate apply
verbatim; only the paths and the model byte change. Consider
extracting a shared `fractal-midi/scripts/lib/` module that takes a
device key and applies the pipeline, parametrized on params.ts path
and model byte. Worth doing **after** FM3 lands, not before; the
abstraction is cheaper to write once the third copy exists.

## Strategic notes

- **Potential external consumer.** Another community developer is
  independently building an Axe-Fx III MCP. If `fractal-midi` ships
  first, they're the natural first external consumer: that validates
  the abstraction and gives the project a public "second consumer"
  story.
- **The safe-edit fingerprint is publishable.** Most Fractal RE
  projects in the open-source community ship without any dirty-state
  tracking, so anyone building an editor reinvents it badly. Exposing
  the pure fingerprint computation in `fractal-midi` is a high-leverage
  gift to the community even if downstream consumers wire their own
  gates.
- **Hardware-verified contribution workflow translates.** The project's
  contribution-evidence policy (every new device-support PR carries
  capture evidence) applies to `fractal-midi` too. Wire the same
  CI shape into the new repo from day one.

## References

- [`MULTI-DEVICE-ROADMAP.md`](MULTI-DEVICE-ROADMAP.md): the high-level
  architecture intent (this doc is its detailed companion).
- The project's private decision log records the workspace-split,
  display-first, and contribution-evidence decisions that underpin this
  plan.
- [`SAFE-EDIT-WORKFLOW.md`](SAFE-EDIT-WORKFLOW.md): the cross-device
  contract; gates stay in `mcp-midi-control`, fingerprint primitives
  move to `fractal-midi`.
- The project's private backlog carries an early pre-workspace-split
  version of this idea; superseded by this doc.
