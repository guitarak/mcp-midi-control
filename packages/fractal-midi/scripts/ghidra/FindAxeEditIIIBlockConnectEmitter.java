// FindAxeEditIIIBlockConnectEmitter.java — Ghidra GhidraScript
//
// BK-056 closure step: find the HOST emitter for fn=0x33 (Block
// Connect — the III's grid-routing wire byte, recovered from the
// state-machine initializer FUN_1401f0f10).
//
// Strategy:
//   1. Find every CALL instruction to either generic builder
//      (FUN_1403434b0 or FUN_1403437d0) where the 2nd argument
//      (fn byte) is the immediate 0x33.
//   2. Decompile each caller in full.
//   3. Look for the descriptor table refs in each caller body to
//      determine the wire envelope shape.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-block-connect.txt
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

public class FindAxeEditIIIBlockConnectEmitter extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-block-connect.txt";

    private static final long FUN_BUILDER_A = 0x1403434b0L;
    private static final long FUN_BUILDER_B = 0x1403437d0L;
    private static final long TARGET_FN = 0x33;

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
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
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("FindAxeEditIIIBlockConnectEmitter.java");
        w("  Target fn:  0x" + Long.toHexString(TARGET_FN));
        w("  Output:     " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Walk every instruction, look for CALL with fn=0x33 nearby ─
        // Strategy: any instruction in a basic block that BOTH:
        //   (a) calls one of the two builders
        //   (b) has 0x33 as an immediate in the preceding ~10 instructions
        //       (the fn byte arg setup)

        // Pre-compute the addresses of the two builders.
        Set<Long> builderAddrs = new HashSet<>(Arrays.asList(FUN_BUILDER_A, FUN_BUILDER_B));

        Set<Address> candidateCallers = new LinkedHashSet<>();
        InstructionIterator it = listing.getInstructions(true);
        // Sliding window of last 10 instructions to look back for fn=0x33 immediate.
        ArrayDeque<Instruction> window = new ArrayDeque<>();
        while (it.hasNext()) {
            Instruction ins = it.next();
            window.addLast(ins);
            if (window.size() > 12) window.removeFirst();

            if (!ins.getFlowType().isCall()) continue;
            // Check call target
            long target = -1;
            for (Reference r : ins.getReferencesFrom()) {
                if (!r.getReferenceType().isCall()) continue;
                target = r.getToAddress().getOffset();
                break;
            }
            if (!builderAddrs.contains(target)) continue;

            // Look back in window for 0x33 immediate.
            boolean hasFn33 = false;
            for (Instruction prev : window) {
                for (int op = 0; op < prev.getNumOperands(); op++) {
                    for (Object o : prev.getOpObjects(op)) {
                        if (!(o instanceof Scalar)) continue;
                        long v = ((Scalar) o).getUnsignedValue();
                        if (v == TARGET_FN) {
                            hasFn33 = true;
                            break;
                        }
                    }
                    if (hasFn33) break;
                }
                if (hasFn33) break;
            }
            if (!hasFn33) continue;

            Function f = funcMgr.getFunctionContaining(ins.getAddress());
            if (f != null) candidateCallers.add(f.getEntryPoint());
        }

        w("Candidate emitter functions for fn=0x33: " + candidateCallers.size());
        for (Address fa : candidateCallers) {
            Function f = funcMgr.getFunctionAt(fa);
            if (f == null) continue;
            w("  " + f.getName() + " @ " + fa);
        }
        w("");

        // ── Decompile each candidate + scan for descriptor table refs ─
        for (Address fa : candidateCallers) {
            Function f = funcMgr.getFunctionAt(fa);
            if (f == null) continue;
            w("################################################################################");
            w("## " + f.getName() + " @ " + fa);
            w("##   signature: " + f.getSignature());
            w("################################################################################");

            // Scan body for refs to descriptor tables in .rdata 0x1407a0000..0x1407c0000.
            Set<Long> tableRefs = new TreeSet<>();
            InstructionIterator inner = listing.getInstructions(f.getBody(), true);
            while (inner.hasNext()) {
                Instruction prev = inner.next();
                for (int op = 0; op < prev.getNumOperands(); op++) {
                    for (Object o : prev.getOpObjects(op)) {
                        long v = -1;
                        if (o instanceof Scalar) v = ((Scalar) o).getUnsignedValue();
                        else if (o instanceof Address) v = ((Address) o).getOffset();
                        if (v < 0x1407a0000L || v > 0x1407c0000L) continue;
                        if ((v & 3) != 0) continue;
                        tableRefs.add(v);
                    }
                }
            }
            w("  Descriptor-table refs: " + tableRefs);
            w("");

            DecompileResults r = decomp.decompileFunction(f, 90, monitor);
            if (!r.decompileCompleted()) {
                w("  // decompile failed: " + r.getErrorMessage());
                continue;
            }
            DecompiledFunction dc = r.getDecompiledFunction();
            String body = dc == null ? "// (no body)" : dc.getC();
            for (String l : body.split("\n")) w("  " + l);
            w("");

            // Dump each referenced table.
            for (long t : tableRefs) {
                w("    --- Table @ 0x" + Long.toHexString(t) + " ---");
                try {
                    byte[] buf = new byte[12 * 32];
                    mem.getBytes(addrOf(t), buf, 0, buf.length);
                    ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
                    int idx = 0;
                    while (idx < 32) {
                        int key = bb.getInt(idx * 12);
                        int vb  = bb.getInt(idx * 12 + 4);
                        int vc  = bb.getInt(idx * 12 + 8);
                        if (key == -1) {
                            w(String.format("      idx %2d  SENTINEL", idx));
                            break;
                        }
                        if (key < -1 || key > 1000 || vb < -1 || vb > 1000 || vc < -1 || vc > 100000) {
                            w(String.format("      idx %2d  // bailing — looks invalid", idx));
                            break;
                        }
                        w(String.format("      idx %2d  (key=%d, val_b=%d, val_c=%d)",
                            idx, key, vb, vc));
                        idx++;
                    }
                } catch (Exception ex) {
                    w("      ERROR reading table: " + ex.getMessage());
                }
                w("");
            }
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
