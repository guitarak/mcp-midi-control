# Captures: Axe-Fx III / FM3 / FM9 (gen-3)

The III, FM3, and FM9 share one codec. Captures that test the shared wire paths are listed here -- one confirmation from any of the three closes the gap for all of them. Device-specific data (FM9 amp model names) is noted where it applies to one device only.

**What's already confirmed (no capture needed):**
- Read path (fn=0x1F poll → 0x74/0x75/0x76 burst): confirmed on real FM9 hardware. Same codec = applies to III and FM3.
- Preset receive (fn=0x03 → 0x77/0x78/0x79 dump): confirmed on real FM9 hardware.
- Grid routing (fn=0x01 sub=0x35): confirmed from FM9-Edit and FM3-Edit loopMIDI captures.

One-time capture tool setup: [SETUP.md](SETUP.md) -- Windows ([usbpcap-wireshark.md](usbpcap-wireshark.md)) and Mac ([midi-monitor-mac.md](midi-monitor-mac.md)).

---

## C1 -- FM9 amp model sweep *(highest-value capture)*
**~20 min | [SETUP.md](SETUP.md) required | FM9 only**

**This is the single most impactful capture you can do.** Amp block selection by name ("Set up a Bogner Shiva clean") is the most-requested feature on gen-3 devices, and the FM9's full amp model list (roughly 280-320+ depending on firmware) can't be recovered from any file -- the names only exist on the device itself. Screenshots combined with a wire capture let us map every model name to its number.

**Why screenshots are required:** the wire capture only records the model number (e.g. "65"). Screenshots record the name ("SV Bass 2"). We need both together to build the lookup table.

**Steps:**

1. Load any preset with an Amp block placed. Open FM9-Edit.
2. **Before capturing:** Open the Amp block's **Model** dropdown and screenshot the full list -- scroll slowly until you've captured every model name. Multiple screenshots are fine.
3. Start the capture (USBPcap on Windows, MIDI Monitor on Mac).
4. With the capture running, step through the Model list **from top to bottom**, selecting each model and pausing ~2 seconds between selections. Go in the same order you photographed.
5. Stop and save the capture. Send the `.pcapng` **plus all screenshots** together.

**Partial is fine and still helps.** Even 30--40 models from the top of the list unlocks those for everyone. Reload the preset afterward to revert all changes -- nothing is permanently stored.

> **Note:** Just *opening* the dropdown doesn't send anything useful. Names only cross the wire when you *select* a model. You have to step through them one by one.

---

## C2 -- Write confirmation *(one device closes all three)*
**~10 min | [SETUP.md](SETUP.md) required | any III / FM3 / FM9**

Our server's SET builder (fn=0x01 sub=0x09, explicit effectId) is byte-verified against public captures but has never been confirmed to move a knob on real hardware via the server's own path.

- Start the capture. Note the preset, firmware, and editor version.
- Connect your device. Ask Claude to change a parameter visible on the front panel: "Set the reverb mix on my Axe-Fx."
- Note whether the panel moved. Stop and save the capture.
- Paste the JSON response and what the panel did in the [GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues).

One device confirming this closes the gap for all gen-3. Chat confirmation without a capture is also useful -- see the [testing guide for your device](#device-testing-guides).

---

## C3 -- Receive preset from device *(unlocks backup for III/FM3)*
**~5 min | [SETUP.md](SETUP.md) required | [Fractal-Bot](https://www.fractalaudio.com/fractal-bot/) required | III or FM3 only**

FM9 preset receive is confirmed. The III and FM3 share the same envelope but differ in frame count -- one receive capture from an III or FM3 confirms the frame count is correct.

- Start the capture. III or FM3 connected.
- In Fractal-Bot, choose **Receive** and grab a single preset from the device.
- Stop right after it finishes.

---

## C4 -- FM9 drive model sweep *(quick, pairs with C1)*
**~3 min | [SETUP.md](SETUP.md) required | FM9 only**

Same approach as C1 but for the Drive/Fuzz block's Model dropdown. Much shorter list. Do this right after C1 while the capture tool is still running.

If the FM9's Drive model ordinals line up with the AM4 drive list (likely), the names are already known offline and screenshots are optional for Drive: just the wire capture of the selections is enough. If they don't line up, screenshot the full list first, then select top-to-bottom in that order, exactly as in C1.

---

## Device testing guides

For no-tools verification (no capture needed), see the device-specific testing pages:
[III](testing-axe-fx-iii.md) | [FM3](testing-fm3.md) | [FM9](testing-fm9.md)

---

## Sending captures

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) with `.pcapng` and screenshots attached. Include: device model, firmware, loaded preset, editor version, one-line note of what you did. See [SETUP.md, "Where to send"](SETUP.md#where-to-send).

**Spec reference:** [Axe-Fx III MIDI for Third-Party Devices v1.4](https://www.fractalaudio.com/downloads/misc/Axe-Fx%20III%20MIDI%20for%203rd%20Party%20Devices.pdf)
