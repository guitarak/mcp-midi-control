# Axe-Fx II annotation-coverage proposed entries

> APPLIED. All 67 entries below were re-validated (each `parameterName`
> anchored to the SeekParamTablesII catalog at the shipping `paramId`, each
> `xmlLabel` taken verbatim from the AxeEdit `__block_layout` catalog) and
> applied to `packages/fractal-midi/src/gen2/axe-fx-ii/params.ts`. The validator
> and the idempotent apply step live at
> `scripts/_research/validate-ii-annotation-coverage.ts` and
> `scripts/_research/apply-ii-annotation-coverage.ts`; the regression golden
> is `packages/fractal-midi/test/gen2/axe-fx-ii/annotation-coverage.test.ts` (67
> cases). The two `pitch.voice_N_delay` rows carry `parameterName` only: their
> "Delay 1"/"Delay 2" label is shared with `PITCH_TIME1/2`, so `xmlLabel` was
> withheld. This section is retained as the decode record.

Paste-ready, zero-risk `parameterName` + `xmlLabel` annotations for
Axe-Fx II `params.ts` entries that already ship a correct wire address
(`paramId`) but lack the catalog symbol and the friendly display label.
Each entry is cross-referenced against two independent sources:

- the `SeekParamTablesII` Ghidra catalog (`(paramId, symbol)` pairs), and
- the AxeEdit `__block_layout` XML (control + `controlType` + label).

Every row below was spot-reproduced against both sources. These are
annotation-only: the wire address and control type are already known, so
no display-range capture is needed. Apply by adding the named fields to
the existing `params.ts` entry; do NOT create new entries and do NOT
change any shipping `paramId`.

## Hard rules before applying

- **`controlType` upgrades use `'knob'`, never `'slider'`.** The
  `AxeFxIIControlType` union is `'knob' | 'select' | 'switch' | 'unknown'`;
  `'slider'` is not a member and would fail `tsc --noEmit`. Continuous
  controls the XML draws as sliders map to `'knob'`.
- **`'select'`-typed entries (ranks 3 and 4) get `parameterName` +
  `xmlLabel` only.** Their `controlType: 'select'` and `enumValues` are
  already correct; do not touch them.
- **`OUTPUT_MAIN_SCENE` is NOT a wire param.** It is an XML display
  aggregate of the eight `output.scene_N_main` params and has no catalog
  `paramId`. Do not register it.
- **Re-grep the canonical short spellings before treating any name as
  missing** (per the param-coverage audit reflex), so a renamed-but-
  shipped entry is not double-added.

## Ranked clusters (zero-risk first, whole-block clusters highest)

1. **`amp.geq_band_1..8`** (`DISTORT_EQ1..8`, paramId 55-62). Catalog
   DISTORT 55-62; XML sliders labelled `63/125/250/500/1K/2K/4K/8K`.
   Ship as bare `'unknown'` with no `parameterName`. Add `parameterName`
   + `xmlLabel`, upgrade `controlType` to `'knob'`.
   ```
   "amp.geq_band_1": { groupCode: "AMP", block: "amp", paramId: 55, wikiName: "GEQ BAND 1", name: "geq_band_1", controlType: "knob", parameterName: "DISTORT_EQ1", xmlLabel: "63" },
   // repeat 2..8: paramId 56/57/58/59/60/61/62, symbol DISTORT_EQ2..8, xmlLabel 125/250/500/1K/2K/4K/8K
   ```

2. **`output.scene_1..8_main`** (`OUTPUT_MAIN1..8`, paramId 8-15).
   Catalog OUTPUT 8-15; XML sliders `Main Scene 1..8`. Add
   `parameterName` + `xmlLabel`, upgrade `controlType` to `'knob'`.
   ```
   "output.scene_1_main": { groupCode: "OUTPUT", block: "output", paramId: 8, wikiName: "SCENE 1 MAIN", name: "scene_1_main", controlType: "knob", parameterName: "OUTPUT_MAIN1", xmlLabel: "Main Scene 1" },
   // repeat 2..8: paramId 9-15, OUTPUT_MAIN2..8, "Main Scene 2..8"
   ```

