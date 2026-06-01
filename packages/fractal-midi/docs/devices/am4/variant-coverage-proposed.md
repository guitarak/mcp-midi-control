# AM4 variant-block coverage, proposed entries

> Date-stamp: 2026-05-28
>
> Catalog-gap proposal for the AM4 reverb / delay variant block
> families surfaced by
> [`ghidra-catalog-cross-validate.md`](ghidra-catalog-cross-validate.md):
> PLEX reverb (+82 over standard REVERB), the delay variants
> MEGATAP / TENTAP / MULTITAP (+182 combined over standard DELAY),
> and the drive variants FUZZ / DYNDIST (+16 over standard DRIVE).
>
> Sources:
> - Symbols + table-local paramIds:
>   `samples/captured/decoded/ghidra-am4edit-paramtables.json`
>   (local-only; mined from AM4-Edit.exe via the direct-pattern-scan
>   Ghidra script, 47 tables / 2105 entries / 1894 unique symbols).
> - Wire-address derivation proof + variant pidLow confirmation:
>   `scripts/_research/wf-am4-variant-blocks-roundtrip.ts` (read-only,
>   offline). It reproduces every shipped reverb/delay address from the
>   same derivation it applies to the variants, and round-trips a
>   representative SET_PARAM frame per variant family.

## Why nothing is registered live

The shipped `KNOWN_PARAMS` registry in
`packages/fractal-midi/src/am4/params.ts` is the only AM4 layer that
is **wire-addressable AND value-coerce-safe**. Its `Param` interface
makes `displayMin` and `displayMax` **required**. A range-bearing knob
entry without a range cannot coerce a display value to wire safely, so
adding any of these variant knobs to `KNOWN_PARAMS` would require a
hardware-derived display range and unit that the Ghidra dump does not
carry (the dump has names + table-local paramIds but no display
ranges, units, or scaling curves).

The project has **no separate name-only discovery layer** that binds a
`(pidLow, paramId) -> display-name + type-applicability gate` without a
range and is consumed in production:

- `editorControlLabels.ts` (`EDITOR_CONTROLS`) is keyed by AM4-Edit
  symbolic `parameterName`, carries labels + block/variant contexts but
  **no paramId and no wire address**. It is auto-generated from the
  AM4-Edit BinaryData XML and is do-not-hand-edit. It already contains
  the PLEX (85), MULTITAP (111), MEGATAP (26) and FUZZ (39) symbols
  where AM4-Edit's own XML exposes them, so the human-label discovery
  for those families is effectively already present at the symbol level.
- `symbolicIds.ts` (`SYMBOLIC_IDS_BY_BLOCK`) is a per-block list of
  symbolic IDs with no paramId, no range. Auto-generated, do-not-edit.
- `variantResolverTables.ts` (`VARIANT_RESOLVER_BY_EFFECT_TYPE`) binds
  `effectType -> [{cache_id, parameterName}]`, no display name, no
  range. Auto-generated, do-not-edit.
- `typeApplicability.ts` (`TYPE_APPLICABILITY`) is keyed by
  `block.name` (the `KNOWN_PARAMS` key) and is generated from the
  AM4-Edit XML, not from the Ghidra dump. A gate can only attach to a
  param that already exists in `KNOWN_PARAMS`.

Conclusion: the coverage adds in this document are **fully
hardware-gated**. Every proposed entry needs a display range + unit
that must come from a hardware readback (front panel or `get_param`
echo on a placed variant block) before it can ship in `KNOWN_PARAMS`.
No live registry entries were added in this pass. This is the
research-doc-only path.

## De-dupe against the shipped catalog

The shipped `reverb.*` namespace (68 entries) registers two
pitch-shift voices (`reverb.shift_1`, `reverb.shift_2`,
`reverb.voice_1_shift`, `reverb.voice_2_shift`). PLEX exposes an
eight-voice shifter (`PLEX_SHIFT1..8`), so the additional six voices
plus the PLEX-specific delay-line / diffusion / shimmer params are
genuinely unregistered.

