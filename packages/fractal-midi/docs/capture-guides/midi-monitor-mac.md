# MIDI Monitor capture guide (macOS)

MIDI Monitor by Snoize is the standard tool for capturing SysEx traffic on Mac. It captures at the CoreMIDI layer, which means it sees all MIDI messages in both directions -- including what AxeEdit or another editor sends to your device. No kernel extension or system extension approval required on macOS Ventura / Sonoma / Sequoia with MIDI Monitor 2.x.

Download: [snoize.com/midimonitor](https://www.snoize.com/midimonitor/)

## When to use this guide

Use this when you want to capture what a Fractal editor (AxeEdit III, FM3-Edit, FM9-Edit) sends to your device while it connects and syncs. This is the Mac equivalent of the [USBPcap + Wireshark](usbpcap-wireshark.md) guide used on Windows.

## Enabling spy mode

MIDI Monitor has two capture modes:

- **Standard mode**: shows messages your device sends to the computer (device-to-host only)
- **Spy mode**: also shows messages other apps send to MIDI ports (host-to-device, including what the editor writes)

For capturing editor traffic, spy mode is required.

1. Open MIDI Monitor.
2. Open **Preferences** (Cmd+,).
3. Check **"Spy on output to destinations"** (the label may vary by version -- look for anything mentioning "spy" or "output").
4. If prompted to grant access or approve a background helper, allow it.
5. Close Preferences. The title bar will show "MIDI Monitor (Spy Active)" or similar when spy mode is running.

## Capturing an editor sync session

1. Connect your Axe-Fx III (or FM3 / FM9) via USB.
2. Open MIDI Monitor with spy mode active.
3. In the Sources panel, make sure your Axe-Fx is listed. Both directions ("in" and "out" ports, if shown separately) should be checked.
4. Open AxeEdit III and let it fully connect and sync to the device. Wait until the editor finishes loading -- preset list populated, grid rendered, no loading spinners.
5. Once sync is complete, stop the session. In MIDI Monitor: **File > Save As** and save as a `.mmon` file (MIDI Monitor's native format) or use **File > Export > SysEx** / copy-paste the message log.

If you're not sure the sync is complete, make a small change in the editor (like clicking a block type) and wait a moment. The editor should settle.

## What to share

Share the saved `.mmon` file or a plain-text copy of the message log. Both work for decode analysis. GitHub issues accept file attachments directly.

If spy mode doesn't show editor-to-device traffic (the messages appear empty when the editor is open), try restarting MIDI Monitor after enabling spy mode, or confirm spy mode is shown as active in the title bar.

## Pairing with the testing and captures guides

If you've already completed T1--T3 from the [testing guide](README.md) (read a param, change a param, save a preset), your device and server are confirmed working. The C1 capture session is a separate step and does not require the MCP server to be running -- just your device and AxeEdit III. See [C1 in the captures guide](captures-gen3.md#c1----fm9-amp-model-sweep-highest-value-capture) for the full ask description.
