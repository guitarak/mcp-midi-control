# VP4 SysEx map

**Authoritative source for the VP4 protocol layer.** The VP4 (model byte `0x14`)
is a gen-3 Fractal effects pedal: it shares the III's SysEx envelope, XOR checksum,
septet encoding, and block effect-ID table, but is AM4-shape on the panel (serial
4-slot chain, 4 scenes, A-D channels, A01-Z04 locations, no amp/cab). See the
III map for the shared family layer; this doc records VP4-specific, **hardware-confirmed**
wire shapes.

## Capture provenance

- **`samples/captured/vp4-edit-preset-sync-poll-fw403-kevin-iudicello-2026-06-08.mmon`**
  (MIDI Monitor macOS spying capture; VP4 fw **4.03**; VP4-Edit open). Community
  capture from Kevin Iudicello, 2026-06-08. Decode + scripts:
  `samples/captured/decoded/vp4-403/` (gitignored), full writeup in `FINDINGS.md` there.
  1000 frames, 100% `fn=0x01`, all checksum-valid. The file is the **last 2.58 s tail of a
  longer session** (exactly 1000 messages, no handshake, starts mid-poll): VP4-Edit polls at
  ~390 msg/s and MIDI Monitor's message cap evicted the earlier edit-writes, so what
  survived is pure read-poll. Writes were made during recording but aged out of the buffer.
- **`samples/captured/vp4-edit-edit-session-fw403-kevin-iudicello-2026-06-09.mmon`**
  (same setup, **buffer raised**). Community capture, 2026-06-09. Decode:
  `samples/captured/decoded/vp4-403-v2/FINDINGS.md`. 27,104 frames / 79 s / 100% `fn=0x01` /
  all checksum-valid. **Contains the writes** — an annotated edit session (move / param drag
  / save / scene / bypass / save). This is the source for the **PARAMETER SET** section below.

## Envelope (confirmed on VP4 fw 4.03)

```
F0 00 01 74 14 cc dd ... cs F7
```
- `00 01 74` Fractal mfr prefix; `14` VP4 model byte.
- `cc` function opcode.
- `cs` = `XOR(F0..last payload byte) & 0x7F`. **1000/1000 frames pass.**

## fn=0x01 PARAMETER GET — query (✅ confirmed)

