# Axe-Fx II amp-block calibration, hardware-swept

How the `amp` block's opaque deep params got display calibration, and
which ones still need work. The overlays themselves live in the MCP
layer at `packages/fractal-gen2/src/calibration.ts` (`HARDWARE_SWEPT`
table, `provenance: 'hardware-swept'`).

## Why

`get_preset` returned raw wire integers (e.g. `tone_freq: 24318`)
instead of display values for the amp block's advanced params, breaking
the display-first contract. Root cause: those params had no calibration
in any layer (codec catalog, AM4-shared, convention suffix rules), so
the resolver produced no `decodeWire` and the reader fell back to the
raw wire. An earlier attempt to read the device's `label` string in the
bulk path was unstable (the device renders the bulk-read label with
whichever formatter the front panel currently focuses), so it was
reverted to raw: correct but unreadable.

The durable fix is calibration overlays: the param decodes via pure math
(`wireToDisplay`), independent of any device label. Because the resolver
is shared between read-decode and write-encode, this also fixes
`set_param` on these params (a wrong range would miscalibrate writes,
the silent-scene class of bug, so the ranges had to be
measured, not guessed).

## Method (reproducible)

The single-param `fn=0x02` GET response embeds the device's own rendered
display label, and that label IS reliable per-param (the instability was
only in the rapid bulk path). So the calibration was measured directly:

1. `scripts/_research/enumerate-ii-opaque-amp-params.ts`: list the amp
   params that resolve to `opaque` (no `decodeWire`). 75 found.
2. `scripts/_research/probe-ii-opaque-amp-labels.ts`: READ-ONLY baseline
   confirming the per-param label is clean and parseable. 75/75 clean.
3. `scripts/_research/probe-ii-opaque-amp-sweep.ts`: set each param to
   five wire points (0 / 16383 / 32767 / 49151 / 65534) and read the
   device-rendered label at each. Working-buffer only; restores the
   original wire per param; never saves to flash. Output:
   `samples/captured/decoded/ii-opaque-amp-sweep.json` (gitignored).
4. `scripts/_research/fit-ii-opaque-amp-calibration.ts`: deterministic
   fit. Endpoints from wire 0 / 65534, scale from the midpoint
   (arithmetic mean is linear, geometric mean is log10). Residuals were
   about 0.0% on the chosen scale.
5. `ii-amp-calibration-verify` workflow: fan-out verification.
   Corroborate each fit against AM4 siblings, III analogs, and
   convention; adversarially refute scale/unit/endpoint edge cases;
   synthesize the proposal. It caught the `supply_sag` scale error and
   the ms/dB/pF unit misclassifications.
6. `scripts/_research/verify-ii-amp-calibration-roundtrip.ts`: decode
   every captured (wire to label) pair through the live resolver and
   confirm it reproduces the device label. **344/344 within tolerance.**

## Result

69 of 75 params calibrated (`HARDWARE_SWEPT`): 41 linear, 28 log10, each
carrying an explicit `unit` from the device-rendered suffix (Hz, ms, dB,
pF, %, or bare number). `unit` is explicit because `classifyUnit` infers
from numeric shape and cannot tell ms from hz (both log10, max > 30) or
dB from a bare knob (both linear).

Edge cases baked in:
- `ac_line_freq` is LINEAR Hz (30..100, mains band), overriding the
  bare-`freq` log10 convention.
- `supply_sag` is LINEAR 0..10; wire 0 renders "P.A. OFF" (value 0).
  Confirmed: wire 13107 reads "2.00", which is 10 * 13107/65534.

## Registered lanes

### Enums (tables captured 2026-05-29, REGISTERED 2026-05-29)

`fn 0x28` SYSEX_GET_PARAM_STRINGS was dumped for all four (probe
`scripts/_research/probe-ii-amp-enum-dump.ts`, output
`samples/captured/decoded/ii-amp-enum-dump.json`). The wire value is the
enum index directly. Full ground-truth tables:

| param | paramId | count | labels |
|---|---|---|---|
| `cliptype2` | 18 | 13 | SOFT, HARD, SQUARE, CUBIC, ABS, TUBE, QUARTIC, PUSH-PULL, 3/2 HARD, 3/2 SOFT, TRIODE, TRIODE+SAT, TRIODE+SAT1 |
| `drivetype` | 30 | 6 | NORMAL, DUMBLE, MESA, JUMPED, DUAL 1, DUAL 2 |
| `fbtype` | 37 | 43 | BASSGUY, PLEXI, BRIT 800, ... AFS100 (amp-voicing list) |
| `version` | 82 | 8 | LATEST, Q6.xx, Q5.xx, Q4.xx, Q3.xx, Q2.04, Q2.01, Q2.00 |

All four are now `controlType: 'select'` + `enumValues` in `params.ts`
(`AMP_CLIPTYPE2/DRIVETYPE/FBTYPE/VERSION_VALUES`) and promoted to
`REQUIRED_ENUMS` in `scripts/verify-enum-completeness.ts`.

**Registration was a direct edit to the committed `params.ts`, NOT a
regen.** `params.ts` carries a "generated / DO NOT EDIT BY HAND" banner,
but in practice the committed file has diverged ~360 lines from the
generator's output: hand-applied annotations (`parameterName`/`xmlLabel`
on amp.middle/treble/…), the amp display-range calibrations, and privacy
scrubs of comment provenance. Running `npm run extract-axe-fx-ii-params`
on a clean tree REVERTS all of that (verified 2026-05-29), so a regen is
destructive, it would drop these enum registrations along with the
existing hand-work. The enums are maintained the same way the amp
display-range calibrations are: applied to the committed file, re-applied
if a regen ever drops them. The captured JSON remains the source of
truth for the vocabularies.

### Firmware-internal (resolved, not a gap)

`xformer_grind` (paramId 9) and `bypass` (paramId 28) are NOT
user-controllable. Re-swept across 4 amp models (SHIVER CLEAN, 59
BASSGUY, MR Z MZ-38, DIZZY V4 BLUE 2, probe
`scripts/_research/probe-ii-gated-resweep.ts`); both render a constant
label at every wire value on every model (`xformer_grind` = "68.0 ms" a
fixed transformer time constant; `bypass` = "0.707" a fixed Butterworth
Q). There is no wire→display function to calibrate, so they correctly
stay opaque. They are param-table entries the firmware computes
internally, not knobs.

### Divergence note

`triode2rectime` swept clean as log10 0.1..100 ms on the II (accepted).
AM4/III put it at 200 ms, a genuine cross-device divergence; the II's
own reading is authoritative for the II. Re-probe optional to rule out a
model-specific clamp.
