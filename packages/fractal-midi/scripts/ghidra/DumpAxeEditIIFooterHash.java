// DumpAxeEditIIFooterHash.java — Ghidra GhidraScript
//
// BK-070 footer-hash decode. The Axe-Edit II preset binary footer
// (fn 0x79) carries a 3-byte (21-bit) content checksum. The check
// happens inside the 0x79 parser FUN_0054d1d0 + dispatcher FUN_00512f30
// which compares against a value returned by FUN_00544cc0().
//
// This script:
//   1. Decompiles FUN_00544cc0 (the hash function) + dumps raw
//      disassembly for the first 300 instructions as a backup view.
//   2. Decompiles FUN_0054d1d0 (the 0x79 footer parser) so we see how
//      the 3-byte footer is unpacked + compared.
//   3. Decompiles FUN_00512f30 (the dispatcher) so we see where the
//      hash compare exits.
//   4. Walks every function CALLED from FUN_00544cc0 and decompiles
//      each one — the inner primitives (CRC round, table lookup, etc.).
//   5. Walks every CALLER of FUN_00544cc0 so we can confirm input
//      contracts (which buffer + length the hash runs over).
//   6. Lists 256-entry int tables in .rdata near FUN_00544cc0's
//      data references — if there's a CRC table, this finds it.
//
// Output: samples/captured/decoded/ghidra-axeedit2-footer-hash.txt
//
// @category AxeFxII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class DumpAxeEditIIFooterHash extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axeedit2-footer-hash.txt";

    // Per docs/devices/axe-fx-ii/preset-binary-encoding.md.
    private static final long FN_HASH       = 0x00544cc0L; // suspected content-hash
    private static final long FN_FOOTER     = 0x0054d1d0L; // 0x79 PATCH_END parser
    private static final long FN_DISPATCH   = 0x00512f30L; // dispatcher — compares hash

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private ReferenceManager refMgr;
    private Listing listing;
    private Memory memory;
    private AddressSpace as;

    private void w(String s) {
        lines.add(s);
        println(s);
    }

    private String decompile(Function f) {
        if (f == null) return "// (no function)";
        DecompileResults r = decomp.decompileFunction(f, 90, monitor);
        if (!r.decompileCompleted()) return "// decompile failed: " + r.getErrorMessage();
        DecompiledFunction dc = r.getDecompiledFunction();
        return dc != null ? dc.getC() : "// (no decompiled function)";
    }

    private void dumpFunc(String label, Function f) {
        w("");
        w("################################################################################");
        w("# " + label);
        if (f != null) {
            w("# " + f.getName() + " @ " + f.getEntryPoint() + "  sig: " + f.getSignature());
            w("# body: " + f.getBody().getMinAddress() + " .. " + f.getBody().getMaxAddress());
        }
        w("################################################################################");
        if (f == null) { w("// FUNCTION NOT FOUND"); return; }
        w(decompile(f));
    }

    private void dumpRawDisasm(String label, Function f, int maxInstr) {
        w("");
        w("    ----- RAW DISASM: " + label + " -----");
        if (f == null) { w("    // no function"); return; }
        InstructionIterator it = listing.getInstructions(f.getBody(), true);
        int n = 0;
        while (it.hasNext() && n < maxInstr) {
            Instruction ins = it.next();
            StringBuilder sb = new StringBuilder();
            sb.append(String.format("    %s  %-30s", ins.getAddress(), ins.toString()));
            // Append the raw bytes
            try {
                byte[] b = ins.getBytes();
                sb.append("  [");
                for (int i = 0; i < b.length; i++) {
                    if (i > 0) sb.append(' ');
                    sb.append(String.format("%02x", b[i] & 0xff));
                }
                sb.append(']');
            } catch (Exception e) { /* swallow */ }
            w(sb.toString());
            n++;
        }
        if (it.hasNext()) w("    // ... (truncated at " + maxInstr + " instructions)");
    }

    private Set<Function> calleesOf(Function f) {
        Set<Function> out = new LinkedHashSet<>();
        if (f == null) return out;
        InstructionIterator it = listing.getInstructions(f.getBody(), true);
        while (it.hasNext()) {
            Instruction ins = it.next();
            String mnem = ins.getMnemonicString();
            if (!mnem.startsWith("CALL") && !mnem.equals("JMP") && !mnem.equals("CALL")) continue;
            for (Reference r : ins.getReferencesFrom()) {
                Address to = r.getToAddress();
                if (to == null) continue;
                Function callee = funcMgr.getFunctionAt(to);
                if (callee != null && !callee.equals(f)) out.add(callee);
            }
        }
        return out;
    }

    private List<Function> callersOf(Function f) {
        if (f == null) return Collections.emptyList();
        Set<Address> seen = new HashSet<>();
        List<Function> out = new ArrayList<>();
        for (Reference r : refMgr.getReferencesTo(f.getEntryPoint())) {
            Address from = r.getFromAddress();
            Function caller = funcMgr.getFunctionContaining(from);
            if (caller == null || caller.equals(f)) continue;
            if (!seen.add(caller.getEntryPoint())) continue;
            out.add(caller);
        }
        return out;
    }

    private void listImmediates(Function f) {
        if (f == null) return;
        w("");
        w("    ----- IMMEDIATE CONSTANTS USED IN " + f.getName() + " -----");
        Map<Long, Integer> counts = new LinkedHashMap<>();
        InstructionIterator it = listing.getInstructions(f.getBody(), true);
        while (it.hasNext()) {
            Instruction ins = it.next();
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    if (o instanceof Scalar) {
                        long v = ((Scalar)o).getUnsignedValue();
                        // skip tiny constants (0..32) — too noisy
                        if (v < 0x40 || v > 0xFFFFFFFFL) continue;
                        counts.merge(v, 1, Integer::sum);
                    }
                }
            }
        }
        List<Map.Entry<Long, Integer>> sorted = new ArrayList<>(counts.entrySet());
        sorted.sort((a, b) -> b.getValue() - a.getValue());
        int shown = 0;
        for (Map.Entry<Long, Integer> e : sorted) {
            if (shown++ >= 30) break;
            w(String.format("      0x%08x  (used %d×)", e.getKey(), e.getValue()));
        }
    }

    private void scanRdataForCrcTables(Function f) {
        if (f == null) return;
        w("");
        w("    ----- 256-ENTRY uint32 TABLES REFERENCED FROM " + f.getName() + " -----");
        // Collect every data reference from inside the function.
        Set<Long> referenced = new LinkedHashSet<>();
        InstructionIterator it = listing.getInstructions(f.getBody(), true);
        while (it.hasNext()) {
            Instruction ins = it.next();
            for (Reference r : ins.getReferencesFrom()) {
                Address to = r.getToAddress();
                if (to == null) continue;
                referenced.add(to.getOffset());
            }
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    if (o instanceof Scalar) {
                        long v = ((Scalar)o).getUnsignedValue();
                        if (v >= 0x00400000L && v <= 0x02000000L) referenced.add(v);
                    }
                }
            }
        }
        for (long addr : referenced) {
            // Try reading 256 consecutive uint32 values from this address.
            try {
                Address a = as.getAddress(addr);
                if (!memory.contains(a)) continue;
                int[] vals = new int[8];
                for (int i = 0; i < 8; i++) {
                    vals[i] = memory.getInt(a.add(i * 4L));
                }
                // CRC table heuristic: first 8 values vary widely, and val[1] != 0.
                int distinct = 0;
                Set<Integer> ds = new HashSet<>();
                for (int v : vals) ds.add(v);
                distinct = ds.size();
                if (distinct < 6) continue; // mostly identical → probably not a CRC table
                w(String.format("      0x%08x  candidate table?  first 8: %s",
                    addr,
                    Arrays.toString(Arrays.stream(vals).mapToObj(v -> String.format("0x%08x", v)).toArray())));
            } catch (Exception e) { /* swallow */ }
        }
    }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        refMgr  = program.getReferenceManager();
        listing = program.getListing();
        memory  = program.getMemory();
        as      = program.getAddressFactory().getDefaultAddressSpace();
        decomp  = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("Axe-Edit II RE — DumpAxeEditIIFooterHash.java");
        w("  BK-070: decode the 3-byte footer hash for atomic preset apply");
        w("================================================================================");

        Function fnHash      = funcMgr.getFunctionAt(as.getAddress(FN_HASH));
        Function fnFooter    = funcMgr.getFunctionAt(as.getAddress(FN_FOOTER));
        Function fnDispatch  = funcMgr.getFunctionAt(as.getAddress(FN_DISPATCH));

        // Section 1: primary target — the hash function.
        w("");
        w("################################################################################");
        w("## SECTION 1 — HASH FUNCTION (PRIMARY TARGET)");
        w("################################################################################");
        dumpFunc("FN_HASH @ " + String.format("0x%08x", FN_HASH), fnHash);
        if (fnHash != null) {
            listImmediates(fnHash);
            scanRdataForCrcTables(fnHash);
            dumpRawDisasm("FN_HASH disasm", fnHash, 400);
        }

        // Section 2: footer parser — the caller path that uses the hash.
        w("");
        w("################################################################################");
        w("## SECTION 2 — FOOTER PARSER (fn 0x79 PATCH_END)");
        w("################################################################################");
        dumpFunc("FN_FOOTER @ " + String.format("0x%08x", FN_FOOTER), fnFooter);

        // Section 3: dispatcher path that hits FN_HASH's return value.
        w("");
        w("################################################################################");
        w("## SECTION 3 — DISPATCHER (fn 0x77/0x78/0x79 router)");
        w("################################################################################");
        dumpFunc("FN_DISPATCH @ " + String.format("0x%08x", FN_DISPATCH), fnDispatch);

        // Section 4: callees of the hash function.
        w("");
        w("################################################################################");
        w("## SECTION 4 — INNER PRIMITIVES (functions CALLED from FN_HASH)");
        w("################################################################################");
        Set<Function> callees = calleesOf(fnHash);
        w("Found " + callees.size() + " unique callee(s).");
        int idx = 0;
        for (Function callee : callees) {
            if (monitor.isCancelled()) break;
            dumpFunc("callee " + (++idx) + "/" + callees.size(), callee);
        }

        // Section 5: callers of the hash function — confirms input contract.
        w("");
        w("################################################################################");
        w("## SECTION 5 — CALLERS OF FN_HASH (confirms input contract)");
        w("################################################################################");
        List<Function> callers = callersOf(fnHash);
        w("Found " + callers.size() + " unique caller(s).");
        for (int i = 0; i < callers.size(); i++) {
            if (monitor.isCancelled()) break;
            dumpFunc("caller " + (i+1) + "/" + callers.size(), callers.get(i));
        }

        // Write file
        try (PrintWriter out = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) out.println(l);
        }
        w("");
        w("================================================================================");
        w("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
        w("================================================================================");
    }
}
