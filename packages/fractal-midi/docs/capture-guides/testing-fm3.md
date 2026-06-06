# Testing: FM3

> **Highest value:** the write confirmation (T3 below). Nothing has been confirmed on real FM3 hardware yet. The FM3 shares the gen-3 codec with the III and FM9 -- any result here advances all three.

See [README.md](README.md) for setup. Want to record captures too? See [captures-gen3.md](captures-gen3.md).

Note: the FM3 runs a **4-row, 12-column effect grid** (the FM9/III use a 6-row, 14-column grid). That only matters for `set_block`.

---

## T1 -- What does the server see?
**~2 min | no tools**

In Claude Desktop with your FM3 connected:

> "What can you see about my FM3?"

Paste the response. Confirms detection and device routing.

---

## T2 -- Read a parameter
**~3 min | no tools**

Load a preset with a reverb or delay block:

> "What's loaded on my FM3 right now?"

The preset number and name should match the panel. **A wrong name is the single highest-value bug to report.** Then:

> "Read the drive on Amp 1."

Paste the full JSON and what the front panel shows.

---

## T3 -- Write a parameter *(most critical)*
**~3 min | no tools**

> "Set Amp 1 drive to 5.5, then read it back."

Report whether the front panel moved and paste both responses. The write opcode is shared with the III but unconfirmed on FM hardware. If it reports success but the panel doesn't change, paste both responses -- that's the most valuable finding.

---

## T4 -- Save a preset
**~5 min | no tools**

> "Save this preset to location 5."

Report whether it landed: check the preset name at that location after saving.

---

## T5 -- Probe (Windows only)
**~5 min | no capture tools | Windows**

Quit FM3-Edit, then double-click **`fm3-probe.cmd`** in the install folder. Send back `fm3-probe-output.json` from your Desktop. Read-only -- never changes a preset.

*Mac users: the probe runs via `npm run fm3:probe` in the install directory terminal. T2--T4 above cover the same ground without it.*

---

## Submitting results

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) or reply to the Reddit thread. Include: FM3 firmware, loaded preset, FM3-Edit version, and what the panel did.
