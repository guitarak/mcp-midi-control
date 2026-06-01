// FindAxeEditIIAllocPointer.java — Ghidra GhidraScript
//
// BK-070 Session 116 — FUN_00595260 (alphabetical id-list builder)
// has no direct xrefs. It's probably invoked via a function pointer
// stored in a class vtable or callback table. Find it by:
//
//   1. Scanning every initialized memory region for 4-byte values
//      matching 0x00595260 (the function's entry point address).
//   2. For each hit, report the address it appears at (likely a
//      .rdata vtable slot) AND any xrefs TO that hit address.
//   3. Also scan instruction immediates for 0x00595260 — direct
//      LEA/MOV references that the data-ref analyzer missed.
//   4. For each instruction reference found, dump the containing
//      function's decompile.
//
// Output: samples/captured/decoded/ghidra-axe-edit-alloc-pointer.txt
//
// @category AxeFxII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryAccessException;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;
import ghidra.program.model.symbol.ReferenceIterator;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class FindAxeEditIIAllocPointer extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-alloc-pointer.txt";

    private static final long TARGET = 0x00595260L;

    private final List<String> lines = new ArrayList<>();
    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        Listing listing = program.getListing();
        FunctionManager funcMgr = program.getFunctionManager();
        ReferenceManager refMgr = program.getReferenceManager();
        Memory mem = program.getMemory();
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(program);

        Address target = program.getAddressFactory().getDefaultAddressSpace().getAddress(TARGET);

        w("================================================================================");
        w("FindAxeEditIIAllocPointer — finding indirect-call references to "
            + String.format("0x%08x", TARGET));
        w("================================================================================");
        w("");

        // ── Phase A: scan instruction immediates for the literal address ──
        w("## Phase A: instruction immediates referencing target");
        Map<Address, Address> instrRefs = new TreeMap<>();
        InstructionIterator iit = listing.getInstructions(true);
        int scanned = 0;
        while (iit.hasNext()) {
            Instruction ins = iit.next();
            scanned++;
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    long v = -1;
                    if (o instanceof Scalar) v = ((Scalar) o).getUnsignedValue();
                    else if (o instanceof Address) v = ((Address) o).getOffset();
                    if (v == TARGET) {
                        Function f = funcMgr.getFunctionContaining(ins.getAddress());
                        Address fAddr = f == null ? null : f.getEntryPoint();
                        if (fAddr != null && !instrRefs.containsKey(fAddr)) {
                            instrRefs.put(fAddr, ins.getAddress());
                        }
                    }
                }
            }
        }
        w("  Instructions scanned: " + scanned);
        w("  Distinct functions with immediate ref: " + instrRefs.size());
        w("");
        int k = 0;
        for (var e : instrRefs.entrySet()) {
            Function f = funcMgr.getFunctionAt(e.getKey());
            String fname = f == null ? "(no func)" : f.getName();
            w(String.format("  %2d. %s @ %s  (ref at %s)", ++k, fname, e.getKey(), e.getValue()));
        }
        w("");

        // ── Phase B: data scan for 4-byte LE pointer hits ──
        w("## Phase B: data scan for 4-byte LE pointer to target");
        byte[] pattern = new byte[] {
            (byte) (TARGET & 0xff),
            (byte) ((TARGET >> 8) & 0xff),
            (byte) ((TARGET >> 16) & 0xff),
            (byte) ((TARGET >> 24) & 0xff),
        };
        AddressSetView init = mem.getAllInitializedAddressSet();
        Address cur = init.getMinAddress();
        Address max = init.getMaxAddress();
        List<Address> dataHits = new ArrayList<>();
        while (cur != null && cur.compareTo(max) <= 0 && dataHits.size() < 500) {
            Address hit = mem.findBytes(cur, max, pattern, null, true, monitor);
            if (hit == null) break;
            dataHits.add(hit);
            cur = hit.add(1);
        }
        w("  Pointer hits in data: " + dataHits.size());
        for (Address h : dataHits) {
            // Try to identify what memory block this is in.
            String blockName = "";
            try {
                blockName = mem.getBlock(h).getName();
            } catch (Exception e) {
                blockName = "?";
            }
            // Surrounding 16 bytes for context (32-bit so 4 ptrs).
            StringBuilder ctx = new StringBuilder();
            try {
                for (int i = -8; i < 24; i += 4) {
                    Address a = h.add(i);
                    int v = mem.getInt(a);
                    ctx.append(String.format("%s=0x%08x ",
                        (i == 0 ? "[" : ""),
                        v & 0xffffffffL));
                    if (i == 0) ctx.append("] ");
                }
            } catch (MemoryAccessException e) { }
            w(String.format("  %s  block=%s  ctx=%s", h, blockName, ctx.toString()));

            // Xrefs TO this data location — these are the callers via
            // the function pointer.
            ReferenceIterator ri = refMgr.getReferencesTo(h);
            int xc = 0;
            while (ri.hasNext()) {
                Reference r = ri.next();
                Address from = r.getFromAddress();
                Function caller = funcMgr.getFunctionContaining(from);
                String cname = caller == null ? "(no func)" : caller.getName();
                w(String.format("    xref ← %s  in %s", from, cname));
                xc++;
                if (xc >= 5) { w("    (truncated; more xrefs)"); break; }
            }
        }
        w("");

        // ── Phase C: decompile the top instruction-ref functions ──
        if (!instrRefs.isEmpty()) {
            w("## Phase C: decompiled instruction-ref callers (up to 8)");
            int j = 0;
            for (var e : instrRefs.entrySet()) {
                if (j++ >= 8) break;
                Function f = funcMgr.getFunctionAt(e.getKey());
                if (f == null) continue;
                w("--- caller " + j + ": " + f.getName() + " @ " + e.getKey() + " ---");
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