The shipped `delay.*` namespace (86 entries) has **no** tap-array,
NUMTAPS, per-tap time/level/tempo, or comb-filter params; the entire
MEGATAP / TENTAP / MULTITAP tap-array surface is unregistered.

Per the AM4 param-rename-audit reflex, these symbols were re-checked
against the short canonical spellings used by the shipped catalog
(`tap`, `num_taps`, `time_N`, `level_N`, `tempo_N`, `shift`,
`detune`, `subdiv`, `shuffle`) and none of them resolve to an existing
`KNOWN_PARAMS` key.

## Confirmed wire addresses (round-trip proof)

`wf-am4-variant-blocks-roundtrip.ts` confirms each variant family's
slot-1 `effectId` (the SET_PARAM `pidLow`) and round-trips a
representative param. The derivation `pidLow = effectId(ID_<BLOCK>1)`,
`pidHigh = Ghidra table-local paramId` reproduces every shipped
reverb/delay address byte-for-byte, so the addresses below are
high-confidence.

| Family   | pidLow | Ghidra params | Block namespace | Type gate (proposed) |
|----------|--------|---------------|-----------------|----------------------|
| PLEX     | 0xb2   | 87            | `reverb.*`      | `REVERB_TYPE` = Plex-reverb-type wire indices (read from cacheEnums `REVERB_TYPES_VALUES` once hardware confirms which indices are Plex variants) |
| MEGATAP  | 0x8a   | 27            | `delay.*`       | `DELAY_TYPE` = MegaTap wire index |
| TENTAP   | 0x9e   | 48            | `delay.*`       | `DELAY_TYPE` = TenTap wire index |
| MULTITAP | 0x4a   | 113           | `delay.*`       | `DELAY_TYPE` = MultiTap wire index |
| FUZZ     | 0x76   | 40            | `drive.*`       | `DRIVE_TYPE` = Fuzz wire index (AM4-exposed, see below) |
| DYNDIST  | 0xca   | 14            | `drive.*`       | DEFERRED, not AM4-exposed (see below) |

Note: `FUZZ` shares pidLow 0x76 with the standard drive block's slot-1
effectId. On the AM4, the Fuzz family is a drive **type**, not a
separate placeable block, so its params address into the same drive
block and are gated by `DRIVE_TYPE`.

## Registered now (discovery layer)

**None.** As explained above, there is no safe name-only discovery
layer that accepts a `(pidLow, paramId)` binding without a range, and
the range-bearing `KNOWN_PARAMS` layer is unsafe to populate from the
Ghidra dump alone. All proposed entries are hardware-gated.

## Hardware-gated (needs range / unit)

Each table below lists the proposed range-bearing `KNOWN_PARAMS`
entries for a variant family: the symbol (firmware-truth from the
Ghidra dump), the table-local paramId (= `pidHigh`), and the
`pidLow`. The `unit`, `displayMin`, `displayMax`, and `scaling` fields
are intentionally omitted: they require a hardware readback of the
placed variant block to fill in safely, and the cache pipeline's
`c=1 -> 'db'` fallback is known to mislabel Hz / count / seconds /
semitones / degrees fields (see `paramNames.ts` for the long history
of that trap on standard reverb/delay).

Proposed `block.name` keys follow the shipped naming conventions
(`shift_N`, `tap_N_time`, etc.) but are illustrative; the canonical
key should be reconciled against the AM4-Edit display label
(`EDITOR_CONTROLS`) at registration time.

### FUZZ and DYNDIST drive variants

