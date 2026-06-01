// FindAxeEditIIAllocCaller.java — Ghidra GhidraScript
//
// BK-070 Session 116 (cont) — FUN_00595260 was identified as the
// function that walks placed-block NAMES alphabetically and emits
// block-id pairs into an output list. We need to find:
//   (a) Its CALLERS — who builds the placed-blocks input + consumes
//       the id-list output to lay out the binary.
//   (b) The per-block-type allocation SIZES (ushorts per block-type)
//       — if encoded in a table referenced by the caller, that's
//       the key data we need.
//
// Strategy:
//   1. Decompile all callers of FUN_00595260.
//   2. Also decompile FUN_00406350 (the push-id-to-list helper) to
//      confirm it's just an array append.
//   3. Also walk callers of FUN_00595260 and look for nearby per-
//      block size references (immediates 30..400 ushorts).
//
// Output: samples/captured/decoded/ghidra-axe-edit-alloc-caller.txt
//
// @category AxeFxII

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
import ghidra.program.model.symbol.ReferenceManager;
import ghidra.program.model.symbol.ReferenceIterator;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class FindAxeEditIIAllocCaller extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-alloc-caller.txt";

    private static final long ALLOC_FUNC = 0x00595260L;   // alphabetical id-list builder
    private static final long PUSH_FUNC  = 0x00406350L;   // push to id list
    private static final long EMITTED_FN = 0x00406470L;   // grow helper

    private final List<String> lines = new ArrayList<>();
    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        FunctionManager funcMgr = program.getFunctionManager();
        ReferenceManager refMgr = program.getReferenceManager();
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("FindAxeEditIIAllocCaller — callers of FUN_00595260 (alphabetical id-list builder)");
        w("================================================================================");

        for (long target : new long[]{ ALLOC_FUNC, PUSH_FUNC, EMITTED_FN }) {
            Address tAddr = program.getAddressFactory().getDefaultAddressSpace().getAddress(target);
            Function tFunc = funcMgr.getFunctionAt(tAddr);
            String tName = tFunc == null ? "(no func)" : tFunc.getName();
            w("");
            w("################################################################################");
            w("## Callers of " + tName + " @ " + tAddr);
            w("################################################################################");

            Set<Address> callerEntries = new TreeSet<>();
            ReferenceIterator it = refMgr.getReferencesTo(tAddr);
            int xrefCount = 0;
            while (it.hasNext()) {
                Reference r = it.next();
                Address callSite = r.getFromAddress();
                Function caller = funcMgr.getFunctionContaining(callSite);
                if (caller == null) continue;
                callerEntries.add(caller.getEntryPoint());
                xrefCount++;
            }
            w("  Total xrefs: " + xrefCount + "; distinct callers: " + callerEntries.size());
            int i = 0;
            for (Address ce : callerEntries) {
                Function f = funcMgr.getFunctionAt(ce);
                w(String.format("    %2d. %s @ %s", ++i, f.getName(), ce));
            }
            w("");

            // Decompile callers (cap at 10 for ALLOC_FUNC, 4 for the helpers).
            int decompileCap = (target == ALLOC_FUNC) ? 10 : 4;
            int j = 0;
            for (Address ce : callerEntries) {
                if (j++ >= decompileCap) break;
                Function f = funcMgr.getFunctionAt(ce);
                w("--- caller " + j + ": " + f.getName() + " @ " + ce + " ---");
                DecompileResults rr = decomp.decompileFunction(f, 90, monitor);
                if (!rr.decompileCompleted()) {
                    w("  // decompile failed: " + rr.getErrorMessage());
                    continue;
                }
                DecompiledFunction dc = rr.getDecompiledFunction();
                String body = dc == null ? "// (no body)" : dc.getC();
                for (String l : body.split("\n")) w("  " + l);
                w("");
            }
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }
}
