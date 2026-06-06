# Community help wanted

This server controls Fractal Audio gear by conversation. Gen-3 (Axe-Fx III / FM3 / FM9 / VP4) support is included and hardware-unverified: the codec is correct per the published spec and 10+ public captures, but needs device owners to confirm it actually works. Gen-1 (Axe-Fx Standard / Ultra) supports parameter set + read, also decoded from the spec and hardware-unconfirmed.

**Pick your device below.** Each device has a focused testing page (no tools needed) and a captures page (records raw protocol traffic). One-time capture tool setup: [SETUP.md](SETUP.md).

Because these devices share a protocol family, one good capture or test result often helps several at once.

---

## Device status

| Device | Testing | Captures | Notes |
|---|---|---|---|
| Axe-Fx III | [testing-axe-fx-iii.md](testing-axe-fx-iii.md) | [captures-gen3.md](captures-gen3.md) | Read path confirmed via FM9; write path (params + blocks + routing) hardware-unconfirmed |
| FM3 | [testing-fm3.md](testing-fm3.md) | [captures-gen3.md](captures-gen3.md) | Read path confirmed via FM9; **routing formula confirmed via FM3-Edit loopMIDI**; other write path hardware-unconfirmed |
| FM9 | [testing-fm9.md](testing-fm9.md) | [captures-gen3.md](captures-gen3.md) | Reads + preset receive confirmed. **[C1 amp model sweep](captures-gen3.md#c1----fm9-amp-model-sweep-highest-value-capture) is the highest-value open capture** -- unlocks amp selection by name for the full amp model list (roughly 280-320+ depending on firmware) |
| VP4 | [testing-vp4.md](testing-vp4.md) | [captures-vp4.md](captures-vp4.md) | Reads implemented; writes gated -- needs param SET + block placement captures |
| Standard / Ultra | [testing-axe-fx-gen1.md](testing-axe-fx-gen1.md) | [captures-axe-fx-gen1.md](captures-axe-fx-gen1.md) | Parameter set + read wired (both hardware-unconfirmed); port name + write + read confirmation needed; legacy captures welcome (confirm reads + decode the patch-dump body) |

---

## Setup

Both testing and capture contributors need [Claude Desktop](https://claude.ai/download) and the MCP server installed.

### Mac (source install)

1. Install [Claude Desktop](https://claude.ai/download) and create a free account at [claude.ai](https://claude.ai).
2. Install [Node.js v20+](https://nodejs.org).
3. Run `xcode-select --install` once -- required for the native MIDI module; `npm install` will fail without it.
4. In a terminal:
   ```
   git clone https://github.com/TheAndrewStaker/mcp-midi-control
   cd mcp-midi-control
   npm install
   ```
5. Double-click `setup-mac.command` in Finder, or run `npm run setup-mac` in terminal. Registers the server with Claude Desktop -- no manual JSON editing.
6. Fully quit Claude Desktop (Cmd+Q) and relaunch it.

### Windows (ZIP install)

1. Install [Claude Desktop](https://claude.ai/download) and create a free account at [claude.ai](https://claude.ai).
2. Download the release ZIP from the [GitHub releases page](https://github.com/TheAndrewStaker/mcp-midi-control/releases), extract, and run `setup.cmd`.
3. Fully quit Claude Desktop and relaunch it.

---

## Capture tool setup

One-time setup to record raw MIDI or USB traffic: [SETUP.md](SETUP.md).

- Windows: USBPcap + Wireshark -- see [usbpcap-wireshark.md](usbpcap-wireshark.md) for the detailed workflow.
- Mac: MIDI Monitor -- see [midi-monitor-mac.md](midi-monitor-mac.md) for spy-mode setup.

---

## How to submit

[GitHub issue](https://github.com/TheAndrewStaker/mcp-midi-control/issues) (label: `community-beta`) -- paste results or attach `.pcapng` / `.syx` files directly. No GitHub account? Reply to the Reddit thread -- all replies are read.
