// FindAM4SysExBuilder.java — Ghidra GhidraScript
//
// Find AM4-Edit's generic SysEx builder function. The III had two
// (FUN_1403434b0, FUN_1403437d0). AM4 likely has analogous functions.
//
// Strategy: find every function that writes the envelope constant
// 0x740100F0 (= bytes F0 00 01 74) as a 32-bit immediate to memory.
// On the III these were the SysEx-emitter functions.
//
// Output: samples/captured/decoded/ghidra-am4-edit-sysex-builders.txt
//
// @category AM4Edit

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
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class FindAM4SysExBuilder extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-sysex-builders.txt";

    private static final long ENVELOPE_LE32 = 0x740100F0L;

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        Listing listing = program.getListing();
        FunctionManager funcMgr = program.getFunctionManager();
        ReferenceManager refMgr = program.getReferenceManager();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("FindAM4SysExBuilder.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Pass 1: find every instruction with the envelope constant ──
        Set<Address> emitterFuncs = new LinkedHashSet<>();
        InstructionIterator it = listing.getInstructions(true);
        int hits = 0;
        while (it.hasNext()) {
            Instruction ins = it.next();
            boolean matched = false;
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    if (!(o instanceof Scalar)) continue;
                    long v = ((Scalar) o).getUnsignedValue();
                    if (v == ENVELOPE_LE32) { matched = true; break; }
                }
                if (matched) break;
            }
            if (!matched) continue;
            hits++;
            Function f = funcMgr.getFunctionContaining(ins.getAddress());
            if (f != null) emitterFuncs.add(f.getEntryPoint());
        }
        w("Instructions writing 0x740100F0: " + hits);
        w("Distinct emitter functions: " + emitterFuncs.size());
        w("");

        // ── Pass 2: for each emitter, count callers ─────────────────
        // The GENERIC builder will have many callers (each fn-byte gets
        // its own caller). Per-fn-byte hardcoded emitters have 1 caller
        // each.
        w("################################################################################");
        w("## EMITTERS RANKED BY # OF CALLERS");
        w("################################################################################");
        w("");
        List<long[]> ranked = new ArrayList<>();
        for (Address fa : emitterFuncs) {
            int callerCount = 0;
            Set<Address> callers = new HashSet<>();
            for (Reference r : refMgr.getReferencesTo(fa)) {
                if (!r.getReferenceType().isCall()) continue;
                Function callerFn = funcMgr.getFunctionContaining(r.getFromAddress());
                if (callerFn != null) callers.add(callerFn.getEntryPoint());
            }
            ranked.add(new long[] { fa.getOffset(), callers.size() });
        }
        ranked.sort((a, b) -> Long.compare(b[1], a[1]));
        for (long[] r : ranked) {
            Function f = funcMgr.getFunctionAt(addrOf(r[0]));
            String fname = f == null ? "?" : f.getName();
            w(String.format("  %s @ 0x%08x  callers=%d",
                fname, r[0], r[1]));
        }
        w("");

        // ── Pass 3: decompile top 5 emitters ─────────────────────────
        w("################################################################################");
        w("## DECOMPILED TOP 5 EMITTERS");
        w("################################################################################");
        w("");
        for (int i = 0; i < Math.min(5, ranked.size()); i++) {
            Function f = funcMgr.getFunctionAt(addrOf(ranked.get(i)[0]));
            if (f == null) continue;
            w("--- " + f.getName() + " @ 0x" + Long.toHexString(ranked.get(i)[0])
                + " (" + ranked.get(i)[1] + " callers) ---");
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

    private Address addrOf(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
