# Captures: VP4

> VP4 writes are fully gated until two wire shapes are confirmed: the parameter SET path and the serial block-placement envelope. These two captures unlock the entire write surface. The VP4 reuses the gen-3 effects codec, so any confirmed writes also validate assumptions shared with the III/FM3/FM9.

One-time capture tool setup: [SETUP.md](SETUP.md) -- Windows (USBPcap + Wireshark) and Mac ([MIDI Monitor](midi-monitor-mac.md)).

---

## C1 -- Parameter SET (unlocks set_param)
**~10 min | [SETUP.md](SETUP.md) required**

- Start the capture. Note preset, firmware, VP4-Edit version.
- Open/reload the preset in VP4-Edit.
- Click one block (Reverb, Delay, or Drive) and turn one knob, noting before/after on the **front panel**.
- Stop and save.

This shows whether the VP4's `fn=0x01` SET wire shape matches the gen-3 pattern. It's the primary gate for all writes.

---

## C2 -- Block placement / move (unlocks set_block + apply_preset)
**~5 min | [SETUP.md](SETUP.md) required**

This is the **serial block-placement wire shape** -- undecoded today and the main blocker for authoring presets on the VP4.

- Start the capture.
- Add a block to an empty slot in VP4-Edit.
- Move a block from one slot to another, noting the slot numbers (1--4).
- Stop and save.

---

## C3 -- Receive preset from device (unlocks backup/export)
**~5 min | [SETUP.md](SETUP.md) required | [Fractal-Bot](https://www.fractalaudio.com/fractal-bot/) required**

- Start the capture. VP4 connected.
- In Fractal-Bot, choose **Receive** and grab a single preset from the device.
- Stop right after it finishes.

---

## Sending captures

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) with `.pcapng` attached. Include: VP4 firmware, loaded preset, VP4-Edit version, one-line note of each action. See [SETUP.md, "Where to send"](SETUP.md#where-to-send).
