// FindAxeEditIIIInboundDispatcher.java — Ghidra GhidraScript
//
// Find the III's inbound SysEx dispatcher — the function that receives
// device-to-host SysEx frames and dispatches by fn byte.
//
// We've already located:
//   FUN_14022ef30 — PATCH_DUMP-only receiver (dispatches on 'w'/'x'/'y')
//
// We need the broader inbound dispatcher that fans out fn-bytes like
// 0x64 (ACK), 0x01 STATE_BROADCAST, 0x12 FS_PASSTHRU, etc.
//
// Strategy:
//   1. Find every function that contains SysEx envelope-validate code:
//      - Reads byte[0] and checks for F0 (-0x10)
//      - Reads bytes[1..4] and checks for Fractal mfr ID
//      - Reads byte[5] (fn byte) and switches on its value
//   2. Rank by # of fn-byte case immediates (functions that handle MANY
//      fn-bytes are the inbound dispatcher).
//   3. Decompile top candidates.
//
// We expect to find functions with many fn-byte immediates 0x64, 0x01,
// 0x12, 0x77, 0x78, 0x79, etc. The receiver dispatcher will have all of
// these plus envelope-validation.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt
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

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class FindAxeEditIIIInboundDispatcher extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-inbound-dispatcher.txt";

    // All known III fn-bytes (subset emitted by AxeEdit III; the device
    // may emit additional fn-bytes we haven't seen).
    private static final long[] FN_BYTES = {
        0x00, 0x01, 0x03, 0x04, 0x08, 0x12, 0x19, 0x1A, 0x1B, 0x1F,
        0x3F, 0x40, 0x46, 0x47, 0x5A, 0x5B, 0x5C,
        0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x7B, 0x7C,
        0x64,  // ACK byte (device-emitted)
    };

    private static final int MAX_DECOMPILE = 10;

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        Listing listing = program.getListing();
        FunctionManager funcMgr = program.getFunctionManager();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("FindAxeEditIIIInboundDispatcher.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        Set<Long> fnSet = new HashSet<>();
        for (long b : FN_BYTES) fnSet.add(b);

        // ── Pass 1: per-function fn-byte hit count ───────────────────
        Map<Address, Set<Long>> hitsPerFunc = new HashMap<>();
        InstructionIterator it = listing.getInstructions(true);
        while (it.hasNext()) {
            Instruction ins = it.next();
            Function f = funcMgr.getFunctionContaining(ins.getAddress());
            if (f == null) continue;
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    if (!(o instanceof Scalar)) continue;
                    long v = ((Scalar) o).getUnsignedValue();
                    if (!fnSet.contains(v)) continue;
                    hitsPerFunc.computeIfAbsent(f.getEntryPoint(),
                        k -> new TreeSet<>()).add(v);
                }
            }
        }

        // ── Rank by # of DISTINCT fn-bytes touched ───────────────────
        List<Map.Entry<Address, Set<Long>>> ranked =
            new ArrayList<>(hitsPerFunc.entrySet());
        ranked.sort((a, b) -> Integer.compare(b.getValue().size(), a.getValue().size()));

        w("################################################################################");
        w("## TOP 40 — functions touching the most distinct fn-bytes (candidate dispatchers)");
        w("################################################################################");
        w("  rank | func @ entry             | distinct fn-bytes | which");
        w("  -----+--------------------------+-------------------+---------------------------");
        for (int i = 0; i < Math.min(40, ranked.size()); i++) {
            var e = ranked.get(i);
            Function f = funcMgr.getFunctionAt(e.getKey());
            String fname = f == null ? "?" : f.getName();
            String bytes = formatHexSet(e.getValue());
            w(String.format("  %4d | %-24s | %-17d | %s",
                i + 1, fname + " @ " + e.getKey(), e.getValue().size(), bytes));
        }
        w("");

        // ── Decompile top N ──────────────────────────────────────────
        w("################################################################################");
        w("## DECOMPILED TOP DISPATCHER CANDIDATES");
        w("################################################################################");
        w("");
        for (int i = 0; i < Math.min(MAX_DECOMPILE, ranked.size()); i++) {
            var e = ranked.get(i);
            Function f = funcMgr.getFunctionAt(e.getKey());
            if (f == null) continue;
            w("--- #" + (i + 1) + ": " + f.getName() + " @ " + e.getKey()
                + " (" + e.getValue().size() + " distinct fn-bytes) ---");
            w("    fn-bytes: " + formatHexSet(e.getValue()));
            DecompileResults r = decomp.decompileFunction(f, 90, monitor);
            if (!r.decompileCompleted()) {
                w("  // decompile failed: " + r.getErrorMessage());
                continue;
            }
            DecompiledFunction dc = r.getDecompiledFunction();
            String body = dc == null ? "// (no body)" : dc.getC();
            for (String l : body.split("\n")) w("  " + l);
            w("");
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private String formatHexSet(Set<Long> s) {
        StringBuilder sb = new StringBuilder();
        boolean first = true;
        for (long v : s) {
            if (!first) sb.append(",");
            sb.append(String.format("0x%02X", v));
            first = false;
        }
        return sb.toString();
    }
}
