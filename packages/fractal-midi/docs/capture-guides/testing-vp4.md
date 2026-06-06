# Testing: VP4

> The VP4 **reads** are implemented (get_param, get_preset) and hardware-unverified. **Writes are gated** -- the serial block-placement wire shape is undecoded, so the tool refuses all writes until a capture confirms the path. See [captures-vp4.md](captures-vp4.md) for what unlocks writes.

See [README.md](README.md) for setup.

The VP4 is **AM4-shape**: a serial 4-slot effect chain with 4 scenes, A-D channels, and A01--Z04 preset locations. It has no amp/cab block.

---

## T1 -- What does the server see?
**~2 min | no tools**

In Claude Desktop with your VP4 connected:

> "What can you see about my VP4?"

Paste the response. Confirms detection and shape (4-slot serial chain).

---

## T2 -- Read the active preset
**~3 min | no tools**

> "What's loaded on my VP4 right now?"

The block list and preset name should match the panel. **A wrong block list or name is the single highest-value bug to report.**

---

## T3 -- Read a parameter
**~3 min | no tools**

> "Read the mix on the reverb."

Paste the JSON and what the panel shows. Try a delay or drive parameter too.

---

## T4 -- Confirm write gate fires
**~1 min | no tools**

Try a write request -- for example: "Set the reverb mix to 50%." The server should **refuse** with an "untested on hardware" message. Paste the response to confirm the gate fires correctly.

---

## T5 -- Probe

There is no standalone VP4 probe script yet (unlike the III / FM3 / FM9, which ship one). T1--T4 above cover the same ground through Claude Desktop on any platform, so no extra step is needed here. If a VP4 probe script is added later, it will appear in the install folder and this page will describe it.

---

## Submitting results

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) or reply to the Reddit thread. Include: VP4 firmware, loaded preset, VP4-Edit version.
