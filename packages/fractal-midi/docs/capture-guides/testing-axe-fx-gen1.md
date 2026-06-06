# Testing: Axe-Fx Standard / Ultra

> Gen-1 supports both **writing** parameters (922 of them) and **reading** them back: the gen-1 protocol documents a parameter query (function 0x02 with the set/query flag cleared) that returns the live value plus the device's own label. All of it is decoded from the spec but UNCONFIRMED on real Standard/Ultra hardware. The asks below take about 5 minutes combined and confirm what we can't verify from the spec alone.

See [README.md](README.md) for setup. Have old AxeEdit captures? See [captures-axe-fx-gen1.md](captures-axe-fx-gen1.md).

---

## T1 -- Port name (highest value, 2 min)
**~2 min | no tools**

In Claude Desktop:

> "List the available MIDI ports."

Paste the full output. The gen-1 descriptor uses a specific port-name pattern (`axe-?fx.*ultra|standard`) to route to the correct codec. Older hardware may enumerate as "Axe-Fx MIDI" or similar, which would route to the wrong codec (gen-2). Your output is the only thing needed to confirm or fix this before you try anything else.

---

## T2 -- Write confirmation
**~3 min | no tools**

Ask Claude to change any parameter you can see on the front panel:

> "Set the amp gain to 7 on my Axe-Fx."

Confirm the front panel moved and paste the response. The nibble-split codec is decoded byte-exactly from the published gen-1 SysEx spec, but has never been confirmed on real hardware.

---

## T3 -- Read confirmation *(new)*
**~2 min | no tools**

Pick a parameter you can see on the front panel, then ask Claude to read it:

> "What's the amp gain on my Axe-Fx right now?"

Paste the response and compare its value/label to the front panel. If it reports a value that matches, gen-1 read-back works on your hardware -- a big deal, because it's never been confirmed. If it times out (`no_ack`) or reports a wrong value, that's the most valuable thing to report: paste the full response and note your firmware version.

---

## Submitting results

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) or reply to the Reddit thread. Include your exact USB port name (from T1), whether the panel moved (T2), and whether the read matched (T3). Firmware version and model (Standard vs Ultra) are also helpful.
