// MapAxeEditIIIHostEmitters.java — Ghidra GhidraScript
//
// For every fn-byte known to the III's workflow catalog (recovered
// from FUN_1401f0f10), find any host-side emitter. Host emit is
// determined by a CALL to either generic SysEx builder with the
// fn-byte as immediate-arg in the 2nd position.
//
// Workflows that have a host emitter = HOST-DRIVEN operation (host
// requests, device confirms).
// Workflows that don't = DEVICE-INITIATED notification (device pushes,
// host subscribes only).
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-host-emitter-map.txt
//
// @category AxeFxIII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
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

public class MapAxeEditIIIHostEmitters extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-host-emitter-map.txt";

    private static final long FUN_BUILDER_A = 0x1403434b0L;
    private static final long FUN_BUILDER_B = 0x1403437d0L;
    private static final long FUN_BUILDER_C = 0x14014d2a0L;  // hardcoded 0x77 emitter

    // Every fn-byte we know about across the workflow catalog +
    // host-emit vocabulary recovered earlier.
    private static final long[] ALL_KNOWN_FN_BYTES = {
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09,
        0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13,
        0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x1F,
        0x20, 0x22, 0x23, 0x24, 0x25, 0x26, 0x28, 0x29,
        0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x32, 0x33,
        0x34, 0x35, 0x36, 0x37, 0x3F, 0x40, 0x46, 0x47,
        0x5A, 0x5B, 0x5C, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
        0x7A, 0x7B, 0x7C,
    };

    // Workflow labels keyed by which fn-byte they subscribe to.
    private static final String[][] WORKFLOW_NAMES = {
        { "0x0A", "Query All Param Definitions (sub)" },
        { "0x0B", "Query Param Definition" },
        { "0x0C", "Refresh Preset Names (sub)" },
        { "0x0D", "Refresh Cabinet Names (sub)" },
        { "0x0E", "Initialization (sub)" },
        { "0x0F", "Initialization (sub)" },
        { "0x10", "Save Preset" },
        { "0x11", "Change Preset" },
        { "0x12", "Revert Preset" },
        { "0x13", "Clear Preset" },
        { "0x14", "Set Preset Name" },
        { "0x15", "Change Scene" },
        { "0x16", "Set Scene Name" },
        { "0x17", "Copy Scene" },
        { "0x18", "Swap Scenes" },
        { "0x19", "File Snapshot / Export / Get Preset Data" },
        { "0x1A", "Export User Cab" },
        { "0x1B", "Import Preset Bundle" },
        { "0x1C", "Export Preset Bundle" },
        { "0x1F", "Paste Preset (sub)" },
        { "0x20", "Import User Cab (sub)" },
        { "0x22", "Paste Preset / Import User Cab (sub)" },
        { "0x23", "Set Tempo" },
        { "0x24", "Block list (Delete/Insert/Move sub)" },
        { "0x25", "Delete Block (sub)" },
        { "0x26", "Delete Block (sub)" },
        { "0x28", "Insert Block (sub)" },
        { "0x29", "Insert Block (sub)" },
        { "0x2A", "Bypass Block" },
        { "0x2B", "Set bypass in all scenes" },
        { "0x2C", "Bypass all blocks in current scene" },
        { "0x2D", "Set Channel" },
        { "0x2E", "Set Channel in all scenes" },
        { "0x2F", "Copy Channel" },
        { "0x30", "Reset Block" },
        { "0x31", "Move Block" },
        { "0x32", "Swap Blocks" },
        { "0x33", "Block Connect" },
        { "0x34", "Library Query" },
        { "0x35", "Block Copy" },
        { "0x36", "Block Paste" },
        { "0x37", "Channel Copy" },
        { "0x46", "Query device version" },
        { "0x47", "Initialization / Param Definitions (sub)" },
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

        Set<Long> builderTargets = new HashSet<>(
            Arrays.asList(FUN_BUILDER_A, FUN_BUILDER_B, FUN_BUILDER_C));

        w("================================================================================");
        w("MapAxeEditIIIHostEmitters.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Map fn_byte → set of host-emitter functions ──────────────
        Map<Long, Set<Address>> fnToEmitters = new TreeMap<>();
        for (long fn : ALL_KNOWN_FN_BYTES) fnToEmitters.put(fn, new LinkedHashSet<>());

        // Sliding window of last 14 instructions to look back for fn-byte
        // immediate before a CALL to a builder.
        ArrayDeque<Instruction> window = new ArrayDeque<>();
        InstructionIterator it = listing.getInstructions(true);
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
                        if (fnToEmitters.containsKey(v)) fnHits.add(v);
                    }
                }
            }
            Function callerFn = funcMgr.getFunctionContaining(ins.getAddress());
            if (callerFn == null) continue;
            for (long fnHit : fnHits) {
                fnToEmitters.get(fnHit).add(callerFn.getEntryPoint());
            }
            // Special case: FUN_14014d2a0 hardcodes 0x77, no immediate
            // needed in caller window. If the target is that builder,
            // attribute to fn=0x77.
            if (target == FUN_BUILDER_C) {
                fnToEmitters.get(0x77L).add(callerFn.getEntryPoint());
            }
        }

        // ── Render the report ────────────────────────────────────────
        Map<String, String> labelByFn = new HashMap<>();
        for (String[] e : WORKFLOW_NAMES) labelByFn.put(e[0], e[1]);

        w("################################################################################");
        w("## HOST-EMITTER MAP — does AxeEdit III EMIT each fn-byte?");
        w("################################################################################");
        w("");
        w("  fn   | # host emitters | workflow name (from inbound dispatcher)");
        w("  -----+-----------------+----------------------------------------");
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

        // ── Per-fn-byte detail ───────────────────────────────────────
        w("################################################################################");
        w("## PER-fn-BYTE EMITTER DETAIL");
        w("################################################################################");
        w("");
        for (var e : fnToEmitters.entrySet()) {
            long fn = e.getKey();
            if (e.getValue().isEmpty()) continue;
            String fnHex = String.format("0x%02X", fn);
            String label = labelByFn.getOrDefault(fnHex, "");
            w(fnHex + " " + label);
            for (Address fa : e.getValue()) {
                Function fn2 = funcMgr.getFunctionAt(fa);
                String fname = fn2 == null ? "?" : fn2.getName();
                w("  " + fname + " @ " + fa);
            }
            w("");
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }
}