`editorControlLabels.ts` (derived from AM4-Edit's own BinaryData XML)
contains the 39 `FUZZ_*` symbols, which confirms the Fuzz family is
AM4-exposed (it appears in the AM4-Edit drive-type UI). FUZZ is a
hardware-gated coverage candidate under `drive.*`.

`DYNDIST` has **zero** symbols in `editorControlLabels.ts` and the
cross-validate doc marks it lower-confidence. Without XML evidence
that AM4-Edit surfaces it, DYNDIST is **deferred** until a hardware
check (place a drive block, walk the type dropdown, confirm a
"DynaDist"-style entry exists). Its 14 Ghidra symbols are listed in
the dump but are not proposed for registration here.

#### FUZZ family (40 params, pidLow 0x76, gate DRIVE_TYPE)

The FUZZ family addresses into the existing `drive.*` namespace.
Several FUZZ symbols already overlap shipped `drive.*` knobs (e.g.
`FUZZ_DRIVE`, `FUZZ_TONE`, `FUZZ_LEVEL`, `FUZZ_MIX`); registration
must reconcile against the existing drive entries rather than create
duplicate keys. The Fuzz-specific additions (bias, slew, wicker,
clip-shape, no-diode / positive-diode quantities) are the genuine
coverage gap. Symbol list lives in the Ghidra dump under
`effectFamily == "FUZZ"`.

#### PLEX, MEGATAP, TENTAP, MULTITAP symbol tables

#### PLEX family (87 params, pidLow 0xb2)

| paramId | symbol |
|---|---|
| 0x0a | PLEX_BASETYPE |
| 0x0b | PLEX_NUMDLINES |
| 0x0c | PLEX_SHIFT1 |
| 0x0d | PLEX_SHIFT2 |
| 0x0e | PLEX_SHIFT3 |
| 0x0f | PLEX_SHIFT4 |
| 0x10 | PLEX_SHIFT5 |
| 0x11 | PLEX_SHIFT6 |
| 0x12 | PLEX_SHIFT7 |
| 0x13 | PLEX_SHIFT8 |
| 0x14 | PLEX_DETUNE1 |
| 0x15 | PLEX_DETUNE2 |
| 0x16 | PLEX_DETUNE3 |
| 0x17 | PLEX_DETUNE4 |
| 0x18 | PLEX_DETUNE5 |
| 0x19 | PLEX_DETUNE6 |
| 0x1a | PLEX_DETUNE7 |
| 0x1b | PLEX_DETUNE8 |
| 0x1c | PLEX_TIME1 |
| 0x1d | PLEX_TIME2 |
| 0x1e | PLEX_TIME3 |
| 0x1f | PLEX_TIME4 |
| 0x20 | PLEX_TIME5 |
| 0x21 | PLEX_TIME6 |
| 0x22 | PLEX_TIME7 |
| 0x23 | PLEX_TIME8 |
| 0x24 | PLEX_TEMPO1 |
| 0x25 | PLEX_TEMPO2 |
| 0x26 | PLEX_TEMPO3 |
| 0x27 | PLEX_TEMPO4 |
| 0x28 | PLEX_TEMPO5 |
| 0x29 | PLEX_TEMPO6 |
| 0x2a | PLEX_TEMPO7 |
| 0x2b | PLEX_TEMPO8 |
| 0x2c | PLEX_LEVEL1 |
| 0x2d | PLEX_LEVEL2 |
| 0x2e | PLEX_LEVEL3 |
| 0x2f | PLEX_LEVEL4 |
| 0x30 | PLEX_LEVEL5 |
| 0x31 | PLEX_LEVEL6 |
| 0x32 | PLEX_LEVEL7 |
| 0x33 | PLEX_LEVEL8 |
| 0x34 | PLEX_PAN1 |
| 0x35 | PLEX_PAN2 |
| 0x36 | PLEX_PAN3 |
| 0x37 | PLEX_PAN4 |
| 0x38 | PLEX_PAN5 |
| 0x39 | PLEX_PAN6 |
| 0x3a | PLEX_PAN7 |
| 0x3b | PLEX_PAN8 |
| 0x3c | PLEX_INGAIN |
| 0x3d | PLEX_MSTRTIME |
| 0x3e | PLEX_MSTRLVL |
| 0x3f | PLEX_MSTRPAN |
| 0x40 | PLEX_MSTRPITCH |
| 0x41 | PLEX_MSTRDTN |
| 0x42 | PLEX_DECAY |
| 0x43 | PLEX_DIFFUSION |
| 0x44 | PLEX_DIRECTION |
| 0x45 | PLEX_SPLICE |
| 0x46 | PLEX_LOWCUT |
| 0x47 | PLEX_HIGHCUT |
| 0x48 | PLEX_ATTEN |
| 0x49 | PLEX_THRESH |
| 0x4a | PLEX_RELEASE |
| 0x4b | PLEX_DIFFMIX |
| 0x4c | PLEX_DIFFTIME |
| 0x4d | PLEX_LFORATE |
| 0x4e | PLEX_LFODEPTH |
| 0x4f | PLEX_LFOTEMPO |
| 0x50 | PLEX_ENVTHRESH |
| 0x51 | PLEX_ENVATTACK |
| 0x52 | PLEX_ENVRELEASE |
| 0x53 | PLEX_SIZE |
| 0x54 | PLEX_SPREAD |
| 0x55 | PLEX_PREDELAY |
| 0x56 | PLEX_FILTERTYPE |
| 0x57 | PLEX_FILTERFREQ |
| 0x58 | PLEX_FILTERQ |
| 0x59 | PLEX_FILTERGAIN |
| 0x5a | PLEX_SHIMMERINTENS |
| 0x5b | PLEX_INPUTSELECT |
| 0x5c | PLEX_HOLD |
| 0x5d | PLEX_GAINMONITOR |
| 0x5f | PLEX_FLTLFOTYPE |
| 0x60 | PLEX_FLTLFOFREQ |
| 0x61 | PLEX_FLTLFOMODFREQ |

#### MEGATAP family (27 params, pidLow 0x8a)

| paramId | symbol |
|---|---|
| 0x0a | MEGATAP_INGAIN |
| 0x0b | MEGATAP_MASTERLVL |
| 0x0c | MEGATAP_TIME |
| 0x0d | MEGATAP_NUMTAPS |
| 0x0e | MEGATAP_PREDELAY |
| 0x0f | MEGATAP_TIMESHAPE |
| 0x10 | MEGATAP_TIMEALPHA |
| 0x11 | MEGATAP_AMPSHAPE |
| 0x12 | MEGATAP_AMPALPHA |
| 0x13 | MEGATAP_PANSHAPE |
| 0x14 | MEGATAP_PANALPHA |
| 0x15 | MEGATAP_RANDOM |
| 0x16 | MEGATAP_DIFFMIX |
| 0x17 | MEGATAP_DIFFTIME |
| 0x18 | MEGATAP_ENVTHRESH |
| 0x19 | MEGATAP_ENVATTACK |
| 0x1a | MEGATAP_ENVRELEASE |
| 0x1b | MEGATAP_INPUTSELECT |
| 0x1c | MEGATAP_FEEDBACK |
| 0x1d | MEGATAP_FDBKTAP |
| 0x1e | MEGATAP_LOWCUT |
| 0x1f | MEGATAP_HICUT |
| 0x20 | MEGATAP_TYPE |
| 0x21 | MEGATAP_SPREAD |
| 0x22 | MEGATAP_AMPRAND |
| 0x23 | MEGATAP_DIFFRATE |
| 0x24 | MEGATAP_DIFFDEPTH |

#### TENTAP family (48 params, pidLow 0x9e)

| paramId | symbol |
|---|---|
| 0x0a | TENTAP_TYPE |
| 0x0b | TENTAP_STEREO |
| 0x0c | TENTAP_TIMEM |
| 0x0d | TENTAP_SUBDIV |
| 0x0e | TENTAP_QUANTIZE |
| 0x0f | TENTAP_RDECAY |
| 0x10 | TENTAP_DECAYSTYLE |
| 0x11 | TENTAP_NUMTAPS |
| 0x12 | TENTAP_SHUFFLE |
| 0x13 | TENTAP_RTEMPO |
| 0x14 | TENTAP_SPREAD |
| 0x15 | TENTAP_PANSHAPE |
| 0x16 | TENTAP_PANALPHA |
| 0x17 | TENTAP_LOWCUT |
| 0x18 | TENTAP_HIGHCUT |
| 0x19 | TENTAP_OFFSET |
| 0x1a | TENTAP_FEEDBACK |
| 0x1b | TENTAP_TIME1M |
| 0x1c | TENTAP_TIME2M |
| 0x1d | TENTAP_TIME3M |
| 0x1e | TENTAP_TIME4M |
| 0x1f | TENTAP_TIME5M |
| 0x20 | TENTAP_TIME6M |
| 0x21 | TENTAP_TIME7M |
| 0x22 | TENTAP_TIME8M |
| 0x23 | TENTAP_TIME9M |
| 0x24 | TENTAP_TIME10M |
| 0x25 | TENTAP_RLEVEL1 |
| 0x26 | TENTAP_RLEVEL2 |
| 0x27 | TENTAP_RLEVEL3 |
| 0x28 | TENTAP_RLEVEL4 |
| 0x29 | TENTAP_RLEVEL5 |
| 0x2a | TENTAP_RLEVEL6 |
| 0x2b | TENTAP_RLEVEL7 |
| 0x2c | TENTAP_RLEVEL8 |
| 0x2d | TENTAP_RLEVEL9 |
| 0x2e | TENTAP_RLEVEL10 |
| 0x2f | TENTAP_REFTEMPO |
| 0x30 | TENTAP_TRACKTEMPO |
| 0x31 | TENTAP_INGAIN |
| 0x32 | TENTAP_MIX |
| 0x33 | TENTAP_LEVEL |
| 0x34 | TENTAP_PAN |
| 0x35 | TENTAP_BYPASSMODE |
| 0x36 | TENTAP_GLOBALMIX |
| 0x37 | TENTAP_BYPASS |
| 0x38 | TENTAP_LEARN |
| 0x39 | TENTAP_SCENEIGNORE |

#### MULTITAP family (113 params, pidLow 0x4a)

| paramId | symbol |
|---|---|
| 0x0a | MULTITAP_BASETYPE |
| 0x0b | MULTITAP_TIME1 |
| 0x0c | MULTITAP_TIME2 |
| 0x0d | MULTITAP_TIME3 |
| 0x0e | MULTITAP_TIME4 |
| 0x0f | MULTITAP_TEMPO1 |
| 0x10 | MULTITAP_TEMPO2 |
| 0x11 | MULTITAP_TEMPO3 |
| 0x12 | MULTITAP_TEMPO4 |
| 0x13 | MULTITAP_LEVEL1 |
| 0x14 | MULTITAP_LEVEL2 |
| 0x15 | MULTITAP_LEVEL3 |
| 0x16 | MULTITAP_LEVEL4 |
| 0x17 | MULTITAP_FEEDBACK1 |
| 0x18 | MULTITAP_FEEDBACK2 |
| 0x19 | MULTITAP_FEEDBACK3 |
| 0x1a | MULTITAP_FEEDBACK4 |
| 0x1b | MULTITAP_PAN1 |
| 0x1c | MULTITAP_PAN2 |
| 0x1d | MULTITAP_PAN3 |
| 0x1e | MULTITAP_PAN4 |
| 0x1f | MULTITAP_RATE1 |
| 0x20 | MULTITAP_RATE2 |
| 0x21 | MULTITAP_DEPTH1 |
| 0x22 | MULTITAP_DEPTH2 |
| 0x23 | MULTITAP_LFOTYPE1 |
| 0x24 | MULTITAP_LFOTYPE2 |
| 0x25 | MULTITAP_LFOTEMPO1 |
| 0x26 | MULTITAP_LFOTEMPO2 |
| 0x27 | MULTITAP_LFOPHASE1 |
| 0x28 | MULTITAP_LFOPHASE2 |
| 0x29 | MULTITAP_INGAIN |
| 0x2a | MULTITAP_DIFFMIX |
| 0x2b | MULTITAP_DIFFTIME |
| 0x2c | MULTITAP_THRESH |
| 0x2d | MULTITAP_MSTRTIME |
| 0x2e | MULTITAP_MSTRLVL |
| 0x2f | MULTITAP_MSTRPAN |
| 0x30 | MULTITAP_MSTRFREQ |
| 0x31 | MULTITAP_MSTRQ |
| 0x32 | MULTITAP_MSTRFDBK |
| 0x33 | MULTITAP_MSTRRATE |
| 0x34 | MULTITAP_MSTRDEPTH |
| 0x35 | MULTITAP_FREQ1 |
| 0x36 | MULTITAP_FREQ2 |
| 0x37 | MULTITAP_FREQ3 |
| 0x38 | MULTITAP_FREQ4 |
| 0x39 | MULTITAP_Q1 |
| 0x3a | MULTITAP_Q2 |
| 0x3b | MULTITAP_Q3 |
| 0x3c | MULTITAP_Q4 |
| 0x3d | MULTITAP_ATTEN |
| 0x3e | MULTITAP_SPEED |
| 0x3f | MULTITAP_FBKSEND |
| 0x40 | MULTITAP_FBKRET |
| 0x41 | MULTITAP_LOWCUT |
| 0x42 | MULTITAP_HIGHCUT |
| 0x43 | MULTITAP_FEEDBACK |
| 0x44 | MULTITAP_RELEASE |
| 0x45 | MULTITAP_DRIVE |
| 0x46 | MULTITAP_FLTRATE |
| 0x47 | MULTITAP_FLTDEPTH |
| 0x48 | MULTITAP_FLTTYPE |
| 0x49 | MULTITAP_FLTTEMPO |
| 0x4a | MULTITAP_FLTPHASE |
| 0x4b | MULTITAP_ENVTHRESH |
| 0x4c | MULTITAP_ENVATTACK |
| 0x4d | MULTITAP_ENVRELEASE |
| 0x4e | MULTITAP_MSTRCOMBTIME |
| 0x4f | MULTITAP_MSTRCOMBGAIN |
| 0x50 | MULTITAP_COMBTYPE |
| 0x51 | MULTITAP_COMBTIME1 |
| 0x52 | MULTITAP_COMBTIME2 |
| 0x53 | MULTITAP_COMBTIME3 |
| 0x54 | MULTITAP_COMBTIME4 |
| 0x55 | MULTITAP_COMBGAIN1 |
| 0x56 | MULTITAP_COMBGAIN2 |
| 0x57 | MULTITAP_COMBGAIN3 |
| 0x58 | MULTITAP_COMBGAIN4 |
| 0x59 | MULTITAP_MSTRRINGFREQ |
| 0x5a | MULTITAP_MSTRRINGMIX |
| 0x5b | MULTITAP_RINGFREQ1 |
| 0x5c | MULTITAP_RINGFREQ2 |
| 0x5d | MULTITAP_RINGFREQ3 |
| 0x5e | MULTITAP_RINGFREQ4 |
| 0x5f | MULTITAP_RINGMIX1 |
| 0x60 | MULTITAP_RINGMIX2 |
| 0x61 | MULTITAP_RINGMIX3 |
| 0x62 | MULTITAP_RINGMIX4 |
| 0x63 | MULTITAP_DRATE1 |
| 0x64 | MULTITAP_DRATE2 |
| 0x65 | MULTITAP_DRATE3 |
| 0x66 | MULTITAP_DRATE4 |
| 0x67 | MULTITAP_DDEPTH1 |
| 0x68 | MULTITAP_DDEPTH2 |
| 0x69 | MULTITAP_DDEPTH3 |
| 0x6a | MULTITAP_DDEPTH4 |
| 0x6b | MULTITAP_INPUTSELECT |
| 0x6c | MULTITAP_MSTRDRATE |
| 0x6d | MULTITAP_MSTRDDEPTH |
| 0x6e | MULTITAP_FILTER_TYPE |
| 0x6f | MULTITAP_FREQ |
| 0x70 | MULTITAP_Q |
| 0x71 | MULTITAP_GAIN |
| 0x72 | MULTITAP_LOWSLOPE |
| 0x73 | MULTITAP_HIGHSLOPE |
| 0x74 | MULTITAP_DIFFRATE |
| 0x75 | MULTITAP_DIFFDEPTH |
| 0x77 | MULTITAP_FEEDBACK12 |
| 0x78 | MULTITAP_FEEDBACK23 |
| 0x79 | MULTITAP_FEEDBACK34 |
| 0x7a | MULTITAP_FEEDBACK41 |
| 0x76 | MULTITAP_TYPE |
