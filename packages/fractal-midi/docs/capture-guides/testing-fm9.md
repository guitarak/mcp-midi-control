# Testing: FM9

> The FM9 is the most confirmed gen-3 device. A community FM9 owner (fw 11.0, 2026-06-06) confirmed the foundation directly on hardware: model byte 0x12 echoes a QUERY PATCH NAME, scene switching (fn 0x0C) and STATUS_DUMP (fn 0x13) framing match the III family, and the unit answers a Fractal-native query (no Universal Identity Reply). FM9-Edit traffic also confirms the read and whole-preset wire shapes.
>
> **The two highest-value gaps that remain, in order:**
> 1. **Write path end-to-end** — the server's own explicit-effectId parameter SET (fn=0x01, our builder) has not been confirmed moving a value on the front panel (the existing hardware capture used FM9-Edit's *selected-block* sub-action, a different wire path). T3 below + [captures-gen3.md C2](captures-gen3.md#c2----write-confirmation-one-device-closes-all-three) close this. **This is the single ask that flips FM9 writes from gated to confirmed.**
> 2. **Amp/drive model names** — the on-device roster, recoverable only from the unit. See [captures-gen3.md C1](captures-gen3.md#c1----fm9-amp-model-sweep-highest-value-capture).
>
> T2--T3 below confirm the server end-to-end with your specific firmware.

See [README.md](README.md) for setup.

---

## T1 -- What's loaded?
**~2 min | no tools**

In Claude Desktop with your FM9 connected:

> "What's loaded on my FM9 right now?"

The preset number and name should match the panel. **A wrong name is the single highest-value bug to report.**

---

## T2 -- Read a parameter
**~3 min | no tools**

> "Read the drive on Amp 1."

Paste the JSON and what the front panel shows. Also try bypass and channel.

---

## T3 -- Write a parameter
**~3 min | no tools**

> "Set Amp 1 drive to 5.5, then read it back."

Report whether the front panel moved. If it reports success but the panel doesn't change, paste both responses.

---

## T4 -- Probe (Windows only)
**~5 min | no capture tools | Windows**

Quit FM9-Edit first (so it isn't holding the port), then double-click **`fm9-probe.cmd`** in the install folder. Send back `fm9-probe-output.json` from your Desktop. Read-only.

*Mac users: the probe runs via `npm run fm9:probe` in the install directory terminal. T1--T3 above cover the same ground without it.*

---

## Submitting results

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) or reply to the Reddit thread. Include: FM9 firmware, loaded preset, and what the panel did.
