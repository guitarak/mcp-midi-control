// DumpAxeEditIIIPatchParserDeep.java — Ghidra GhidraScript
//
// Now that we've located the III's PATCH_DUMP receiver (FUN_14022ef30,
// the analog of II's FUN_00512f30), dig deeper into the per-frame
// parsers:
//
//   FUN_14033aa20 — 0x77 header parser (analog of II's FUN_0054d3d0)
//   FUN_14033a780 — 0x78 chunk parser  (analog of II's FUN_0054d0c0)
//   (0x79 footer parsing is inline in FUN_14022ef30)
//
// The III receiver references descriptor table at .rdata 0x1407ab020
// (a 3-int-stride lookup table, analogous to II's 0x718090 / 0x7180c0).
// Dump it plus any other 3-int-stride tables those parsers reference.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-patch-parsers.txt
//
// @category AxeFxIII

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
import ghidra.program.model.mem.Memory;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.RefType;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class DumpAxeEditIIIPatchParserDeep extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-patch-parsers.txt";

    private static final long[] ROOTS = {
        0x14022ef30L,  // PATCH_DUMP receiver dispatcher
        0x14033aa20L,  // 0x77 header parser
        0x14033a780L,  // 0x78 chunk parser
        0x140343370L,  // checksum compute (inline 0x79 verifier callee)
        0x14040de20L,  // post-chunk processor (analog of II FUN_00620810)
        0x14033f2d0L,  // SET_PARAMETER trailing-array writer
    };

    // Known descriptor table from the receiver snippet.
    private static final long[] DESCRIPTOR_TABLES_SEED = {
        0x1407ab020L,
    };

    private static final int MAX_DEPTH = 2;
    private static final int MAX_CALLEES = 6;

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private Listing listing;
    private Memory mem;
    private final Set<Address> seen = new HashSet<>();
    private final Set<Long> tableAddrsToDump = new TreeSet<>();

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        listing = program.getListing();
        funcMgr = program.getFunctionManager();
        mem = program.getMemory();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        for (long t : DESCRIPTOR_TABLES_SEED) tableAddrsToDump.add(t);

        w("================================================================================");
        w("DumpAxeEditIIIPatchParserDeep.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Dump decompile tree for each root ────────────────────────
        for (long fa : ROOTS) {
            decompTree(addr(fa), 0, "ROOT");
        }

        // ── Now dump every descriptor table we collected ─────────────
        w("################################################################################");
        w("## DESCRIPTOR TABLES");
        w("################################################################################");
        w("");
        for (long t : tableAddrsToDump) {
            w("Table @ 0x" + Long.toHexString(t));
            try {
                byte[] buf = new byte[12 * 256];
                mem.getBytes(addr(t), buf, 0, buf.length);
                ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
                w("  idx | key (i32) | val_b (i32) | val_c (i32)");
                w("  ----+-----------+-------------+------------");
                int idx = 0;
                while (idx < 256) {
                    int key = bb.getInt(idx * 12);
                    int vb  = bb.getInt(idx * 12 + 4);
                    int vc  = bb.getInt(idx * 12 + 8);
                    if (key == -1) {
                        w(String.format("   %2d | %-9d | %-11d | %-9d  <-- SENTINEL", idx, key, vb, vc));
                        break;
                    }
                    if (key < -1 || key > 1000 || vb < -1 || vb > 1000 || vc < -1 || vc > 100000) {
                        w(String.format("   %2d | %-9d | %-11d | %-9d  // bailing — looks invalid",
                            idx, key, vb, vc));
                        break;
                    }
                    w(String.format("   %2d | %-9d | %-11d | %-9d", idx, key, vb, vc));
                    idx++;
                }
            } catch (Exception ex) {
                w("  ERROR: " + ex.getMessage());
            }
            w("");
        }

        // ── Look for compression markers in the parser bodies ────────
        // Decompression code typically calls inflate / zlib / Huffman
        // table-build functions. If III actually used compression in
        // its PATCH_DUMP receive path, we'd see calls to functions with
        // these signatures. We already grep'd the decompiles below; this
        // pass is a final summary check.
        w("################################################################################");
        w("## COMPRESSION-PATH AUDIT");
        w("################################################################################");
        w("");
        w("If III's preset-dump uses compression, we'd expect calls in the");
        w("chunk parser FUN_14033a780 to a decompression routine (inflate,");
        w("Huffman build/decode). Above decompile shows the actual call");
        w("graph; absence of such calls = III preset-dump is septet-only");
        w("(same as II, contrary to Forum #159885 community RE).");
        w("");

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private void decompTree(Address a, int depth, String tag) throws Exception {
        if (depth > MAX_DEPTH) return;
        if (!seen.add(a)) return;
        Function f = funcMgr.getFunctionAt(a);
        if (f == null) { w("(no function at " + a + ")"); return; }

        w("################################################################################");
        w("## [" + tag + " depth=" + depth + "] " + f.getName() + " @ " + a);
        w("##   signature: " + f.getSignature());
        w("################################################################################");

        DecompileResults r = decomp.decompileFunction(f, 90, monitor);
        if (r.decompileCompleted()) {
            DecompiledFunction dc = r.getDecompiledFunction();
            String body = dc == null ? "// (no body)" : dc.getC();
            for (String l : body.split("\n")) w("  " + l);

            // Scan body for likely descriptor-table refs (4-byte aligned
            // pointers in .rdata 0x1407aaXXX..0x1407acXXX range).
            // Use instruction walk on the function body since the
            // decompiler often hides these constants.
            InstructionIterator it = listing.getInstructions(f.getBody(), true);
            while (it.hasNext()) {
                Instruction ins = it.next();
                for (int op = 0; op < ins.getNumOperands(); op++) {
                    for (Object o : ins.getOpObjects(op)) {
                        long v = -1;
                        if (o instanceof Scalar) v = ((Scalar) o).getUnsignedValue();
                        else if (o instanceof Address) v = ((Address) o).getOffset();
                        if (v < 0x1407a0000L || v > 0x1407c0000L) continue;
                        if ((v & 3) != 0) continue;
                        tableAddrsToDump.add(v);
                    }
                }
            }
        } else {
            w("  // decompile failed: " + r.getErrorMessage());
        }
        w("");

        if (depth >= MAX_DEPTH) return;
        Set<Address> calleesSeen = new HashSet<>();
        int count = 0;
        InstructionIterator ins = listing.getInstructions(f.getBody(), true);
        while (ins.hasNext()) {
            Instruction i = ins.next();
            if (!i.getFlowType().isCall()) continue;
            for (Reference ref : i.getReferencesFrom()) {
                if (ref.getReferenceType() != RefType.UNCONDITIONAL_CALL
                    && ref.getReferenceType() != RefType.CONDITIONAL_CALL
                    && ref.getReferenceType() != RefType.COMPUTED_CALL) continue;
                Address callee = ref.getToAddress();
                if (!calleesSeen.add(callee)) continue;
                if (count++ >= MAX_CALLEES) break;
                decompTree(callee, depth + 1, "callee-of-" + f.getName());
            }
            if (count >= MAX_CALLEES) break;
        }
    }

    private Address addr(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
