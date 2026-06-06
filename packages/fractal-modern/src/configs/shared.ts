/**
 * Shared LLM-facing surface for the modern Fractal family.
 *
 * The agent_guidance and per-block first-page knob summary are anchored
 * on the Axe-Fx III (the byte-verified member) and reused by FM3/FM9 as
 * a beta stopgap, because all three share the III's block catalog today.
 * The grid-shaped example_spec differs per device (FM3 is a 4×12 grid),
 * so example specs live in each device's config; the wide-grid example
 * (III / FM9, 6×14) lives here.
 */
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';

// ── Curated top-N first-page knob list per block ──────────────────
//
// Source: AxeEdit III page-1 controls per block, in the III's canonical
// spelling (`type` not `effect_type`, `master` not `master_volume`,
// `hicut`/`lowcut` one word, `harm1`/`harm2` for pitch voices).
export const MODERN_BLOCK_PARAMS_SUMMARY: Readonly<Record<string, readonly string[]>> = Object.freeze({
  amp: ['type', 'gain', 'bass', 'mid', 'treble', 'master', 'presence', 'level'],
  reverb: ['type', 'mix', 'time', 'predelay', 'size', 'hicut', 'level'],
  delay: ['type', 'time', 'feed', 'mix', 'locut', 'hicut', 'level'],
  chorus: ['type', 'rate', 'depth', 'mix', 'level'],
  flanger: ['type', 'rate', 'depth', 'feedback', 'mix', 'level'],
  phaser: ['type', 'rate', 'depth', 'feedback', 'mix', 'level'],
  wah: ['type', 'fstart', 'fstop', 'q', 'control', 'level'],
  compressor: ['type', 'thresh', 'ratio', 'attack', 'release', 'level', 'mix'],
  pitch: ['type', 'pitchmode', 'harm1', 'harm2', 'key', 'scale', 'mix', 'level'],
  cab: ['level', 'pan'],
  pan_tremolo: ['type', 'rate', 'depth', 'duty', 'mix', 'level'],
  filter: ['type', 'freq', 'q', 'gain', 'level'],
  enhancer: ['type', 'width', 'depth', 'level'],
  gate_expander: ['type', 'thresh', 'attack', 'hold', 'release', 'ratio', 'level'],
  rotary: ['rate', 'lfdepth', 'hfdepth', 'drive', 'mix', 'level'],
  volume_pan: ['gain', 'panl', 'panr', 'level'],
  drive: ['type', 'drive', 'tone', 'level', 'mix'],
  formant: ['mix', 'level'],
  synth: ['mix', 'level'],
  ring_modulator: ['mix', 'level'],
  multitap_delay: ['basetype', 'time1', 'feedback1', 'level1', 'time2', 'feedback2', 'level2'],
});

// ── Agent guidance ─────────────────────────────────────────────────
//
// Anchored on the III; FM3/FM9 reuse it (same catalog, same gen-3 codec,
// same 8-scene / A-D-channel model). Each device adds a `device_note`
// topic naming itself + its grid so the agent knows which unit it's on.

