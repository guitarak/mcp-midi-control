// FindAxeEditIIVtableUsers.java — find class users of the vtable at
// 0x00eacff0..0x00ead020 which contains FUN_00595260 (alphabetical
// id-list builder).
//
// Strategy:
//   1. Read 0x00ec63c0 and 0x00ec643c — likely string ptrs in this
//      vtable region; dereference to find class name strings.
//   2. Scan instruction immediates for any address in the vtable
//      range 0x00eacff0..0x00ead020 (the LEA/MOV that loads the
//      vptr). Decompile each containing function — those are
//      constructors / users of this class.
//   3. Also dump bytes at the vtable region (32 4-byte slots, 128
//      bytes total) with attempted resolution per slot.
//
// Output: samples/captured/decoded/ghidra-axe-edit-vtable-users.txt
//
// @category AxeFxII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
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

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class FindAxeEditIIVtableUsers extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-vtable-users.txt";

    private static final long VTABLE_LO = 0x00eacfe0L;
    private static final long VTABLE_HI = 0x00ead040L;

    private final List<String> lines = new ArrayList<>();
    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        Listing listing = program.getListing();
        FunctionManager funcMgr = program.getFunctionManager();
        Memory mem = program.getMemory();
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("FindAxeEditIIVtableUsers — finding class constructors using vtable around 0x00eacffc");
        w("================================================================================");
        w("");

        // ── Dump vtable region ──────────────────────────────────────
        w("## Vtable region dump 0x" + Long.toHexString(VTABLE_LO) + " .. 0x" + Long.toHexString(VTABLE_HI));
        Address loA = program.getAddressFactory().getDefaultAddressSpace().getAddress(VTABLE_LO);
        for (long a = VTABLE_LO; a < VTABLE_HI; a += 4) {
            try {
                Address aa = program.getAddressFactory().getDefaultAddressSpace().getAddress(a);
                int v = mem.getInt(aa);
                long vv = v & 0xffffffffL;
                String tag = "";
                // Heuristic: 0x00400000..0x00800000 = code (function ptr); 0x00e00000..0x01000000 = data (string ptr).
                if (vv >= 0x00400000L && vv < 0x00800000L) {
                    Function f = funcMgr.getFunctionAt(program.getAddressFactory().getDefaultAddressSpace().getAddress(vv));
                    tag = " FUNC " + (f == null ? "(unresolved)" : f.getName());
                } else if (vv >= 0x00800000L && vv < 0x01000000L) {
                    // Try read string
                    try {
                        StringBuilder sb = new StringBuilder();
                        Address sa = program.getAddressFactory().getDefaultAddressSpace().getAddress(vv);
                        for (int i = 0; i < 80; i++) {
                            byte b = mem.getByte(sa.add(i));
                            if (b == 0) break;
                            if (b < 32 || b > 126) { sb = null; break; }
                            sb.append((char) b);
                        }
                        if (sb != null && sb.length() > 0) tag = " STR \"" + sb + "\"";
                        else tag = " DATA";
                    } catch (MemoryAccessException e) { tag = " DATA"; }
                }
                w(String.format("  0x%08x: 0x%08x%s", a, vv, tag));
            } catch (MemoryAccessException e) {
                break;
            }
        }
        w("");

        // ── Scan instruction immediates for any addr in vtable range ──
        w("## Phase B: instructions referencing vtable range");
        Map<Address, Set<Long>> funcRefs = new TreeMap<>();
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
                    if (v >= VTABLE_LO && v < VTABLE_HI) {
                        Function f = funcMgr.getFunctionContaining(ins.getAddress());
                        if (f != null) {
                            funcRefs.computeIfAbsent(f.getEntryPoint(), k -> new TreeSet<>()).add(v);
                        }
                    }
                }
            }
        }
        w("  Instructions scanned: " + scanned);
        w("  Distinct functions referencing vtable region: " + funcRefs.size());
        w("");
        int k = 0;
        for (var e : funcRefs.entrySet()) {
            Function f = funcMgr.getFunctionAt(e.getKey());
            String fname = f == null ? "(no func)" : f.getName();
            w(String.format("  %2d. %s @ %s  refs=%s", ++k, fname, e.getKey(), e.getValue()));
        }
        w("");

        // ── Decompile each (typically constructors / class methods) ──
        w("## Phase C: decompiled vtable-region-ref functions");
        int j = 0;
        for (var e : funcRefs.entrySet()) {
            if (j++ >= 10) break;
            Function f = funcMgr.getFunctionAt(e.getKey());
            if (f == null) continue;
            w("--- caller " + j + ": " + f.getName() + " @ " + e.getKey() + " ---");
            DecompileResults rr = decomp.decompileFunction(f, 120, monitor);
            if (!rr.decompileCompleted()) {
                w("  // decompile failed: " + rr.getErrorMessage());
                continue;
            }
            DecompiledFunction dc = rr.getDecompiledFunction();
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
