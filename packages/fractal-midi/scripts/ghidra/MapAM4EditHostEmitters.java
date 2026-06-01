// MapAM4EditHostEmitters.java — Ghidra GhidraScript
//
// AM4 parallel of MapAxeEditIIIHostEmitters.java. Identifies which
// of AM4's 42 workflow fn-bytes are host-driven (AM4-Edit sends the
// request) vs device-initiated (device broadcasts).
//
// Strategy:
//   1. Find every CALL instruction targeting the AM4 generic SysEx
//      builder(s) — TBD by scanning for FUN_*** with many callers
//      that pass small int constants in the fn-byte argument slot.
//   2. For each call, walk back ~14 instructions for an fn-byte
//      immediate in the workflow-catalog vocabulary.
//   3. Tally host emitters per fn-byte.
//
// Differs from the III script in that we don't yet KNOW the AM4
// generic builder addresses — we infer them from the per-fn-byte
// hit pattern. The script reports all candidates.
//
// Output: samples/captured/decoded/ghidra-am4-edit-host-emitter-map.txt
//
// @category AM4Edit

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.RefType;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class MapAM4EditHostEmitters extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-host-emitter-map.txt";

    // AM4 fn-bytes from the workflow catalog at FUN_1402d83d0.
    private static final long[] WORKFLOW_FN_BYTES = {
        0x00, 0x01, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09,
        0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11,
        0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19,
        0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F,
        0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27,
        0x28, 0x29, 0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F,
        0x30, 0x31, 0x32,
    };

    // Workflow labels for the AM4 fn-bytes.
    private static final String[][] WORKFLOW_NAMES = {
        { "0x04", "Query device version (sub)" },
        { "0x05", "Query device version (sub)" },
        { "0x06", "Query device version (sub)" },
        { "0x07", "Query device version (sub)" },
        { "0x08", "Query device name" },
        { "0x09", "Library Load (sub)" },
        { "0x0A", "Query All Param Definitions" },
        { "0x0B", "Query Param Definition" },
        { "0x0C", "Initialization (sub)" },
        { "0x0D", "Initialization (sub)" },
        { "0x0E", "Refresh Cabinet Names (sub)" },
        { "0x0F", "Change Preset" },
        { "0x10", "Revert Preset" },
        { "0x11", "Clear Preset" },
        { "0x12", "Refresh Cabinet Names (sub)" },
        { "0x13", "Set Scene Name" },
        { "0x14", "Copy Scene" },
        { "0x15", "Paste Preset" },
        { "0x16", "Change Scene" },
        { "0x17", "Save Preset / File Snapshot / File Export to Sysex / Get Preset Data" },
        { "0x18", "Listing preset and scene names" },
        { "0x19", "Library Load / Refresh Preset Names" },
        { "0x1A", "Initialization (sub)" },
        { "0x1B", "Import User Cab (sub)" },
        { "0x1C", "Export User Cab" },
        { "0x1D", "Set Channel" },
        { "0x1E", "Set Channel in all scenes" },
        { "0x1F", "Set Channel in all scenes (alt)" },
        { "0x20", "Bypass Block" },
        { "0x21", "Set bypass in all scenes" },
        { "0x22", "Bypass all blocks in current scene" },
        { "0x23", "File Export to Templates (sub)" },
        { "0x24", "Download (sub)" },
        { "0x25", "Download / File Export to Templates / Import User Cab (sub)" },
        { "0x26", "Library Query / Block Move" },
        { "0x27", "Swap Scenes" },
        { "0x28", "Block Copy" },
        { "0x29", "Block Paste" },
        { "0x2A", "Channel Copy" },
        { "0x2B", "Channel Paste" },
        { "0x2C", "Channel Copy to All" },
        { "0x2D", "Copy Channel To Another" },
        { "0x2E", "Swap Channels" },
        { "0x2F", "Listing preset and scene names (alt)" },
        { "0x30", "Batch set a block's parameter" },
        { "0x31", "Query device version (sub)" },
        { "0x32", "Library Load (sub)" },
    };

    private final List<String> lines = new ArrayList<>();
    private FunctionManager funcMgr;
    private Listing listing;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        listing = program.getListing();

        w("================================================================================");
        w("MapAM4EditHostEmitters.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Pass 1: discover candidate generic SysEx builders ────────
        // A generic builder takes (buf, fn_byte, payload, ...). Callers
        // pass fn_byte as immediate. The builder will have a HIGH number
        // of distinct callers and each caller will pass a different
        // immediate. We rank functions by the number of distinct callers
        // that target them.
        Map<Address, Set<Address>> funcCallers = new HashMap<>();
        InstructionIterator it = listing.getInstructions(true);
        while (it.hasNext()) {
            Instruction ins = it.next();
            if (!ins.getFlowType().isCall()) continue;
            for (Reference r : ins.getReferencesFrom()) {
                if (!r.getReferenceType().isCall()) continue;
                Address callee = r.getToAddress();
                Function callerFn = funcMgr.getFunctionContaining(ins.getAddress());
                if (callerFn == null) continue;
                funcCallers.computeIfAbsent(callee, k -> new HashSet<>())
                    .add(callerFn.getEntryPoint());
            }
        }

        // Sort by caller count descending. The top entries with > 20 callers
        // are the most likely generic builders.
        List<Map.Entry<Address, Set<Address>>> ranked =
            new ArrayList<>(funcCallers.entrySet());
        ranked.sort((a, b) -> Integer.compare(b.getValue().size(), a.getValue().size()));

        w("################################################################################");
        w("## TOP 20 — functions with the most distinct callers (builder candidates)");
        w("################################################################################");
        for (int i = 0; i < Math.min(20, ranked.size()); i++) {
            var e = ranked.get(i);
            Function f = funcMgr.getFunctionAt(e.getKey());
            String fname = f == null ? "?" : f.getName();
            w(String.format("  %4d | %-22s | %d callers",
                i + 1, fname + " @ " + e.getKey(), e.getValue().size()));
        }
        w("");

        // AM4 SysEx builders identified by envelope-constant scan
        // (FindAM4SysExBuilder.java). 4 functions write 0x740100F0:
        Set<Long> builderTargets = new HashSet<>(Arrays.asList(
            0x1401df710L,  // generic builder (37 callers)
            0x1401dd0d0L,  // secondary (6 callers)
            0x1401da020L,  // third (4 callers)
            0x1401df430L   // fourth (4 callers)
        ));
        w("AM4 SysEx builders (from envelope-constant scan): " + builderTargets);
        w("");

        // ── Pass 2: map each fn-byte to its host emitters ────────────
        Set<Long> fnSet = new HashSet<>();
        for (long b : WORKFLOW_FN_BYTES) fnSet.add(b);

        Map<Long, Set<Address>> fnToEmitters = new TreeMap<>();
        for (long fn : WORKFLOW_FN_BYTES) fnToEmitters.put(fn, new LinkedHashSet<>());

        ArrayDeque<Instruction> window = new ArrayDeque<>();
        it = listing.getInstructions(true);
        while (it.hasNext()) {
            Instruction ins = it.next();
            window.addLast(ins);
            if (window.size() > 14) window.removeFirst();

            if (!ins.getFlowType().isCall()) continue;
            long target = -1;
            for (Reference r : ins.getReferencesFrom()) {
                if (!r.getReferenceType().isCall()) continue;
                target = r.getToAddress().getOffset();
                break;
            }
            if (!builderTargets.contains(target)) continue;

            // Find fn-byte immediates in the window.
            Set<Long> fnHits = new LinkedHashSet<>();
            for (Instruction prev : window) {
                for (int op = 0; op < prev.getNumOperands(); op++) {
                    for (Object o : prev.getOpObjects(op)) {
                        if (!(o instanceof Scalar)) continue;
                        long v = ((Scalar) o).getUnsignedValue();
                        if (fnSet.contains(v)) fnHits.add(v);
                    }
                }
            }
            Function callerFn = funcMgr.getFunctionContaining(ins.getAddress());
            if (callerFn == null) continue;
            for (long fnHit : fnHits) {
                fnToEmitters.get(fnHit).add(callerFn.getEntryPoint());
            }
        }

        Map<String, String> labelByFn = new HashMap<>();
        for (String[] e : WORKFLOW_NAMES) labelByFn.put(e[0], e[1]);

        w("################################################################################");
        w("## HOST-EMITTER MAP — does AM4-Edit EMIT each fn-byte?");
        w("################################################################################");
        w("");
        w("  fn   | # host emitters | workflow name");
        w("  -----+-----------------+---------------------------------------");
        int hostDriven = 0;
        int deviceOnly = 0;
        for (var e : fnToEmitters.entrySet()) {
            long fn = e.getKey();
            int count = e.getValue().size();
            String fnHex = String.format("0x%02X", fn);
            String label = labelByFn.getOrDefault(fnHex, "(no workflow registered)");
            String direction = count == 0 ? "  device→host only" : "✓ host can emit";
            w(String.format("  %s | %15d | %s  %s", fnHex, count, label, direction));
            if (count > 0) hostDriven++;
            else deviceOnly++;
        }
        w("");
        w("Summary:");
        w("  host-emittable fn-bytes:  " + hostDriven);
        w("  device-only fn-bytes:     " + deviceOnly);
        w("");

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }
}
