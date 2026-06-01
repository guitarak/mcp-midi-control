// DumpAxeEditIIChunkDescriptorTables.java — Ghidra GhidraScript
//
// FUN_0054d0c0 (0x78 PATCH_DATA chunk parser) and FUN_0054d3d0 (0x77
// PATCH_START header parser) both call descriptor-table lookups:
//
//   FUN_00552c30(table_ptr, key) — returns entry[2] (byte_count?)
//   FUN_00552c60(table_ptr, key) — returns entry[1] (bit_width?)
//
// where the table is an array of 12-byte triplets `{key, val_b, val_c}`
// terminated by `key == -1`.
//
// The decompile output doesn't surface the `table_ptr` argument
// because Ghidra represented the call with default fastcall args. This
// script recovers each table pointer by:
//
//   1. Finding all CALL instructions in FUN_0054d0c0 / FUN_0054d3d0
//      that target FUN_00552c30 (0x00552c30) or FUN_00552c60 (0x00552c60).
//   2. Walking ~12 instructions back from each CALL, collecting any
//      32-bit immediate values that look like .rdata pointers
//      (0x00400000..0x02000000 range).
//   3. For each unique recovered pointer, dumping the 12-byte stride
//      table until the -1 sentinel.
//
// Output: samples/captured/decoded/ghidra-axe-edit-chunk-descriptors.txt
//
// @category AxeFxII

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
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
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class DumpAxeEditIIChunkDescriptorTables extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-chunk-descriptors.txt";

    // Functions whose body we scan for FUN_00552c30 / FUN_00552c60 calls.
    private static final long[] SCAN_FUNCS = {
        0x0054d3d0L,  // 0x77 PATCH_START header parser
        0x0054d0c0L,  // 0x78 PATCH_DATA chunk parser
        0x0054d1d0L,  // 0x79 PATCH_END footer parser
    };

    // Targets for the descriptor-lookup calls.
    private static final long FN_C30 = 0x00552c30L;
    private static final long FN_C60 = 0x00552c60L;

    // Plausible 32-bit PE image range for the II binary.
    private static final long PE_MIN = 0x00400000L;
    private static final long PE_MAX = 0x02000000L;

    // Walk back this many instructions from each CALL to recover args.
    private static final int LOOKBACK = 12;

    // Max entries to dump from a discovered table (safety cap).
    private static final int MAX_ENTRIES = 256;

    private final List<String> lines = new ArrayList<>();
    private FunctionManager funcMgr;
    private Listing listing;
    private Memory mem;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        listing = program.getListing();
        mem = program.getMemory();

        w("================================================================================");
        w("DumpAxeEditIIChunkDescriptorTables.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── For each scan func, find CALLs to c30/c60 and recover ptr args ──
        Map<Long, Set<Long>> tablesByCaller = new LinkedHashMap<>();
        for (long fa : SCAN_FUNCS) {
            Function f = funcMgr.getFunctionAt(addr(fa));
            if (f == null) {
                w("(no function at " + hex(fa) + ")");
                continue;
            }
            w("################################################################################");
            w("## Scanning " + f.getName() + " @ " + hex(fa));
            w("################################################################################");

            Set<Long> tableHits = new LinkedHashSet<>();
            // Walk every instruction in the function body.
            InstructionIterator it = listing.getInstructions(f.getBody(), true);
            List<Instruction> insWindow = new ArrayList<>();
            while (it.hasNext()) {
                Instruction ins = it.next();
                insWindow.add(ins);
                if (insWindow.size() > LOOKBACK) insWindow.remove(0);

                if (!ins.getFlowType().isCall()) continue;
                // Resolve call target.
                long target = -1;
                for (Reference r : ins.getReferencesFrom()) {
                    if (!r.getReferenceType().isCall()) continue;
                    target = r.getToAddress().getOffset();
                    break;
                }
                if (target != FN_C30 && target != FN_C60) continue;

                String which = target == FN_C30 ? "c30" : "c60";
                w("  call " + which + " @ " + ins.getAddress() + ":");

                // Recover any plausible pointer-immediate from the last LOOKBACK instructions.
                Set<Long> candPtrs = new LinkedHashSet<>();
                Set<Long> candKeys = new LinkedHashSet<>();
                for (Instruction prev : insWindow) {
                    for (int op = 0; op < prev.getNumOperands(); op++) {
                        for (Object o : prev.getOpObjects(op)) {
                            if (o instanceof Scalar) {
                                long v = ((Scalar) o).getUnsignedValue();
                                if (v >= PE_MIN && v < PE_MAX) candPtrs.add(v);
                                else if (v >= 0 && v <= 0xFF) candKeys.add(v);
                            }
                            if (o instanceof Address) {
                                long v = ((Address) o).getOffset();
                                if (v >= PE_MIN && v < PE_MAX) candPtrs.add(v);
                            }
                        }
                    }
                }
                w("    candidate ptrs: " + hexSet(candPtrs));
                w("    candidate keys: " + candKeys);
                tableHits.addAll(candPtrs);
            }
            tablesByCaller.put(fa, tableHits);
            w("");
        }

        // ── Dump each unique table ───────────────────────────────────
        Set<Long> allTables = new TreeSet<>();
        for (Set<Long> t : tablesByCaller.values()) allTables.addAll(t);

        w("################################################################################");
        w("## All unique table-pointer candidates: " + allTables.size());
        w("################################################################################");
        w("");

        for (long ptr : allTables) {
            w("--------------------------------------------------------------------------------");
            w("Table @ " + hex(ptr));
            try {
                byte[] buf = new byte[12 * MAX_ENTRIES];
                mem.getBytes(addr(ptr), buf, 0, buf.length);
                ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
                w("  idx | key (i32) | val_b (i32) | val_c (i32)");
                w("  ----+-----------+-------------+------------");
                int idx = 0;
                while (idx < MAX_ENTRIES) {
                    int key = bb.getInt(idx * 12);
                    int vb  = bb.getInt(idx * 12 + 4);
                    int vc  = bb.getInt(idx * 12 + 8);
                    if (key == -1) {
                        w(String.format("   %2d | %-9d | %-11d | %-9d  <-- SENTINEL", idx, key, vb, vc));
                        break;
                    }
                    // Bail out if values look like garbage (heuristic).
                    if (key < -1 || key > 1000 || vb < -1 || vb > 1000 || vc < -1 || vc > 100000) {
                        w(String.format("   %2d | %-9d | %-11d | %-9d  // bailing — looks invalid",
                            idx, key, vb, vc));
                        break;
                    }
                    w(String.format("   %2d | %-9d | %-11d | %-9d", idx, key, vb, vc));
                    idx++;
                }
            } catch (Exception ex) {
                w("  ERROR reading table: " + ex.getMessage());
            }
            w("");
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private Address addr(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }

    private String hex(long v) { return "0x" + Long.toHexString(v); }

    private String hexSet(Set<Long> s) {
        if (s.isEmpty()) return "(none)";
        StringBuilder sb = new StringBuilder();
        sb.append("[");
        boolean first = true;
        for (long v : s) {
            if (!first) sb.append(", ");
            sb.append(hex(v));
            first = false;
        }
        sb.append("]");
        return sb.toString();
    }
}
