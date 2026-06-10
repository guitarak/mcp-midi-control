# fractal-midi, Claude Code Context

Read by Claude Code when working inside `packages/fractal-midi/`.

---

## What this package is

Pure-TypeScript codec and parameter dictionaries for Fractal Audio devices.
Builds and parses SysEx wire bytes. No MIDI transport dependency, no MCP
server logic. Consumers bring their own MIDI library (`node-midi`, `webmidi`,
etc.) and use this package for the encoding layer.

Published independently to npm as `fractal-midi`. The MCP server packages
in this monorepo import from `fractal-midi/*`; the codec never imports from
the server.

## Supported devices

- **AM4** (model byte `0x15`): full catalog, codec, calibration, hardware-verified
- **Axe-Fx II** (model byte `0x07`, XL+): full catalog, codec, calibration, hardware-verified. The Axe-Fx II family spans several model bytes (`0x03` for the Mark I/II up to `0x07` for the XL+); this codec targets the XL+ hardware on hand.
- **Axe-Fx III** (model byte `0x10`): full catalog, codec, calibration, community-beta hardware verification
- **FM3 / FM9** (model bytes `0x11` / `0x12`): modern Fractal gen-3 family sharing the III's codec and block effect IDs. Device-true param catalogs mined from their own FM3-Edit / FM9-Edit binaries (paramIds are device-specific, never reused from the III). Calibration covers linear params; some non-linear formulas pending. Community beta: FM9 has community captures confirming the shared read + preset-dump paths, FM3 is unconfirmed on hardware.
- **VP4** (model byte `0x14`): gen-3 codec but AM4-shape (serial 4-slot chain, 4 scenes, A-D channels, A01-Z04 locations, no amp/cab). Device-true catalog mined from VP4-Edit. Its fn=0x01 WRITE frame is its own shape (no sub-action, a `tc` sub-opcode, swapped-septet float — `src/vp4/setParam.ts`), decoded byte-exact from community captures (fw 4.03). Reads ship; `set_param` (continuous knobs only: raw wire value, calibration pending, enum/TYPE set refuses), `set_bypass`, and `save_preset` ship community-beta (untested on hardware); `set_block`/`switch_scene` stay gated (block-placement + scene mapping undecoded). Community beta.
- **Axe-Fx Standard/Ultra (gen-1)** (model byte `0x01`): its **own** nibble-split codec (8-bit fields → two low-nibble-first bytes; fn `0x02`; trailing query(0)/set(1) flag, no checksum), distinct from gen-2 septet and gen-3 sub-action. 922 params / 35 blocks decoded byte-exactly from the published Ultra SysEx param-set doc + its 0..255 conversion table. Parameter READ-back is wired too (`buildGetParam`/`parseParamValue` in `readParam.ts`: fn 0x02 query → MIDI_PARAM_VALUE with value + the device's own label), decoded from the fuller gen-1 wiki spec. Community beta, not hardware-verified. Whole-patch dump (0x03→0x04), save, preset/scene/channel ops remain out of scope.

## Stack

- TypeScript, ES modules (`"type": "module"`, `"module": "NodeNext"`)
- Zero runtime dependencies
- `tsx` as the TypeScript runner for scripts and tests
- Node >= 18

## Directory layout

```
packages/fractal-midi/
├── src/
│   ├── index.ts              # Root entry: exports VERSION only
│   ├── shared/               # Cross-device: checksum, packValue, lineage lookup
│   │   ├── lineage/          # JSON lineage tables (amp, cab, drive, etc.)
│   │   └── index.ts
│   ├── am4/                  # AM4 builders, parsers, params, blocks, calibration
│   │   └── index.ts
│   ├── axe-fx-ii/            # Axe-Fx II builders, parsers, params, blocks
│   │   └── index.ts
│   ├── axe-fx-iii/           # Axe-Fx III builders, parsers, params, enum overlay
│   │   └── index.ts
│   └── axe-fx-gen1/          # Axe-Fx Standard/Ultra (gen-1) nibble-split codec + generated catalog
│       └── index.ts
├── test/                     # Golden-based test suites
│   └── run-all.ts            # Test runner entry point
├── scripts/
│   └── copy-build-assets.ts  # Copies lineage JSON into dist/ after tsc
├── docs/                     # Protocol RE docs (SYSEX-MAP, capture guides, cookbook)
│   └── devices/              # Per-device protocol references
└── dist/                     # Build output (gitignored)
```

## Exports map

Consumers import from subpaths matching the device or shared layer:

```ts
import { packValue, fractalChecksum } from 'fractal-midi/shared';
import { buildSetParam, params, blocks }  from 'fractal-midi/am4';
import { buildSetParam, params }          from 'fractal-midi/axe-fx-ii';
import { buildSetParam, params }          from 'fractal-midi/axe-fx-iii';
import { buildSetParam, nibbleSplit, KNOWN_PARAMS } from 'fractal-midi/axe-fx-gen1';
```

The root export (`fractal-midi`) exposes only a `VERSION` constant.

## Build and test

| Command | What it does |
|---|---|
| `npm run build` | `tsc` + `copy-build-assets` (copies lineage JSON to `dist/`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `tsx test/run-all.ts` (golden-based byte-exact SysEx verification) |
| `npm run preflight` | typecheck + test + build, in order |

Run `npm run preflight` before committing changes to this package.

## Publishing

Bump the version in `package.json`, then publish from this directory
(`cd packages/fractal-midi && npm publish`). The npm package is independent
of the MCP server packages, which are private and not published.

## Key conventions

**Display-first API.** Public functions accept and return display units (knob
values like `7.5`, enum strings like `'Plexi 100W High'`, dB, ms, ratios).
Wire encoding (septet-packed 14-bit ints, packed floats, fixed-point scaling)
is internal and never leaks through the public surface.

**Param registration.** Every parameter lives in `params.ts` within its device
directory. Each entry carries `paramId`, `controlType`, value range, display
unit, and optional calibration. When adding a new param, add a matching golden
case in the device's test suite.

**Lineage JSON.** Lineage tables (amp/cab/drive model heritage data) live as
JSON in `src/shared/lineage/` and are copied to `dist/` at build time by
`scripts/copy-build-assets.ts`. The `lineageLookup` module reads them at
runtime via `fs.readFileSync`.

**Golden-based tests.** Tests assert byte-exact round-trip equality: build
SysEx from display values, parse back, confirm equality. No mocking. When
adding a new wire builder or parser, add a golden case.

**Protocol docs live here.** Per-device `SYSEX-MAP.md`, opcode tables, capture
guides, Ghidra scripts, and the encoding cookbook all live under `docs/` in
this package. Consult the relevant `SYSEX-MAP.md` before speculating about
wire shapes.