3. **amp type-dropdown cluster** (already `'select'` with correct
   `enumValues`; add `parameterName` + `xmlLabel` only):
   - `amp.tone_stack` (paramId 34) `DISTORT_TONETYPE` / "Tonestack Type"
   - `amp.pwr_amp_tube` (68) `DISTORT_TUBETYPE` / "Power Tube Type"
   - `amp.preamp_tubes` (69) `DISTORT_PRETUBETYPE` / "Preamp Tube Type"
   - `amp.char_type` (102) `DISTORT_HMTYPE` / "Character Type"
   - `amp.cf_comp_type` (111) `DISTORT_PRECOMPTYPE` / "Preamp CF CompType"

4. **PEQ frequency-type cluster** (already `'select'` with correct
   `enumValues`; add `parameterName` + `xmlLabel` only):
   - `parametriceq.freq_type_1` (paramId 15) `PEQ_LFTYPE` / "Frequency 1 Type"
   - `parametriceq.freq_type_5` (16) `PEQ_HFTYPE` / "Frequency 5 Type"
   - `parametriceq.freq_type_2` (17) `PEQ_LMTYPE` / "Frequency 2 Type"
   - `parametriceq.freq_type_4` (18) `PEQ_HMTYPE` / "Frequency 4 Type"

5. **`reverb.spring_number`** (`REVERB_NUMSPRINGS`, paramId 23). Ships
   `'unknown'` with `displayMin 2 / displayMax 6 / step 1`. Add
   `parameterName` + `xmlLabel`, upgrade `controlType` to `'knob'`, keep
   the display range.
   ```
   "reverb.spring_number": { groupCode: "REV", block: "reverb", paramId: 23, wikiName: "SPRING NUMBER", name: "spring_number", controlType: "knob", parameterName: "REVERB_NUMSPRINGS", xmlLabel: "Number Springs", displayMin: 2, displayMax: 6, step: 1 },
   ```

6. **pitch voice cluster** (`parameterName` + `xmlLabel` only):
   `voice_1_pan`(15) `PITCH_PAN1`/"Pan 1"; `voice_2_pan`(16)
   `PITCH_PAN2`/"Pan 2"; `voice_1_feedback`(19) `PITCH_FEEDBACK1`/
   "Feedback 1"; `voice_2_feedback`(20) `PITCH_FEEDBACK2`/"Feedback 2";
   `voice_1_splice`(31) `PITCH_SPLICE1`/"V1 Splice"; `voice_2_splice`(32)
   `PITCH_SPLICE2`/"V2 Splice"; `amplitube_alpha`(76) `PITCH_AMPALPHA`/
   "Amplitude Alpha"; `amplitube_shape`(75) `PITCH_AMPSHAPE`/
   "Amplitude Shape".

7. **`pitch.voice_1_delay` / `voice_2_delay`** (`PITCH_DELAY1/2`, paramId
   17/18). CAVEAT: `pitch.time1`(79, `PITCH_TIME1`, xmlLabel "Delay 1")
   and `pitch.time2`(80, `PITCH_TIME2`, "Delay 2") already ship. The
   catalog symbol-to-pid mapping (DELAY1=17) is sound, but the XML
   "Delay 1"/"Delay 2" labels may bind `PITCH_TIME1/2`, not these. Add
   `parameterName: PITCH_DELAY1/2` (catalog-sound); re-check the
   `__block_layout.xml` `parameterName` attribute of the "Delay 1" /
   "Delay 2" controls before assigning `xmlLabel`, and leave `xmlLabel`
   off if those controls bind `PITCH_TIME1/2`.

8. **`synth.filter_1/2/3`** (`SYNTH_HICUT1/2/3`, paramId 9/20/38). XML
   knob "Filter" x3. Add `parameterName` + `xmlLabel` ("Filter").

