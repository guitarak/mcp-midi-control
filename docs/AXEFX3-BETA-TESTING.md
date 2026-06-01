# Axe-Fx III: Community Beta Testing

> **For Axe-Fx III owners.** The III tool surface is fully implemented and
> wire-verified against public captures. What we need is hardware
> confirmation: does our implementation behave correctly against a
> real III? You don't need to capture anything. Install the server,
> run the calls listed below, and paste the JSON responses into a
> GitHub issue.

This is how the III moves from community beta to hardware-verified. The
maintainer does not own a III, so the only path to a hardware-verified
III runs through reports from owners like you. Every confirmed call
flips one row of the support matrix.

---

## Why this matters

The III protocol layer was built from:

- Fractal's published **v1.4 MIDI for Third-Party Devices** PDF (the only
  public spec; covers bypass / channel / scene / preset name / tempo /
  looper / tuner).
- Public wire captures of the III's parameter-write opcode (`fn=0x01`)
  collected from forum posts and FC-12 footswitch traffic. The envelope
  is byte-verified against those captures.
- Mining the AxeEdit III editor's bundled XML (`__block_layout.xml`)
  for per-block parameter names with display labels and control types
  (about 90 percent of the catalog).

What is NOT verified: that all of this runs correctly on real III
firmware. The maintainer doesn't own a III, so every tool response
ships with a beta warning. Your test session (five minutes of clicking
through a handful of tool calls and pasting the JSON) flips the III
from community-beta to hardware-verified.

---

## What you need

- An Axe-Fx III on current firmware, connected by USB.
- The MCP MIDI Control release ZIP installed (see the project README
  for the 5-minute install path).
- Claude Desktop (or another MCP client) connected to the server.

That's it. No capture tools, no driver tricks, no developer setup.

---

## A note on the tools

Every call below uses the **unified tool surface**: one set of
device-agnostic tools where you pass `port: 'axe-fx-iii'` to target the
III. There is no separate `axefx3_*` family of tools; the same
`get_param`, `set_param`, `switch_preset`, and friends serve every
device. If older notes mention `axefx3_get_preset_name` or
`axefx3_status_dump`, ignore them: those names were removed.

---

## The test menu

Pick any of the calls below. The more you run, the more we learn.
Each one is safe; none of them write to a stored preset location.

Open a chat with Claude and ask it to run the call, or run it through
your MCP client of choice. Paste the JSON response into a GitHub
issue titled `axefx3 beta test: <op name>`.

### 1. Identify the device

```
describe_device(port: 'axe-fx-iii')
```

Expected: returns the III's block roster, capabilities, and an
`agent_guidance` blob. This confirms the device is detected and the
server can talk to it. The response also lists which reads the III
supports, so it doubles as a map of what else on this menu is worth
running.

### 2. Read the active preset

```
get_preset(port: 'axe-fx-iii')
```

Expected: returns the active preset's number, name, and block state.
The preset number and name should match what you see on the III's
front panel. If the name does not match, that's the single
highest-value bug report you can file.

### 3. Read a single parameter

Pick any block that's in your active preset (Amp 1, Drive 1, Delay 1,
Reverb 1 are common) and read one knob from it.

```
get_param(port: 'axe-fx-iii', block: 'Amp 1', name: 'drive')
```

Expected: returns the value the front panel shows for that knob, in
display units (the number you read on the panel, not a raw wire value).

### 4. Read bypass and channel state for one block

Bypass and channel are per-block parameters; read them the same way as
any other parameter, through `get_param`.

```
get_param(port: 'axe-fx-iii', block: 'Amp 1', name: 'bypass')
get_param(port: 'axe-fx-iii', block: 'Amp 1', name: 'channel')
```

Expected: returns the bypass state (engaged or bypassed) and the active
channel for that block, matching the front-panel display.

### 5. Whole-preset state

`get_preset` (call 2 above) is the unified way to read the active
preset's block-by-block state in one shot: which blocks are present,
their bypass and channel state. Cross-check the returned block list
against what the front panel shows. There is no separate status-dump
tool on the unified surface; `get_preset` is that read.

### 6. Tempo and active scene

There is no dedicated unified read for the project tempo or for the
active scene index on the III today. `describe_device` reports the
III's read capabilities, so check its response to see what is exposed.
If you want to confirm scene behavior, the write path in call 8 is the
test that exercises it. For tempo, the most useful report right now is
whether the front-panel tempo display agrees with what you set through
a parameter write, if your preset routes tempo to a writable control.

### 7. Parameter write (the big one)

This is the call that ships behind the strongest beta warning because
the parameter-write opcode (`fn=0x01`) is not in the v1.4 spec; it
was decoded from public captures only.

Pick a knob you don't mind changing. Suggestion: load a scratch preset
and bump `Amp 1 Drive` by one or two units.

```
set_param(port: 'axe-fx-iii', block: 'Amp 1', name: 'drive', value: 5.5)
get_param(port: 'axe-fx-iii', block: 'Amp 1', name: 'drive')
```

Expected:
- `set_param` returns a success response with the beta warning banner.
- The III's front panel shows the new drive value.
- `get_param` echoes back the value we just wrote.

If `set_param` succeeds but the front panel doesn't move, that's the
highest-value finding: it means our wire shape lands but binds to the
wrong block or param. Please file an issue with the full JSON response
from both calls.

### 8. (Optional) Scene switch

```
switch_scene(port: 'axe-fx-iii', scene: 2)
```

Expected: front panel shows scene 3 (the API is zero-indexed, so scene
2 in the call is the third scene on the panel).

### 9. (Optional) Preset switch

```
switch_preset(port: 'axe-fx-iii', location: <preset number>)
```

Expected: the III loads the named preset and the front panel updates to
its name. Switching presets is reversible and writes nothing to storage.

---

## How to file the report

GitHub issues, title format `axefx3 beta test: <what you ran>`. In
the body include:

- III firmware version (System -> Firmware on the front panel).
- Server version (it's in the install folder's `package.json`).
- The exact tool calls you ran.
- The JSON responses pasted as a fenced code block.
- What the front panel actually did (matched / did not match).

That's the whole contribution. No captures, no `.pcapng` files, no
Wireshark setup. Five minutes for one test, half an hour for the full
menu.

---

## What happens after your report

For each call you confirm:

- Matches front panel: the maintainer flips the corresponding row in
  the III support matrix from community-beta to hardware-verified.
- Does not match: the maintainer opens a follow-up issue with the exact
  wire bytes the server sent (the server logs them). Usually the fix is
  one constant in the III descriptor, so iteration is fast once the
  symptom is in hand.

---

## Reference

- **Fractal published spec:** ["Axe-Fx III MIDI for Third-Party Devices" v1.4](https://www.fractalaudio.com/downloads/misc/Axe-Fx%20III%20MIDI%20for%203rd%20Party%20Devices.pdf)
- **III protocol decode summary:** [`packages/fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md`](../packages/fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md)
- **Per-call wire shape:** `fractal-midi/src/axe-fx-iii/setParam.ts`
  in the upstream codec package. Every function's evidence chain is in
  the doc comments.
