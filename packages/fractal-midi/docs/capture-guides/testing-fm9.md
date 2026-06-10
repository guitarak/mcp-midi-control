# Testing: FM9

> The FM9 is the most confirmed gen-3 device. A community FM9 owner (firmware 11.0) confirmed the foundation directly on hardware: the server correctly identifies the unit, reads preset and parameter data, and switches scenes. Captured FM9-Edit traffic also confirms the read and whole-preset wire shapes. (Wire-level detail: model byte 0x12, scene switching fn 0x0C, STATUS_DUMP fn 0x13, all matching the III family.)
>
> **The single highest-value ask is the write-verify probe (T2 below).** The server's own explicit-effectId parameter SET (fn=0x01, our builder) has not been confirmed moving a value on the front panel; the existing hardware capture used FM9-Edit's *selected-block* sub-action, a different wire path. The `fm9-verify` probe is the one ask that flips FM9 writes from gated to confirmed. **Run it first.**
>
> The FM9's model rosters and parameter ranges are complete (a community cache file closed them; set-by-name works for the whole amp space). The one remaining capture ask is a single log-taper knob SET capture: see [captures-gen3.md C1](captures-gen3.md). For everything else the device can report about itself, the one-command read-only [harvest script](harvest-script.md) covers it with no capture tools.

See [README.md](README.md) for setup. Want to record raw protocol captures? See [captures-gen3.md](captures-gen3.md).

---

## T1 -- What's loaded?
**~2 min | no tools**

In Claude Desktop with your FM9 connected:

> "What's loaded on my FM9 right now?"

The preset number and name should match the panel. **A wrong name is the single highest-value bug to report.**

---

## T2 -- Run the probes *(highest value, do this one)*
**~5-10 min | no capture tools | Windows: double-click | Mac / source: one command**

**Quit FM9-Edit first** (it holds the USB port). There are two probes. Both are
**safe**: they never save, and the verify probe sets a restore point and reloads
your preset at the end (and on Ctrl-C / error), so the device ends exactly where
it started.

### Probe 2 -- write-verify (confirms your FM9 ACCEPTS our writes)
**This is the single highest-value result on this page** -- it flips FM9 writes
from gated to confirmed (see the gap note at the top).
- **Windows:** double-click **`fm9-verify.cmd`** in the install folder.
- **Mac / source checkout:** `npm run fm9:verify`.
- Send back the JSON it writes, plus a note of anything the front panel did.

### Probe 1 -- read-back (confirms we can READ your FM9)
- **Windows:** double-click **`fm9-probe.cmd`** in the install folder.
- **Mac / source checkout:** `npm run fm9:probe`.
- Send back the **`fm9-probe-output.json`** it writes to your Desktop.

*Don't have the `.cmd` files? They ship in the release ZIP's install folder. From
a source checkout use the `npm run` commands above.*

---

## T3 -- Read a parameter
**~3 min | no tools**

> "Read the drive on Amp 1."

Paste the JSON and what the front panel shows. Also try bypass and channel.

---

## T4 -- Write a parameter *(conversational version of the T2 verify probe)*
**~3 min | no tools**

> "Set Amp 1 drive to 5.5, then read it back."

Report whether the front panel moved. If it reports success but the panel doesn't change, paste both responses. (The T2 `fm9-verify` probe is the more rigorous form of this check; this is the quick conversational version.)

---

## Submitting results

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) or reply to the Reddit thread. Include: FM9 firmware, loaded preset, and what the panel did.
