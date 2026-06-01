// DumpAxeEditIIIStorePresetFlow.java — Ghidra GhidraScript
//
// Decode the III's STORE_PRESET workflow. Community RE says it's a
// multi-frame envelope: fn=0x40 BEGIN + fn=0x77/0x78/0x79 PRESET_DUMP
// + optional END.
//
// We've located:
//   FUN_140337060 — fn=0x40 builder (2-byte payload, BEGIN candidate)
//   FUN_14014d2a0 — fn=0x77 PRESET_DUMP HEADER emitter (host-side)
//
// This script:
//   1. Decompiles FUN_140337060 in full + its 1-level callers (the
//      function(s) that wrap the BEGIN emit into a save workflow).
//   2. Decompiles FUN_14014d2a0 (0x77 emitter, save-side) + its callers.
//   3. Looks for any END marker fn-byte the save flow emits.
//   4. Dumps the descriptor table 0x1407ab2f0 (fn=0x40 wire shape).
//   5. Also decompiles FUN_14033f2d0 (the SET_PARAMETER tail writer)
//      since we have it in the pipeline anyway.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt
//
// @category AxeFxIII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class DumpAxeEditIIIStorePresetFlow extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-store-preset.txt";

    // STORE_PRESET BEGIN candidate
    private static final long FUN_FN_40 = 0x140337060L;
    // PRESET_DUMP HEADER emitter (host-side save)
    private static final long FUN_FN_77_EMITTER = 0x14014d2a0L;
    // SET_PARAMETER tail-array writer
    private static final long FUN_FN01_TAIL_WRITER = 0x14033f2d0L;
    // fn=0x12 FS_PASSTHRU candidates
    private static final long FUN_FN_12_A = 0x1401e3fb0L;
    private static final long FUN_FN_12_B = 0x140253360L;

    private static final long[] ROOTS = {
        FUN_FN_40,
        FUN_FN_77_EMITTER,
        FUN_FN01_TAIL_WRITER,
        FUN_FN_12_A,
        FUN_FN_12_B,
    };

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private ReferenceManager refMgr;
    private final Set<Address> seen = new HashSet<>();

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        refMgr = program.getReferenceManager();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("DumpAxeEditIIIStorePresetFlow.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── For each root: decompile it + dump up to 5 of its callers ─
        for (long fa : ROOTS) {
            decompWithCallers(addrOf(fa));
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private void decompWithCallers(Address fa) throws Exception {
        Function f = funcMgr.getFunctionAt(fa);
        if (f == null) { w("(no function at " + fa + ")"); return; }

        w("################################################################################");
        w("## ROOT " + f.getName() + " @ " + fa);
        w("##   signature: " + f.getSignature());
        w("################################################################################");
        decompOne(f);
        w("");

        // Find 1-level callers (functions that CALL this one)
        Set<Function> callers = new LinkedHashSet<>();
        for (Reference ref : refMgr.getReferencesTo(fa)) {
            if (!ref.getReferenceType().isCall()) continue;
            Function pf = funcMgr.getFunctionContaining(ref.getFromAddress());
            if (pf != null) callers.add(pf);
            if (callers.size() >= 5) break;
        }

        if (callers.isEmpty()) {
            w("  (no callers found in binary)");
            w("");
            return;
        }

        w("  --- " + callers.size() + " callers ---");
        w("");
        for (Function pf : callers) {
            if (!seen.add(pf.getEntryPoint())) continue;
            w("--- CALLER OF " + f.getName() + ": " + pf.getName() + " @ " + pf.getEntryPoint() + " ---");
            w("    signature: " + pf.getSignature());
            decompOne(pf);
            w("");
        }
    }

    private void decompOne(Function f) {
        if (f == null) return;
        DecompileResults r = decomp.decompileFunction(f, 90, monitor);
        if (!r.decompileCompleted()) {
            w("  // decompile failed: " + r.getErrorMessage());
            return;
        }
        DecompiledFunction dc = r.getDecompiledFunction();
        String body = dc == null ? "// (no body)" : dc.getC();
        for (String l : body.split("\n")) w("  " + l);
    }

    private Address addrOf(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
