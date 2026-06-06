# Install on macOS

A short, one-time setup. It takes ~10–15 minutes, most of it waiting on
downloads. You do **not** need to be a developer, pay any fee, or edit any
files by hand.

## Why this is a "build it on your Mac" install (and why that's good)

The Windows version ships as a ready-made download. On a Mac, a downloaded,
unsigned program gets blocked by Apple's security (Gatekeeper) with an
"unidentified developer" wall, and getting past it is fiddly, especially on
macOS Sequoia. We avoid that entirely: instead of downloading a ready-made
binary, your Mac **builds the MIDI engine itself** during setup. Anything your
own Mac compiles is trusted automatically, so there are **no security prompts
and no Apple Developer fee** involved. The only cost is a one-time free
"Command Line Tools" download from Apple.

## Steps

1. **Install Node.js.** Go to <https://nodejs.org>, download the macOS
   **Installer (.pkg)** for the LTS version, double-click it, and click through.
   (This installer is Apple-approved, so it opens with no warnings.)

2. **Open Terminal.** Press `Cmd+Space`, type `Terminal`, press Return.

3. **Install Apple's free developer tools.** Paste this and press Return:

   ```
   xcode-select --install
   ```

   A window pops up. Click **Install** and wait (~8 minutes). This is free and
   does **not** require any paid Apple account. If it says they're already
   installed, just continue.

4. **Download the software with `git` (not your web browser).** Using `git`
   avoids the macOS security block that a browser download would trigger. Paste:

   ```
   git clone https://github.com/TheAndrewStaker/mcp-midi-control.git ~/mcp-midi-control
   ```

   (If Terminal offers to install developer tools here, click Install, let it
   finish, then run the line again.)

5. **Run setup.** Paste these lines, pressing Return after each:

   ```
   cd ~/mcp-midi-control
   npm run setup-mac
   ```

   `setup-mac` builds the MIDI engine on your Mac and registers the server with
   Claude Desktop for you, so you never touch a config file. (If you prefer, you
   can instead double-click **`setup-mac.command`** in the `~/mcp-midi-control`
   folder in Finder; it does the same thing.)

6. **Restart Claude Desktop.** Fully quit it with `Cmd+Q` (closing the window is
   not enough), then reopen it.

7. **Plug in your gear by USB** and ask Claude to connect. Most modern Fractal
   (Axe-Fx III, FM3, FM9) and ASM units work on macOS with no driver: macOS
   recognizes them automatically.

## Updating later

```
cd ~/mcp-midi-control
git pull
npm run setup-mac
```

Then fully quit and reopen Claude Desktop.

## If something goes wrong

- An error on the `git clone` or `npm` lines that mentions **"permission"** or
  **"unidentified developer"**: don't click through random security prompts.
  Note exactly which line failed and report it.
- **"command not found: node"** after step 1: quit and reopen Terminal so it
  picks up the new Node install, then retry.
- The MIDI tools don't appear in Claude after step 6: make sure you fully quit
  Claude Desktop with `Cmd+Q`, not just closing the window.

## Notes for the maintainer

This Mac path is **source-build by design**: local compilation is the only
fee-free path that's free of Gatekeeper friction at runtime today. A future
double-click `.mcpb` Desktop Extension is the better long-term UX, but it needs
the native dependency swapped from `midi` to `@julusian/midi` (an API-compatible
drop-in that ships N-API prebuilds) first.
