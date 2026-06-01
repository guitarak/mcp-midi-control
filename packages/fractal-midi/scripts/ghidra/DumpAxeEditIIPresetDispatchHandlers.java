// DumpAxeEditIIPresetDispatchHandlers.java — Ghidra GhidraScript
//
// FUN_00512f30 is the AxeEdit II PATCH_DUMP receiver. It dispatches on
// fn byte 'w'/'x'/'y' (0x77/0x78/0x79) and calls:
//   - FUN_0054d3d0 — 0x77 PATCH_START header parser
//   - FUN_0054d0c0 — 0x78 PATCH_DATA chunk parser
//   - FUN_0054d1d0 — 0x79 PATCH_END footer parser
//   - FUN_00620810 — likely the post-assembly preset-binary processor
//     (called after each chunk lands)
//
// This script decompiles each of those functions + their direct
// callees (1 level) so we can read the byte-offset accesses into the
// assembled preset binary. Per-scene channel/bypass offsets should
// appear as explicit `buffer[N]` accesses in FUN_00620810 or in the
// chunk parser.
//
// Output: samples/captured/decoded/ghidra-axe-edit-preset-handlers.txt
//
// @category AxeFxII

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
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.RefType;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class DumpAxeEditIIPresetDispatchHandlers extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-preset-handlers.txt";

    private static final long[] ROOT_FUNCS = {
        0x00512f30L, // PATCH_DUMP receiver/dispatcher
        0x0054d3d0L, // 0x77 header parser
        0x0054d0c0L, // 0x78 chunk parser
        0x0054d1d0L, // 0x79 footer parser
        0x00620810L, // post-receive preset-binary processor
    };

    private static final int MAX_DEPTH = 2;
    private static final int MAX_CALLEES = 8;

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private Listing listing;
    private final Set<Address> seen = new HashSet<>();

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        listing = program.getListing();
        funcMgr = program.getFunctionManager();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("DumpAxeEditIIPresetDispatchHandlers.java");
        w("  Program:    " + program.getName());
        w("  Output:     " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        for (long fa : ROOT_FUNCS) {
            decompTree(addr(fa), 0, "ROOT");
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private void decompTree(Address a, int depth, String tag) throws Exception {
        if (depth > MAX_DEPTH) return;
        if (!seen.add(a)) return;
        Function f = funcMgr.getFunctionAt(a);
        if (f == null) { w("(no function at " + a + ")"); return; }
        w("################################################################################");
        w("## [" + tag + " depth=" + depth + "] " + f.getName() + " @ " + a);
        w("##   signature: " + f.getSignature());
        w("################################################################################");
        DecompileResults r = decomp.decompileFunction(f, 90, monitor);
        if (r.decompileCompleted()) {
            DecompiledFunction dc = r.getDecompiledFunction();
            String body = dc == null ? "// (no body)" : dc.getC();
            for (String l : body.split("\n")) w("  " + l);
        } else {
            w("  // decompile failed: " + r.getErrorMessage());
        }
        w("");

        if (depth >= MAX_DEPTH) return;
        // Walk first-level callees in code-order.
        Set<Address> calleesSeen = new HashSet<>();
        int count = 0;
        InstructionIterator ins = listing.getInstructions(f.getBody(), true);
        while (ins.hasNext()) {
            Instruction i = ins.next();
            if (!i.getFlowType().isCall()) continue;
            for (Reference ref : i.getReferencesFrom()) {
                if (ref.getReferenceType() != RefType.UNCONDITIONAL_CALL
                    && ref.getReferenceType() != RefType.CONDITIONAL_CALL
                    && ref.getReferenceType() != RefType.COMPUTED_CALL) continue;
                Address callee = ref.getToAddress();
                if (!calleesSeen.add(callee)) continue;
                if (count++ >= MAX_CALLEES) break;
                decompTree(callee, depth + 1, "callee-of-" + f.getName());
            }
            if (count >= MAX_CALLEES) break;
        }
    }

    private Address addr(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
