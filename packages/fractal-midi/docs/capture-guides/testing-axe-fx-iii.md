# Testing: Axe-Fx III

> **Highest value:** the write confirmation (T2 below). The codec is verified from public captures but has never moved a knob on real III hardware via the server. A one-sentence "yes, the panel changed" closes this gap.

See [README.md](README.md) for setup. Want to record captures too? See [captures-gen3.md](captures-gen3.md).

---

## T1 -- What does the server see?
**~2 min | no tools**

In Claude Desktop with your III connected:

> "What can you see about my Axe-Fx III?"

Paste the response. Confirms detection and device routing. A missing or wrong device name means the port matcher needs adjustment.

---

## T2 -- Read a parameter
**~3 min | no tools**

Load a preset with a reverb or delay block. Ask:

> "What's the current reverb type on my Axe-Fx III?"

Paste the full JSON response and what the front panel shows. A working response shows the parameter name and a value. Note: many amp and reverb knobs are display-calibrated and read back as a panel-style number (drive, treble, master read as `0..10`); enum types like reverb type read back as a name or ordinal; any uncalibrated param still returns a raw `0..65534` integer and the response says so. What matters is that it returns *something* and that reading it back after a write round-trips.

---

## T3 -- Write a parameter *(most critical)*
**~3 min | no tools**

> "Set the Amp 1 drive to 5.5, then read it back."

Report whether the front panel moved and paste both responses. If it reports success but the panel doesn't change, that's the most valuable finding -- paste both responses.

This is the single highest-value test: the SET opcode is verified from 10+ public captures but has never been confirmed to move a knob via the server's own path on real III hardware.

---

## T4 -- Save a preset
**~5 min | no tools**

> "Save this preset to location 5."

Check the preset name at location 5 after saving and report whether it landed. The save envelope is hardware-unverified on gen-3.

---

## T5 -- Probe (Windows only)
**~5 min | no capture tools | Windows**

A read-only diagnostic that ships with the tool. It polls your active preset, runs a few read-only queries, and writes a JSON to your Desktop. It never writes or changes a preset.

Quit Axe-Edit III, then double-click **`axefx3-probe.cmd`** in the install folder. Send back `axefx3-probe-output.json` from your Desktop.

*Mac users: the probe runs via `npm run axefx3:probe` in the install directory terminal. T2--T4 above cover the same ground without it.*

---

## Submitting results

Paste JSON responses and front-panel observations in a [GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`). No GitHub account? Reply to the Reddit thread.

Include: III firmware version, the loaded preset (number and name), and what the panel did for each ask.
