// DumpAxeEditIIIMiscDescriptors.java — Ghidra GhidraScript
//
// Dump every additional descriptor table we discovered in the III's
// per-fn-byte caller bodies. These are 3-int-stride tables of shape
// `{key, val_b, val_c}` terminated by `key == -1`.
//
// Tables to dump:
//   0x1407abad0  — fn 0x46 (FUN_140333350, DSP_MESSAGE candidate, BK-055)
//   0x1407ab850  — fn 0x1f (FUN_140339ed0)
//   0x1407aaca0  — alt
//   0x1407aaf00  — alt
//   plus any new tables in the 0x1407a0000..0x1407c0000 .rdata range
//   referenced by the III's fn-byte caller functions.
//
// Goal: build a unified table of (fn byte, descriptor table addr,
// header field width, payload width, payload count) so we have a
// machine-readable mapping for every fn-byte's wire envelope shape.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-misc-descriptors.txt
//
// @category AxeFxIII

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
import ghidra.program.model.symbol.RefType;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class DumpAxeEditIIIMiscDescriptors extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-misc-descriptors.txt";

    // Seed tables we know about. Will discover more by scanning the
    // bodies of every fn-byte caller function.
    private static final long[] SEED_TABLES = {
        0x1407abad0L,  // fn 0x46
        0x1407ab850L,  // fn 0x1f (FUN_140339ed0)
        0x1407aaca0L,
        0x1407aaf00L,
        0x1407ab020L,  // (also referenced by fn 0x77 paths)
        0x1407ab440L,  // fn 0x74/0x75 (already known)
        0x1407aba40L,  // fn 0x74/0x75 legacy
    };

    // All fn-byte caller function entries — scan their bodies for new
    // table references in the 0x1407a0000..0x1407c0000 range.
    private static final long[] FN_CALLERS = {
        0x1401a1a20L, 0x14033db70L, 0x1401d6f10L, 0x140328a10L,
        0x140335000L, 0x140335370L, 0x1403359b0L, 0x140336060L,
        0x14033ba50L, 0x140150400L, 0x140150570L, 0x14015d6f0L,
        0x14033ac00L, 0x14033ae30L, 0x140333350L, 0x1401c0690L,
        0x1401c15d0L, 0x1401c12f0L, 0x1401e3fb0L, 0x14033ec70L,
        0x140339ed0L, 0x1401e7a70L, 0x140338fb0L, 0x140339c40L,
        0x14033c6e0L, 0x14033bee0L, 0x14033ce70L, 0x140211fe0L,
        0x14021ce90L, 0x14021e300L, 0x140253360L, 0x140337060L,
        0x140336dd0L, 0x14014d400L,
    };

    private static final long RDATA_LO = 0x1407a0000L;
    private static final long RDATA_HI = 0x1407c0000L;

    private final List<String> lines = new ArrayList<>();
    private Memory mem;
    private Listing listing;
    private FunctionManager funcMgr;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        mem = program.getMemory();
        listing = program.getListing();
        funcMgr = program.getFunctionManager();

        w("================================================================================");
        w("DumpAxeEditIIIMiscDescriptors.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Pass 1: walk every caller for new table refs ─────────────
        TreeSet<Long> tables = new TreeSet<>();
        for (long t : SEED_TABLES) tables.add(t);

        Map<Long, Set<Long>> callerToTables = new TreeMap<>();
        for (long fa : FN_CALLERS) {
            Function f = funcMgr.getFunctionAt(addrOf(fa));
            if (f == null) continue;
            Set<Long> seen = new LinkedHashSet<>();
            InstructionIterator it = listing.getInstructions(f.getBody(), true);
            while (it.hasNext()) {
                Instruction ins = it.next();
                for (int op = 0; op < ins.getNumOperands(); op++) {
                    for (Object o : ins.getOpObjects(op)) {
                        long v = -1;
                        if (o instanceof Scalar) v = ((Scalar) o).getUnsignedValue();
                        else if (o instanceof Address) v = ((Address) o).getOffset();
                        if (v < RDATA_LO || v > RDATA_HI) continue;
                        if ((v & 3) != 0) continue;
                        seen.add(v);
                    }
                }
            }
            callerToTables.put(fa, seen);
            tables.addAll(seen);
        }

        w("################################################################################");
        w("## CALLER → POTENTIAL TABLE REFERENCES");
        w("################################################################################");
        w("");
        for (var e : callerToTables.entrySet()) {
            w(String.format("  0x%x  refs: %s", e.getKey(), hexSet(e.getValue())));
        }
        w("");

        // ── Pass 2: dump each table that decodes to valid descriptor shape ──
        w("################################################################################");
        w("## DESCRIPTOR TABLE DUMPS");
        w("################################################################################");
        w("");
        for (long ptr : tables) {
            byte[] buf = new byte[12 * 64];
            try { mem.getBytes(addrOf(ptr), buf, 0, buf.length); }
            catch (Exception ex) { continue; }
            ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);

            // Quick validity check on first entry.
            int key0 = bb.getInt(0);
            int vb0  = bb.getInt(4);
            int vc0  = bb.getInt(8);
            if (key0 < -1 || key0 > 100 || vb0 < -1 || vb0 > 1000 || vc0 < -1 || vc0 > 100000) {
                continue;  // doesn't look like a descriptor table
            }

            w("Table @ 0x" + Long.toHexString(ptr));
            w("  idx | key (i32) | val_b (i32) | val_c (i32)");
            w("  ----+-----------+-------------+------------");
            int idx = 0;
            while (idx < 64) {
                int key = bb.getInt(idx * 12);
                int vb  = bb.getInt(idx * 12 + 4);
                int vc  = bb.getInt(idx * 12 + 8);
                if (key == -1) {
                    w(String.format("   %2d | %-9d | %-11d | %-9d  <-- SENTINEL", idx, key, vb, vc));
                    break;
                }
                if (key < -1 || key > 1000 || vb < -1 || vb > 1000 || vc < -1 || vc > 100000) {
                    w(String.format("   %2d | %-9d | %-11d | %-9d  // bailing", idx, key, vb, vc));
                    break;
                }
                w(String.format("   %2d | %-9d | %-11d | %-9d", idx, key, vb, vc));
                idx++;
            }
            w("");
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private String hexSet(Set<Long> s) {
        if (s.isEmpty()) return "(none)";
        StringBuilder sb = new StringBuilder();
        sb.append("[");
        boolean first = true;
        for (long v : s) {
            if (!first) sb.append(", ");
            sb.append("0x").append(Long.toHexString(v));
            first = false;
        }
        sb.append("]");
        return sb.toString();
    }

    private Address addrOf(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
