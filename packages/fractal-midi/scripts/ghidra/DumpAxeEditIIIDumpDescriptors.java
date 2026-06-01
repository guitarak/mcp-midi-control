// DumpAxeEditIIIDumpDescriptors.java — Ghidra GhidraScript
//
// AxeEdit III's 0x74/0x75 EFFECT_DUMP emitters (FUN_140338fb0 and
// FUN_140339c40) read from a stride-3 int descriptor table at
// .rdata 0x1407ab440 (or 0x1407aba40 when the firmware version flag
// DAT_1412633f8 < 0x10). Each descriptor is `{tag, ???, byte_count}`.
//
// This script:
//   1. Dumps both descriptor tables until the -1 sentinel.
//   2. Decompiles each routing/EFFECT_DUMP candidate emitter so we
//      can see the payload-shape contract.
//
// Also decompiles FUN_14014d2a0 (fn 0x77 PRESET_DUMP header emitter)
// and FUN_14033ae30 (fn 0x78 chunk) + FUN_14033ac00 (fn 0x79 footer)
// for the BK-070 cross-reference (per-scene byte offsets inside the
// preset binary).
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-dump-descriptors.txt
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
import ghidra.program.model.mem.Memory;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class DumpAxeEditIIIDumpDescriptors extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-dump-descriptors.txt";

    private static final long[] DESCRIPTOR_TABLES = {
        0x1407ab440L,   // primary EFFECT_DUMP descriptor table
        0x1407aba40L,   // alternate (firmware version < 0x10)
    };

    private static final long[] EMITTER_FUNCS = {
        0x140338fb0L, // fn 0x74 EFFECT_DUMP START
        0x140339c40L, // fn 0x75 EFFECT_DUMP DATA
        0x1401e7a70L, // fn 0x76 EFFECT_DUMP END (one of three)
        0x14021ce90L, // fn 0x76 — second 0x76 caller
        0x14021e300L, // fn 0x76 — third 0x76 caller
        0x14014d2a0L, // fn 0x77 PRESET_DUMP HEADER
        0x14033ae30L, // fn 0x78 PRESET_DUMP CHUNK
        0x14033ac00L, // fn 0x79 PRESET_DUMP FOOTER
        0x14033ba50L, // fn 0x77 — second 0x77 caller (3 total)
        0x1401a1a20L, // fn 0x77 — third 0x77 caller (+ 0x5A/0x7A toggle)
        0x1401d6f10L, // fn 0x77 — fourth caller
    };

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        Memory mem = program.getMemory();
        FunctionManager funcMgr = program.getFunctionManager();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("DumpAxeEditIIIDumpDescriptors.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Dump each descriptor table until -1 sentinel ─────────────
        for (long tableAddr : DESCRIPTOR_TABLES) {
            w("################################################################################");
            w("## Descriptor table @ 0x" + Long.toHexString(tableAddr));
            w("################################################################################");
            try {
                byte[] buf = new byte[12 * 256]; // up to 256 entries
                mem.getBytes(addr(tableAddr), buf, 0, buf.length);
                ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
                int idx = 0;
                w("idx | tag (i32) | mid (i32) | byte_count (i32)");
                w("----+-----------+-----------+----------------");
                while (idx < 256) {
                    int tag = bb.getInt(idx * 12);
                    int mid = bb.getInt(idx * 12 + 4);
                    int len = bb.getInt(idx * 12 + 8);
                    if (tag == -1) {
                        w(String.format(" %2d | %-9d | %-9d | %-9d   <-- SENTINEL", idx, tag, mid, len));
                        break;
                    }
                    w(String.format(" %2d | %-9d | %-9d | %-9d", idx, tag, mid, len));
                    idx++;
                }
            } catch (Exception ex) {
                w("  ERROR reading table: " + ex.getMessage());
            }
            w("");
        }

        // ── Decompile each emitter ───────────────────────────────────
        Set<Long> seen = new HashSet<>();
        for (long fa : EMITTER_FUNCS) {
            if (!seen.add(fa)) continue;
            Function f = funcMgr.getFunctionAt(addr(fa));
            if (f == null) {
                w("# (no function at 0x" + Long.toHexString(fa) + ")");
                continue;
            }
            w("################################################################################");
            w("## EMITTER " + f.getName() + " @ 0x" + Long.toHexString(fa));
            w("##  signature: " + f.getSignature());
            w("################################################################################");
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

    private Address addr(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
