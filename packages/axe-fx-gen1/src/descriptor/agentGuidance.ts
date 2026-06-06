/**
 * Long-form agent guidance for the Axe-Fx Standard/Ultra (gen-1), surfaced via
 * describe_device. Keyed by topic.
 */

export const AXEFXGEN1_AGENT_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  support_tier:
    'gen-1 (Axe-Fx Standard/Ultra) is COMMUNITY-BETA. Its wire is decoded byte-exactly from the ' +
    "published Ultra SysEx doc (and verified against the doc's full 0..255 conversion table), but " +
    'the project owns no gen-1 hardware, so nothing is hardware-confirmed. Tell the user changes are ' +
    'beta and to confirm on the front panel.',
  read_back:
    'gen-1 SUPPORTS parameter read-back (community-beta): function 0x02 with the trailing flag set to ' +
    'query(0) returns a MIDI_PARAM_VALUE response carrying the live value and the device\'s own label ' +
    'string. get_param / get_params are wired and return that label as ground truth. BUT this is decoded ' +
    'from the spec and UNCONFIRMED on hardware (the project owns no gen-1 unit): if a read times out the ' +
    'tool returns no_ack — fall back to the front panel and report the result so we can confirm gen-1 ' +
    'reads. Whole-preset dump (get_preset) is NOT wired yet.',
  capabilities:
    'Supported: set_param / set_params, get_param / get_params (community-beta read-back), and ' +
    'describe_device / list_params / lookup-style introspection. NOT supported (no implemented wire path): ' +
    'get_preset / whole-patch dump, save, preset/scene switching, channels, block placement. Those refuse ' +
    'with capability_not_supported — do not try to work around them.',
  scaling:
    'Most knobs are display-first (0..10, dB, Hz). Some params the doc marks non-linear have no decoded ' +
    'curve and take a raw wire value 0..254 — list_params shows which. Pass the front-panel reading for ' +
    'display-first params; for the raw ones, set and confirm on the panel.',
});
