# Captures: Axe-Fx Standard / Ultra

> The gen-1 protocol documents both the SET message and the read path (function 0x02 query -> MIDI_PARAM_VALUE, and a whole-patch dump 0x03 -> 0x04). Both are decoded but unconfirmed on hardware. Old captures from a Standard or Ultra are still valuable: a device-to-host capture confirms the read path on real hardware AND helps decode the parts still undecoded -- chiefly the ~2060-byte PATCH_DUMP body (the parameter block beyond the name + effect grid).

No capture tool setup is required for C1 below -- just old files you may already have.

---

## C1 -- Legacy captures from AxeEdit or Fractal-Bot

If you have any of the following from a Standard or Ultra session, share them:

- `.pcapng` files from USBPcap / Wireshark
- `.syx` files exported from Fractal-Bot or AxeEdit
- Any MIDI Monitor logs (Mac)

What we're looking for: any **device-to-host** traffic (messages the hardware sends back to the computer). We've wired get_param from the spec, so a capture of a real MIDI_PARAM_VALUE response confirms it on hardware; a captured PATCH_DUMP (function 0x04) would let us finish decoding the patch body and add get_preset.

Even captures that are years old are useful. The wire protocol for the Standard/Ultra is fixed.

---

## Sending captures

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) with files attached, or email via the `author` field in the install folder's `package.json`. Include: device model (Standard vs Ultra), firmware version if known, and a one-line note of what the session was doing when the capture was taken.