9. **amp knob singletons** (already `'knob'`; add `parameterName` +
   `xmlLabel` only): `neg_feedback` `DISTORT_BETA`/"Negative Feedback";
   `cathode_resist` `DISTORT_CBRATIO`/"Cathode Resistance";
   `preamp_low_cut` `DISTORT_HPFREQ`/"Low Cut Freq"; `high_cut_freq`
   `DISTORT_LPFREQ`/"Hi Cut Freq"; `master_trim` `DISTORT_MVTRIM`/
   "Master Vol Trim"; `low_res` `DISTORT_SPKRLFGAIN`/"Low Resonance";
   `b_time_const` `DISTORT_TIMECONST`/"B+ Time Constant".

10. **remaining effect-block knob singletons** (`parameterName` +
    `xmlLabel` only): `cab.air_freq` `CABINET_DIRECTFREQ`/"Air Frequency";
    `cab.motor_time_constant` `CABINET_TIMECONST`/"Motor Time Const";
    `chorus.high_cut` `CHORUS_HICUT`/"Hi Cut"; `compressor.treshold`
    `COMP_THRESH`/"Threshold" (keep the existing canonical-key typo, do
    not rename the key); `delay.duck_attn` `DELAY_ATTEN`/"Ducker Atten";
    `delay.lfo1_depth_range` `DELAY_MAXDEPTH`/"Depth Range";
    `delay.duck_thres` `DELAY_THRESH`/"Ducker Threshold"; `drive.gain`
    `FUZZ_DRIVE`/"Drive"; `drive.volume` `FUZZ_LEVEL`/"Level"
    (FUZZ is a DRIVE-block type); `flanger.high_cut` `FLANGER_HICUT`/
    "Hi Cut"; `flanger.lfo_highcut` `FLANGER_LFOFILTER`/"LFO Hicut";
    `flanger.dry_delay_shift` `FLANGER_MANUAL`/"Dry Delay";
    `looper.thres_level` `LOOPER_THRESHLEV`/"Threshold Level";
    `multidelay.master_freq` `MULTITAP_MSTRFREQ`/"Master Frequency";
    `multidelay.ducker_thres` `MULTITAP_THRESH`/"Ducker Threshold";
    `phaser.freq_span` `PHASER_FSPAN`/"Frequency Span"; `phaser.freq_start`
    `PHASER_FSTART`/"Frequency Start"; `ringmod.f_multiplier`
    `RINGMOD_FINE`/"Frequency Multiplier"; `wah.freq_min` `WAH_FSTART`/
    "Frequency Min"; `wah.freq_max` `WAH_FSTOP`/"Frequency Max";
    `wah.low_cut_freq` `WAH_HPF`/"Low Cut Frequency".

## Naming note, groupCode DRV maps to Ghidra family FUZZ

When joining the shipped catalog against the SeekParamTablesII Ghidra catalog,
the shipped `groupCode: "DRV"` (Drive block, wire effectId 133/134) maps to the
Ghidra **`FUZZ`** family, not `DISTORT`. `DISTORT` is the AMP block's preamp
(118 params). A naive Ghidra-driven coverage pass that matches `DRV` to the
118-param `DISTORT` table would file ~97 false "missing DRV params", they are
the amp, already shipped under `groupCode: "AMP"`. Confirmed by this pass:
`drive.gain` -> `FUZZ_DRIVE`, `drive.volume` -> `FUZZ_LEVEL` both validate at
the shipping paramId. Apply the family map (`DRV` -> `FUZZ`) before any future
diff so the audit does not chase phantom gaps.

## Genuinely hardware-gated (NOT in the zero-risk set)

- **`pitch.tonic`** (`PITCH_TONIC`): XML `dropdownsmall` "Tonic", absent
  from the Ghidra catalog, so its wire `paramId` is unknown. Pitch ships
  paramIds 0-85 contiguously (paramId 8 is `pitch.track_mode`, NOT free),
  so the probe must target the first id at or above 86. See the
  hardware-probe queue (`PROBE-II-PITCH-TONIC`).
