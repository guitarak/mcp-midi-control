// DumpAM4DeviceManagerVtableV2.java - Ghidra GhidraScript
//
// V1 (symbol-table lookup) failed because Ghidra's synthesized
// `AM4DeviceManager::vftable` label isn't stored under that exact
// name in the symbol table for headless lookup. V2 extracts the
// vtable address directly from the first MOV/LEA instructions of
// the three known constructors:
//
//   FUN_1402df090 -> AM4DeviceManager::vftable
//   FUN_14031d230 -> FasStateMachine::vftable, DeviceMgrStateMachine::vftable
//
// Pattern: the first action of each C++ constructor is to write the
// vtable pointer into [this+0]. In x64 assembly that's typically:
//
//   LEA  rax, [rip + vtable_disp]
//   MOV  [rcx], rax     ; rcx = this
//
// We walk the first ~12 instructions of each ctor, grab any
// to-data references in the PE image range, treat those as vtable
// candidates, and dump each candidate.
//
// Output:
//   %PROJECT_ROOT%\samples\captured\decoded\ghidra-am4-edit-devicemanager-vtable-v2.txt
//
// @category AM4

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
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class DumpAM4DeviceManagerVtableV2 extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-devicemanager-vtable-v2.txt";

    private static final long FUN_AM4DM_CTOR     = 0x1402df090L;
    private static final long FUN_WORKFLOW_CTOR  = 0x14031d230L;

    private static final long PE_MIN = 0x140000000L;
    private static final long PE_MAX = 0x150000000L;

    // RDATA-typical ranges (where vtables and string literals live).
    // Pulled from observed addresses (string literals ~0x1406a0000,
    // vtables ~0x14127xxxx region in AM4-Edit).
    private static final long RDATA_LIKELY_MIN = 0x141000000L;
    private static final long RDATA_LIKELY_MAX = 0x142000000L;

    private static final int CTOR_HEAD_SCAN = 24;
    private static final int MAX_VTABLE_SLOTS = 64;

    private final List<String> lines = new ArrayList<>();
    private Program program;
    private FunctionManager funcMgr;
    private ReferenceManager refMgr;
    private Listing listing;
    private Memory mem;
    private DecompInterface decomp;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        program = currentProgram;
        funcMgr = program.getFunctionManager();
        refMgr = program.getReferenceManager();
        listing = program.getListing();
        mem = program.getMemory();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("DumpAM4DeviceManagerVtableV2.java");
        w("  Program: " + program.getName());
        w("  Output:  " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        Map<String, Long> vtables = new LinkedHashMap<>();

        // AM4DeviceManager ctor — expect ONE vtable assignment at start.
        List<Long> amdmCands = extractDataRefsFromCtorHead(FUN_AM4DM_CTOR, "FUN_1402df090 (AM4DeviceManager ctor)");
        if (!amdmCands.isEmpty()) {
            vtables.put("AM4DeviceManager", amdmCands.get(0));
        }

        // Workflow base ctor — expect TWO vtable assignments (base then derived).
        List<Long> wfCands = extractDataRefsFromCtorHead(FUN_WORKFLOW_CTOR, "FUN_14031d230 (FasStateMachine/DeviceMgrStateMachine ctor)");
        if (wfCands.size() >= 1) vtables.put("FasStateMachine", wfCands.get(0));
        if (wfCands.size() >= 2) vtables.put("DeviceMgrStateMachine", wfCands.get(1));

        w("");
        w("================================================================================");
        w("## Identified vtables");
        w("================================================================================");
        for (var e : vtables.entrySet()) {
            w("  " + e.getKey() + " -> 0x" + Long.toHexString(e.getValue()));
        }
        w("");

        for (var e : vtables.entrySet()) {
            dumpVtable(e.getKey(), e.getValue());
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    /**
     * Walk the first CTOR_HEAD_SCAN instructions of a constructor and
     * collect any to-data references whose target lies in the rdata-
     * likely range. These are the vtable address candidates, in
     * encounter order. (The constructor writes the base vtable first
     * then overwrites with the derived vtable.)
     */
    private List<Long> extractDataRefsFromCtorHead(long fa, String label) throws Exception {
        w("--- " + label + " head-scan ---");
        List<Long> out = new ArrayList<>();
        Set<Long> seen = new LinkedHashSet<>();
        Function f = funcMgr.getFunctionAt(addr(fa));
        if (f == null) {
            w("  (no function at " + hex(fa) + ")");
            w("");
            return out;
        }
        InstructionIterator it = listing.getInstructions(f.getBody(), true);
        int n = 0;
        while (it.hasNext() && n < CTOR_HEAD_SCAN) {
            Instruction ins = it.next();
            n++;
            for (Reference r : ins.getReferencesFrom()) {
                if (r.getReferenceType().isFlow() || r.getReferenceType().isCall()) continue;
                long t = r.getToAddress().getOffset();
                if (t < RDATA_LIKELY_MIN || t >= RDATA_LIKELY_MAX) continue;
                if (seen.add(t)) {
                    w(String.format("  [+%-2d ins] %s @ %s -> data %s",
                        n, ins.getMnemonicString(), ins.getAddress(), r.getToAddress()));
                    out.add(t);
                }
            }
        }
        w("");
        return out;
    }

    private void dumpVtable(String classLabel, long vtableStart) throws Exception {
        w("################################################################################");
        w("## " + classLabel + "::vftable @ 0x" + Long.toHexString(vtableStart));
        w("################################################################################");
        w("  slot | offset    | func-ptr        | function name");
        w("  -----+-----------+-----------------+------------------------------");
        List<Function> slotFuncs = new ArrayList<>();
        for (int slot = 0; slot < MAX_VTABLE_SLOTS; slot++) {
            Address slotAddr = addr(vtableStart + (long) slot * 8L);
            long ptr;
            try {
                byte[] buf = new byte[8];
                mem.getBytes(slotAddr, buf);
                ptr = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN).getLong();
            } catch (Exception ex) {
                w(String.format("  %3d  | +0x%-7x | (read error)", slot, slot * 8));
                break;
            }
            if (ptr < PE_MIN || ptr >= PE_MAX) {
                w(String.format("  %3d  | +0x%-7x | 0x%-15s | (not a code ptr - END)", slot, slot * 8, Long.toHexString(ptr)));
                break;
            }
            Function f = funcMgr.getFunctionAt(addr(ptr));
            String fname = f == null ? "(no function defined)" : f.getName();
            w(String.format("  %3d  | +0x%-7x | 0x%-15s | %s", slot, slot * 8, Long.toHexString(ptr), fname));
            if (f != null) slotFuncs.add(f);
        }
        w("");

        // Decompile each slot function (modest size cap).
        w("--- Decompiled vtable methods (slot 0..N) ---");
        w("");
        int idx = 0;
        for (Function f : slotFuncs) {
            w("--- " + classLabel + ".slot" + idx + ": " + f.getName() + " @ " + f.getEntryPoint() + " ---");
            DecompileResults r = decomp.decompileFunction(f, 60, monitor);
            if (!r.decompileCompleted()) {
                w("  // decompile failed: " + r.getErrorMessage());
                w("");
                idx++;
                continue;
            }
            DecompiledFunction dc = r.getDecompiledFunction();
            String body = dc == null ? "// (no body)" : dc.getC();
            int maxL = 80;
            int i = 0;
            for (String l : body.split("\n")) {
                if (i++ >= maxL) { w("  ... (truncated at " + maxL + " lines)"); break; }
                w("  " + l);
            }
            w("");
            idx++;
        }
    }

    private Address addr(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }

    private String hex(long v) { return "0x" + Long.toHexString(v); }
}