export const MODERN_AGENT_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  diagnostic_isolation: [
    'When the user reports an unwanted artifact in a tone, isolate via',
    'set_bypass: toggle one block at a time and ask the user to play',
    'between toggles, before changing any param values. The human-in-',
    'the-loop is the test signal. Bulk edits during diagnosis hide which',
    'change mattered; isolation surfaces the source one round-trip at a',
    'time. Batching is correct for confident builds; isolation is the',
    'right tool for chasing artifacts.',
  ].join('\n'),

  export_preset: [
    'export_preset supports two modes on gen-3 devices:',
    '  - No location arg: dumps the ACTIVE working-buffer preset (fn=0x43,',
    '    FM9-confirmed). Produces a .syx backup file.',
    '  - location=N (integer): dumps stored preset slot N directly from device',
    '    flash (fn=0x03, FM9 fw 11.00 wire-confirmed, community beta on III/FM3).',
    '    N is the 0-based preset number (e.g. 0 = first preset in the bank).',
    'The resulting .syx file is Fractal-compatible and can be reloaded via',
    'import_preset or the manufacturer\'s editor. Write-back (device restore',
    'from a stored-preset .syx) is NOT yet wire-confirmed; treat as read-only',
    'backup until captured.',
  ].join('\n'),

  beta_status: [
    'COMMUNITY BETA. Drive the tools normally; verification is by the',
    "user's ear and front panel, not by withholding the write.",
    '',
    'The modern Fractal protocol layer is partly community-derived. Some',
    'operations are documented in the Fractal third-party MIDI spec;',
    'others are ported from the Axe-Fx II family with this device\'s model',
    'byte. When an op is rejected, the device returns an error frame',
    'with a named result code; report it verbatim to the user so they',
    'can confirm by ear / by panel.',
    '',
    'Writes the protocol supports attempt a wire send and surface device',
    'rejections inline, so an owner can exercise the surface and report',
    'results. Two cases refuse BEFORE the wire instead: save_preset (the',
    'store envelope is unpublished on III/FM3/FM9), and, on a write-gated',
    'device, every device-state write (see that device\'s device_note).',
    '',
    'When a write is acked, tell the user what you wrote AND ask them',
    'to confirm the audible / visible response on the device. Their',
    'confirmation is the verification path. Example: "I set pitch.harm1',
    'to wire 27. Can you confirm the harmony interval changed on the',
    'front panel?"',
    '',
    'If the device rejects an op, surface the named error code verbatim',
    '(e.g. "message not recognized", "invalid parameter ID", "DSP',
    'overload"). Do not paper over rejections.',
  ].join('\n'),
  channels: [
    'Modern Fractal channel names: A, B, C, D (4 channels per block, same',
    "as AM4, different from Axe-Fx II's X/Y). Per-spec function 0x0B",
    '`id id dd` targets the ACTIVE scene only; there is no per-scene',
    'channel write in the spec.',
  ].join('\n'),
  scenes: [
    'Modern Fractal: 8 scenes per preset. Scenes are 1-indexed in user-',
    'facing tools, 0-indexed on the wire (the descriptor handles conversion).',
  ].join('\n'),
  effect_ids: [
    'Block-level operations (bypass, channel) need an EFFECT ID, which is',
    'an integer 0..16383 from the III v1.4 Appendix 1 (the FM3/FM9 reuse',
    'the III effect-ID enum). Examples:',
    "  - Compressor 1..4    →  46..49",
    "  - Amp 1..4           →  58..61",
    "  - Cab 1..4           →  62..65",
    "  - Reverb 1..4        →  66..69",
    "  - Delay 1..4         →  70..73",
    "  - Chorus 1..4        →  78..81",
    "  - Pitch 1..4         →  110..113",
    "  - Drive (OD/Fuzz) 1..4 →  118..121",
    'Full table: docs/devices/axe-fx-iii/SYSEX-MAP.md.',
    '',
    'Dynamic Distortion, NAM, Global Block, Shunt: effect IDs NOT in v1.4;',
    'bypass/channel control for these will refuse until decoded.',
  ].join('\n'),
  param_addressing: [
    'set_param / get_param address by (block, name) where:',
    '  - block is a single-instance slug (e.g. "reverb", "pitch", "drive")',
    '    that defaults to instance 1. Multi-instance routing is a future',
    '    hook; for now, all writes hit instance 1.',
    '  - name is the lowercase-stripped catalog symbol (REVERB_TYPE → type,',
    '    PITCH_HARM1 → harm1). The original symbol is also accepted as an',
    '    alias (so "reverb_type" works too).',
    '',
    'DISPLAY-FIRST vs RAW WIRE -- check list_params:',
    'Many params ARE display-calibrated and take a DISPLAY value, NOT a raw',
    'wire integer. list_params reports display_min / display_max + unit per',
    'param: when those are present, pass the DISPLAY value (e.g. 5, not 32767).',
    '  - Amp tone stack -- drive, bass, mid, treble, master, presence, depth',
    '    -- is a 0..10 knob: pass 0..10 (5 = middle). amp.level is in dB.',
    '  - reverb.mix is 0..100 percent.',
    '  - Many *.level / *.mix / time knobs across blocks are calibrated too;',
    '    trust list_params over any number you remember.',
    'A param with NO display_min/display_max is uncalibrated: pass the raw',
    '16-bit wire integer 0..65534 (midpoint 32767). list_params marks these.',
    '',
    'AMP MODEL (amp.type) -- NOT settable by name yet. A model name like',
    '"Bogner Shiva" is REJECTED (this device\'s name->id table is not captured),',
    'so the named model is never written and the amp KEEPS whatever model is',
    'already loaded -- it is never silently swapped for a different amp. Only a',
    'numeric ordinal writes it, and that roster is partial/device-specific. Tell',
    'the user you did not set the model; they pick it on the device. Read it back',
    'with get_param. Known FM9 read-leg ordinals: 264=SV Bass 1, 65=SV Bass 2,',
    '179=Texas Star Clean. Other enum *types* DO take ordinals: reverb type',
    '1=Medium Room/16=Medium Spring/45=Music Hall; drive type (eff=118)',
    '15=Blues OD/36=Blackglass 7K.',
    '',
    'When you write, READ BACK with get_param and confirm with the user.',
  ].join('\n'),

  tempo_time_discipline: [
    'TEMPO-FIRST for time-based params. On Fractal hardware, delay and',
    'modulation timing should be SYNCED to the song tempo (musical note',
    'divisions like 1/4, 1/8, dotted) rather than set to raw ms/Hz, that is',
    'the professional default for rhythmic music. Reach for tempo sync first',
    'unless the user asks for a specific number, a free-time / slapback feel,',
    'or is playing without a tempo reference.',
    '',
    'CAVEAT: the core tone knobs ARE display-calibrated (see param_addressing),',
    'but the delay / modulation TIME params and the tempo-division enums are NOT',
    'yet display-addressable -- there is no named "1/4" division you can pass.',
    'Do NOT fabricate a division string; the codec cannot resolve it to a wire',
    'value yet. State the tempo-first preference to the user and flag that named-',
    'division writes are pending, rather than guessing a wire index. Pass raw',
    'wire for time params until they are calibrated.',
  ].join('\n'),

  loudness: [
    'LOUDNESS MODEL. The core amp tone knobs ARE display-calibrated: drive,',
    'bass, mid, treble, master, presence, depth take a 0..10 value (5 = middle,',
    '10 = max); amp.level and many *.level params are dB; reverb.mix and other',
    'mix knobs are percent. For these, "make it 50%" is 5 on a 0..10 knob -- NOT',
    '32767. Pass the DISPLAY value; the codec converts it to wire. Check',
    'list_params (display_min/display_max) when unsure which scale a knob uses.',
    '',
    'UNCALIBRATED params (no display_min/display_max in list_params) still take a',
    'raw 16-bit wire integer 0..65534. For THOSE ONLY this approximation applies:',
    '  wire 0 ≈ min/muted, 16384 ≈ 25%, 32767 ≈ midpoint, 49152 ≈ 75%,',
    '  65534 ≈ max. After every write, READ BACK with get_param and confirm.',
    '',
    'CROSS-PARAM INTERACTIONS (audio-engineer rules of thumb, in display units):',
    '  - Raising amp.gain (input drive) lifts perceived loudness as well as',
    '    distortion. For "more crunch, same volume", raise gain ~1.5 (0..10)',
    '    and drop master ~0.5.',
    '  - Engaging a drive block in front of an amp adds 3-6 dB perceived',
    '    loudness even at unity. Drop amp.master / output a touch to keep',
    '    stage level constant.',
    '  - reverb.mix above ~50% masks 1-3 kHz mid-range and can swallow a',
    '    lead. Aim 25-40% for normal rooms / plates.',
    '',
    'SCENE LEVELING. When you build a multi-scene preset, pick ONE scene as the',
    'loud reference (usually the highest-gain rhythm scene) and balance the',
    'others within ~1 dB of it via the Output block or amp.level (NOT amp.master,',
    'which interacts with the amp model and can change tone).',
    '',
    'Community beta. Make the loudness write, then tell the user what you set and',
    'ask them to confirm the audible result. Their confirmation IS our',
    'verification pipeline.',
  ].join('\n'),
});

