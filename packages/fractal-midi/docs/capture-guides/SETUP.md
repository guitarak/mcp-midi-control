# Capture setup (one-time)

How to record the USB/MIDI traffic between Fractal's editor and your hardware.
Do this once, then follow your device's capture list:
[Axe-Fx III / FM3 / FM9](captures-gen3.md) or [VP4](captures-vp4.md). The
[guides index](README.md) links every device.

Nothing here changes or risks your presets. You are only *recording* traffic.

> Prefer not to install anything? Two zero-setup options cover most of what we
> need before any capture: the one-command read-only **harvest script** (one
> JSON output file, see [harvest-script.md](harvest-script.md)) and your
> editor's offline **cache file** (see C2 on the gen-3 captures page). Many
> reads are also covered by the per-device **probe** in the "Probe" section of
> your device's page. Captures are only needed for the few wire shapes none of
> those reach.

---

## Windows: Wireshark + USBPcap (recommended)

USBPcap watches the USB cable directly, so it sees both directions even though
the editor holds the MIDI connection.

**Install (once)**
- Download Wireshark from wireshark.org and run the installer.
- On the components page, **check "Install USBPcap"** (off by default, easy to miss).
- Finish, then **reboot**. USBPcap is a driver, so it won't appear until you restart.

**Record**
- Plug the Fractal straight into a **rear USB port** (not a hub). Open the editor app.
- Open Wireshark. On the start screen, hold **Ctrl** and click **every** interface
  named `USBPcap…` so all are selected, then **Start**. (Recording all controllers
  guarantees your device is captured; we sort out the rest.)
- Do the steps from your device's capture list, pausing about 3 seconds between
  each action.
- **Stop**, then **File, then Save As**, and save as a `.pcapng` file.

**Confirm it's working:** click around in the editor. You should see packet bursts
in time with your clicks, and they go quiet when you stop.

*Optional advanced check:* Fractal messages start with `F0 00 01 74`. In recent
Wireshark you can confirm via **Edit, then Find Packet**, set the search type to
**Hex value**, and search `f0 00 01 74` (exact menu wording shifts between versions).
The "bursts in time with clicks" check above is enough on its own.

**If interfaces don't appear or capture fails:** close Wireshark and reopen it with
**Run as administrator**.

---

## macOS: MIDI Monitor

- Install **MIDI Monitor** by Snoize (free, snoize.com) and open it.
- In the **Sources** list, tick your Fractal. That window also has a separate
  **"Spy on output to destinations"** entry; tick your Fractal there too. (Sources
  captures the device's replies; the Spy entry captures what the editor sends. Exact
  wording may differ slightly by MIDI Monitor version.)
- Open the editor and do your device's capture steps.
- **Important check:** you must see messages in **both** directions ("To <device>"
  and "From <device>", starting `F0 00 01 74`). The "From" replies are the valuable
  part. If you only ever see "To", MIDI Monitor cannot see replies on your setup, so
  tell the maintainer and we'll send a USB-level fallback.
- Save the session document (and, for individual messages, "save as received" `.syx`).

---

## What makes a capture easy to read

- **Write down the starting state:** device and firmware, the loaded preset (number
  and name), and the editor version. The bytes only mean something with that context.
- **One action per burst, with pauses.** Idle about 3 seconds, do exactly one thing,
  idle about 3 seconds. Those gaps separate each action cleanly, which is the single
  biggest time-saver for us.
- **Trust the front panel,** not the editor, when noting a before/after value (the
  editor sometimes shows a cached value).
- **Name files after the action** (for example `fm9-receive-preset.pcapng`) and add
  a one-line note per file of what you did.

---

## Where to send

Email is easiest for a binary attachment: send the `.pcapng` (or `.syx`, or the
probe JSON) to the maintainer. The address is the `author` field in the install
folder's `package.json`, or just ask. A **GitHub issue** with the file attached
works too. Larger captures zip up well.
