// DecodeAxeEditIIIDynamicActionCodes.java — Ghidra GhidraScript
//
// For each of the 15 fn=0x01 callers whose action code couldn't be
// extracted by parse-fn01-action-codes.ts (because the action code
// is computed at runtime from a UI control struct or passed in as
// an argument), walk ONE LEVEL UP to the immediate callers and dump
// each parent's full decompile.
//
// Many of these will reveal the action code as a constant passed in
// from the parent. The rest will be pure UI broadcast loops where
// the action code is genuinely runtime-determined (by which UI
// control fired); document those as a class.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-dynamic-action-codes-decode.txt
//
// @category AxeFxIII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Program;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class DecodeAxeEditIIIDynamicActionCodes extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-dynamic-action-codes-decode.txt";

    // The 15 unresolved callers from fn01-action-codes-decoded.md.
    private static final String[] UNRESOLVED = {
        "1401e3310", "1401e4a90", "1401e4be0", "1401e6bd0",
        "140228410", "1402113c0", "140211de0", "140225630",
        "1402230d0", "14028c210", "1402da380", "1402dc250",
        "14038b530", "140395eb0", "1401f4390",
    };

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private ReferenceManager refMgr;
    private final Set<String> seenParents = new HashSet<>();

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        refMgr = program.getReferenceManager();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("DecodeAxeEditIIIDynamicActionCodes.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("");
        w("  Walks one level up from each of the 15 unresolved fn=0x01 callers");
        w("  whose action code couldn't be extracted at the emit site.");
        w("================================================================================");
        w("");

        for (String emitHex : UNRESOLVED) {
            Address emitAddr = addrOf(parseHex(emitHex));
            Function emitFn = funcMgr.getFunctionAt(emitAddr);

            w("################################################################################");
            w("## EMIT FN: FUN_" + emitHex + (emitFn == null ? " (no function)" : ""));
            w("################################################################################");
            w("");

            if (emitFn == null) {
                w("(no function at address)");
                w("");
                continue;
            }

            // Find direct callers.
            Set<Function> callers = new LinkedHashSet<>();
            for (Reference r : refMgr.getReferencesTo(emitAddr)) {
                if (!r.getReferenceType().isCall()) continue;
                Function cf = funcMgr.getFunctionContaining(r.getFromAddress());
                if (cf != null && cf != emitFn) callers.add(cf);
            }

            w("Caller count: " + callers.size());
            w("");

            if (callers.isEmpty()) {
                w("(no callers — emit fn dispatched indirectly or is itself a leaf)");
                w("");
                continue;
            }

            int idx = 0;
            for (Function caller : callers) {
                idx += 1;
                String key = caller.getEntryPoint().toString();
                w("--- CALLER #" + idx + ": " + caller.getName() + " @ " + caller.getEntryPoint() + " ---");
                w("  signature: " + caller.getSignature());
                if (seenParents.contains(key)) {
                    w("  (decompile body shown earlier in this report)");
                    w("");
                    continue;
                }
                seenParents.add(key);
                String body = decompile(caller);
                for (String l : body.split("\n")) w("  " + l);
                w("");
            }
            w("");
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private String decompile(Function fn) {
        DecompileResults r = decomp.decompileFunction(fn, 120, monitor);
        if (!r.decompileCompleted()) return "// decompile failed: " + r.getErrorMessage();
        DecompiledFunction dc = r.getDecompiledFunction();
        return dc == null ? "// (no body)" : dc.getC();
    }

    private Address addrOf(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }

    private static long parseHex(String s) { return Long.parseLong(s, 16); }
}