/**
 * Wide-grid (6×14) example_spec for the III and FM9. FM3 uses a 4×12
 * variant in its own config. Values are DISPLAY units for calibrated knobs
 * (amp tone stack 0..10, mix in percent); `type` is a raw model ordinal.
 * See the param_addressing guidance for display-vs-raw-wire.
 */
export const WIDE_GRID_EXAMPLE_SPEC: PresetSpec = {
  name: 'Demo',
  slots: [
    {
      // The user-facing Drive / OD pedal (ID_FUZZ family): drive/tone/level.
      slot: { row: 2, col: 1 },
      block_type: 'drive',
      params_by_channel: {
        A: { type: 3, drive: 5, tone: 5, level: 5 },
      },
    },
    {
      // The Amp block (ID_DISTORT family) carries the tone stack.
      slot: { row: 2, col: 2 },
      block_type: 'amp',
      params_by_channel: {
        A: { type: 3, bass: 5, mid: 5, treble: 5, master: 5 },
      },
    },
    { slot: { row: 2, col: 3 }, block_type: 'amp', instance: 2 },
    { slot: { row: 2, col: 4 }, block_type: 'cab' },
    {
      slot: { row: 2, col: 5 },
      block_type: 'reverb',
      params_by_channel: {
        A: { type: 3, time: 5, mix: 25 },
      },
    },
  ],
  scenes: [
    { scene: 1, name: 'Clean', channels: { amp: 'A', amp_2: 'A', reverb: 'A' }, bypassed: { drive: true } },
    { scene: 2, name: 'Lead', channels: { amp: 'B', amp_2: 'A', reverb: 'A' }, bypassed: { drive: false } },
  ],
  landingScene: 1,
};