VP4-Edit reads every parameter with `fn=0x01` and **no sub-action** (this differs
from the III SET frame, which carries a `09 00`/`52 00` sub-action at pos 6-7, and
from `fractal-midi`'s `buildGetParameter`, which injects `09 00`). 16-byte query
(18 with F0/F7):

```
F0 00 01 74 14 01 [eid_lo eid_hi] [pid_lo pid_hi] [tc] 00 00 00 00 cs F7
pos:           5   6      7         8      9        10
                  └ effectId 14b ┘ └ paramId 14b ┘  └ typecode
                  LSB-first septet  LSB-first septet
```

`typecode` selects the response representation:

| tc | meaning | response length |
|------|---------|-----------------|
| `0x0d` | full value + descriptor | 62 B (78 B for some) |
| `0x26` | compact scalar value (4-byte LE int) | 21 B |
| `0x1f` | large septet-packed blob (routing/grid descriptor) | 236 B |

Example query (Delay block, DELAY_TIME): `F0 00 01 74 14 01 46 00 0C 00 26 00 00 00 00 XX F7`.

**typecode is param-type-driven, not a free choice.** Each paramId has a fixed read
form: for the Delay block, pid 10/2013/2022 are read only via `0x0d`; pid 0/1/12/14/
31/46/82/84 only via `0x26`; pid 3 (BYPASS) is the lone dual-read.

## fn=0x01 PARAMETER GET — response (✅ shape confirmed; value calibration open)

`0x0d` form (bytes shown F0-stripped, as MIDI Monitor stores them):
```
[eid:2] [pid:2] 0d 00 00 00 [marker] [.. value + descriptor ..] cs
                            pos13
```
- `marker` is a count-like field (`0x28`=40 typical; `0x36`=54 for the larger
  pid-2013 descriptor).
- **Global telemetry field** at data[17-18] of the **62-byte** form: identical across
  ALL blocks within one poll cycle, cycling among 4 values (`00 00`/`04 60`/`0c 30`/
  `0b 20`) over ~9 transitions — a per-poll device broadcast (meter/tempo/heartbeat),
  **not** stored data. In the **78-byte** form (always pid 2013) data[17-18] is instead
  stable per-eid (stored descriptor), so scope the telemetry reading to the 62-byte form.

`0x26` form: length-prefixed `… 26 00 00 00 04 [4 bytes]` (`04` = byte-count). Every
sampled Delay param returned `00 00 00 00`, including a present block's LEVEL/MIX — so
treat `0x26` as an unconfirmed value read, not a reliable scalar, until a param-change
capture confirms its semantics.

`0x1f` form: 221-byte septet-packed routing/grid descriptor (eid 206). Across its 6
reads it is byte-identical except a 5-byte telemetry region (payload offsets 14-18) —
i.e. the stored chain layout is stable. Field-level decode (slot assignment) is **not
yet done**; needs a before/after block-move capture to isolate the slot field.

## Block effect-ID addressing (✅ confirmed == shared gen-3 table)

The effectId field is the **shared gen-3 block table** (`axe-fx-iii/blockTypes.ts`).
Confirmed values from the capture (preset was 4CM: WAH, DRV, 4CM, PHR, DLY):

| eid | block | note |
|----:|-------|------|
| 70  | Delay #1 | matches "DLY" |
| 90  | Phaser #1 | matches "PHR" |
| 94  | Wah #1 | matches "WAH" |
| 118 | Drive #1 | matches "DRV" |
| 2   | Controllers | preset modifiers |
| 1   | VP4 system block | global/meta (id < III roster) |
| 206 | VP4 system block | routing/grid descriptor (6× `0x1f` blobs); id beyond III roster |

All effect blocks address as a single instance (`#1`) — consistent with VP4's serial
single-row design.

## Param catalog — device-true mine validated on hardware

For the fully-read Delay block, every observed paramId is present in the VP4-Edit-mined
catalog (`src/gen3/vp4/params.ts`) at its device-true offset:
`10=DELAY_MODEL, 12=DELAY_TIME, 14=DELAY_FEED, 31=DELAY_HOLD, 46=DELAY_ATTEN,
82=DELAY_RATE4, 84=DELAY_DEPTH4` + BLOCK wrapper `0=LEVEL, 1=MIX, 3=BYPASS`. This is
the first hardware confirmation that the mined VP4 paramIds are the real wire paramIds.

**Meta-registers** `2013` (0x7DD) and `2022` (0x7E6) are NOT in the XML mine — firmware
status/type/descriptor registers the editor uses to discover slot contents. `2022` is
read on all 7 effectIds; `2013` only on {2,70,90,94,118} (not the system blocks eid1 /
eid206). Not added to the catalog (not guessed).

## fn=0x01 PARAMETER SET — write (✅ decoded from the 2026-06-09 edit-session capture)

Second community capture (`vp4-edit-edit-session-fw403-kevin-iudicello-2026-06-09.mmon`;
fw 4.03; 27,104 frames / 79 s / all checksum-valid; buffer raised so writes were retained).
69 write frames decoded, mapped 1:1 to an annotated action sequence (move / param drag /
save / scene / bypass / save). Full writeup: `samples/captured/decoded/vp4-403-v2/FINDINGS.md`.

**Write frame (21 B), same eid/pid layout as the GET — the `tc` byte is the sub-opcode:**
```
F0 00 01 74 14 01 [eid_lo eid_hi] [pid_lo pid_hi] [tc] 00 00 00 04 00 [value:5] cs F7
pos:           5   6      7         8      9        10 11 12 13 14 15..19
                  └ effectId 14b ┘ └ paramId 14b ┘  tc          └ value (5 septets)
```
No `09 00`/`52 00` sub-action (consistent with the GET and the FM-family finding).

**`tc` sub-opcodes:**

| tc | meaning |
|------|---------|
| `0x01` | discrete SET (bypass, scene, routing, type selects) |
| `0x02` | continuous / drag SET (knob sweep) |
| `0x17` | begin/end-edit gesture marker (carried on pid `16001`/`0x7D01`, value 0) |
| `0x1b` | **SAVE / store preset** |
| `0x00` | Controllers (modifier) refresh |

**Value encoding (cracked):** the 5 value bytes `[d15,d16,d17,d18,d19]` map to septets
`[s0,s1,s2,s4,s3]` — i.e. **d18 = s4 (high septet), d19 = s3** (the top two septets are
swapped vs normal LE order):
```
u32 = s0|s1<<7|s2<<14|s3<<21|s4<<28  (s0=d15 s1=d16 s2=d17 s3=d19 s4=d18)  →  float32(u32)
```
(The non-swapped order decodes to ~1e-36 garbage, confirming the swap.) Continuous params
carry a **normalized [0,1]** float (same as the III continuous SET, plus the VP4 septet-swap);
commands/discrete carry a small raw int in the low septet. **Calibration is single-point and
soft:** the Delay feedback drag (`eid70 pid14 tc02`) decodes to plausible normalized floats in
two oscillating clusters (early ≈0.50–0.60, first frame 0.503; late ≈0.13–0.16) — consistent
with 15%→negative but NOT an exact `%`↔normalized map (the late cluster back-solves to ≈-71%,
not Kevin's "-45% or so"). Treat continuous display calibration as undecoded.

**Confirmed command frames:**
- **SAVE** (byte-identical both times Kevin saved):
  `F0 00 01 74 14 01 00 00 00 00 1B 00 00 00 04 00 30 00 00 00 00 3F F7` (eid0 pid0 tc1b, val 0x30).
  → answered by a distinct 16-byte **completion ack** ~+153 ms:
  `F0 00 01 74 14 01 00 00 00 00 1B 00 00 00 00 00 0B F7` (value zeroed; byte-identical both saves).
- **BLOCK BYPASS**: `eid<block> pid3 tc01` — enable = float **0.0**; bypass-on = `00 00 10 03 78`
  (decodes 0.5156 — replicate verbatim, undecoded as a boolean). Note: the pid3 `0x0d`
  **readback** field is telemetry (cycles in lockstep across all blocks, collides with the
  bypass-on value), so it cannot confirm bypass state — use the write echo.
- **PARAM SET continuous**: `eid pid tc02` + normalized float (Delay feedback example above).
- **BLOCK PLACEMENT / routing**: `eid206 pid10..16 tc01`. NOT one atomic cascade — `pid10`
  (val→33.5) fired at 4.78 s, `pid15`/`pid16` (val→33.06) together at 10.73 s, ~6 s apart =
  two separate gestures. Placement STATE lives in the septet-packed `eid206 pid0 0x1f` blob.
  Value→slot math **not decoded** (needs isolated single moves).
- **SCENE switch**: `eid206 pid13 tc01` (value `0x01` for a 1→3 switch — value↔scene mapping
  to confirm; no readable register exposes scene index in this capture).

**Other meta-register:** `pid 2028` (0x7EC) — 163-byte `0x0d` descriptor responses on effect
blocks {66,70,78}, clustered around edits. A third firmware descriptor register alongside 2013/2022.

**Acknowledged-write contract (CORRECTED):** **every write IS synchronously echoed** — all
69/69 writes are answered by the immediately-following From-VP4 frame (~+1 ms) with the same
eid/pid/tc and the value echoed verbatim for discrete writes (consistent with the III's
synchronous value-echo). Confirm a write by matching that echo; have `save_preset` wait for
the 16-byte SAVE ack above. Do NOT use `get_param` for confirmation (telemetry-mixed readback
+ our shared GET uses the unconfirmed fn=0x1F path).

## Codec change plan (CORRECTED after review — see `vp4-403-v2/CODEC-PLAN.md`)

1. Add VP4-specific builders in `fractal-midi/src/gen3/vp4/setParam.ts` (NOT a mutation of the III
   builders — III divergence is total): the swapped-septet float32 primitive + `buildVp4Save`,
   `buildVp4SetBypass`, a write-echo parser, and (scoped) `buildVp4SetParam`. Golden cases +
   a cookbook entry + `cookbook-verify`/`verify-msg` cases (preflight requires them).
2. **Shipped community-beta `untested`** (in `fractal-gen3` via `write_allowlist`):
   continuous `set_param`/`set_params` (raw 0..65534 wire value → normalized float; %/ms
   calibration pending), `set_bypass` (enable=0.0 / bypass-on replicated), `save_preset`
   (exact frame). DISCRETE `set_param` (enum/type) refuses — zero captured evidence.
3. Keep **block placement / `set_block` / `apply_preset`** gated — the value→slot math is
   genuinely undecoded (we cannot construct a move), not merely untested.
4. Keep **`switch_scene`** gated (value↔scene mapping unconfirmed).
5. Use the **synchronous echo** for confirmation (not `get_param`); per-capability gate map with
   default-refuse for unproven capabilities; rewrite the `vp4.ts` `beta_status`/`device_note`
   strings (they currently say "READS ONLY").

## Not yet decoded / still gated

- **Block placement value→slot math** (`eid206 pid10–16` routing) — frames known, encoding
  open. The one capability that stays gated.
- **Scene value↔index** and the **bypass "bypassed" value** (enable=0.0 is solid).
- **Continuous-param display calibration** beyond normalized [0,1] (per-param % / ms / Hz
  range) and the `0x1f` routing-blob field layout.
- **eid206 compact registers are the prime next target.** Beyond the pid-0 `0x1f` blob,
  eid206 exposes `0x0d` registers pid 19/20/21/22 (read 6× each; 19/21 share one record,
  20/22 another — likely 4 slots or 4 scenes paired) and pid 63 (read 23×, a stable
  20-byte packed descriptor). These are the most decodable candidates for the serial
  slot layout + Scene state and should be mined before the 221-byte septet blob.
- **Negative results** (do not re-chase): the preset name "Y1: Main Bank" is NOT in the
  capture (no ASCII even after a 7-in-8 unpack — the name register wasn't polled); no
  4CM-separator / send-return block was polled (the 4CM routing is not a polled block or
  lives inside the eid206 descriptor).
- **Read-path action item:** `fractal-gen3` ships an `fn=0x1F` bulk-poll reader; this
  capture shows VP4-Edit uses `fn=0x01` GET instead and contains no `fn=0x1F`. Whether
  VP4 answers `fn=0x1F` at all is unconfirmed. Consider adding an `fn=0x01` GET
  reader/parser for VP4. (Flagged here; `fractal-gen3` codec owned by another session.)
