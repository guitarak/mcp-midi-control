// DumpAEImageDepotVtable.java — decompile all methods in AEImageDepot vtable
// at 0x00eacff8. The vtable holds FUN_00595260 (alphabetical block-name id-list
// builder) at slot 1. We're hunting for the ORCHESTRATOR slot that walks
// placed-block descriptors, calls FUN_00595260 to populate per-block id-lists,
// then iterates and emits per-param data into the chunk stream — i.e. the
// function whose code reveals the binary layout SORT algorithm.
//
// Strategy:
//   - Decompile each function pointer in the vtable.
//   - Also decompile the strings/data pointers nearby (might be class name).
//   - Heuristic: orchestrator iterates *(this+0x34) array with count
//     *(this+0x3c), references chunk-write cursors, calls multiple sibling
//     vtable methods, and contains loops over placed blocks.
//
// Output: samples/captured/decoded/ghidra-aeimagedepot-vtable.txt
//
// @category AxeFxII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryAccessException;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class DumpAEImageDepotVtable extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-aeimagedepot-vtable.txt";

    private static final long VTABLE_BASE = 0x00eacff8L;
    private static final int  VTABLE_SLOTS = 16;

    private final List<String> lines = new ArrayList<>();
    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        FunctionManager funcMgr = program.getFunctionManager();
        Memory mem = program.getMemory();
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("DumpAEImageDepotVtable — decompile all methods in vtable at 0x" + Long.toHexString(VTABLE_BASE));
        w("================================================================================");
        w("");

        for (int slot = 0; slot < VTABLE_SLOTS; slot++) {
            long slotAddr = VTABLE_BASE + slot * 4;
            Address slotA = program.getAddressFactory().getDefaultAddressSpace().getAddress(slotAddr);
            int v;
            try { v = mem.getInt(slotA); } catch (MemoryAccessException e) { break; }
            long vv = v & 0xffffffffL;

            // Stop at non-function values (data pointers > 0x00800000 are .rdata).
            if (vv < 0x00400000L || vv >= 0x00800000L) {
                w(String.format("--- slot %2d @ 0x%08x: 0x%08x (not a function — likely data ptr or end of vtable)",
                    slot, slotAddr, vv));
                continue;
            }
            Address funcAddr = program.getAddressFactory().getDefaultAddressSpace().getAddress(vv);
            Function f = funcMgr.getFunctionAt(funcAddr);
            String fname = f == null ? "(no func)" : f.getName();

            w("================================================================================");
            w(String.format("## VTABLE SLOT %d @ 0x%08x: %s @ 0x%08x", slot, slotAddr, fname, vv));
            w("================================================================================");

            if (f == null) {
                w("  (Ghidra has no function at this address — skipping decompile)");
                continue;
            }
            DecompileResults r = decomp.decompileFunction(f, 120, monitor);
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
}
