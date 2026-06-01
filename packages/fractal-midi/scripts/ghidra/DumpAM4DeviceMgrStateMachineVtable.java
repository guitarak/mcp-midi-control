// DumpAM4DeviceMgrStateMachineVtable.java - Ghidra GhidraScript
//
// V2 successfully dumped AM4DeviceManager::vftable and
// FasStateMachine::vftable, but missed DeviceMgrStateMachine::vftable
// because the ctor head-scan window was too small. The C++ ctor
// pattern in FUN_14031d230:
//
//   *param_1 = FasStateMachine::vftable;     // BASE ctor sets base vtable
//   ... base field inits ...
//   ... derived field inits ...
//   *param_1 = DeviceMgrStateMachine::vftable; // DERIVED ctor overwrites
//
// Both writes are visible in the decompile (lines 55 and 85 in the
// previous run's output). V3 scans the FULL body of FUN_14031d230
// and emits ALL data refs in the rdata range, then identifies the
// second vtable assignment (excluding the well-known sentinel
// 0x1413f5d38 and FasStateMachine 0x1412b2c48).
//
// Then dumps the derived vtable and the LONGEST decompiled method on
// it — that's the most likely candidate for the per-state dispatch /
// SysEx-receive handler.
//
// Output:
//   %PROJECT_ROOT%\samples\captured\decoded\ghidra-am4-edit-devicemgrstatemachine-vtable.txt
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
import ghidra.program.model.symbol.Reference;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class DumpAM4DeviceMgrStateMachineVtable extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-devicemgrstatemachine-vtable.txt";

    private static final long FUN_WORKFLOW_CTOR = 0x14031d230L;

    // Known vtables from V2 — exclude them when searching for the third.
    private static final long FAS_STATEMACHINE_VTABLE = 0x1412b2c48L;
    private static final long SENTINEL_NULL_DAT = 0x1413f5d38L;
    private static final long SENTINEL_NULL_DAT_28 = 0x1413f5d28L;

    private static final long PE_MIN = 0x140000000L;
    private static final long PE_MAX = 0x150000000L;
    private static final long RDATA_LIKELY_MIN = 0x141000000L;
    private static final long RDATA_LIKELY_MAX = 0x142000000L;

    private static final int MAX_VTABLE_SLOTS = 64;

    private final List<String> lines = new ArrayList<>();
    private Program program;
    private FunctionManager funcMgr;
    private Listing listing;
    private Memory mem;
    private DecompInterface decomp;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        program = currentProgram;
        funcMgr = program.getFunctionManager();
        listing = program.getListing();
        mem = program.getMemory();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("DumpAM4DeviceMgrStateMachineVtable.java");
        w("  Program: " + program.getName());
        w("  Output:  " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Scan FUN_14031d230 full body for unique rdata data refs ──
        w("################################################################################");
        w("## Step 1 - all unique rdata refs from FUN_14031d230 body");
        w("################################################################################");
        w("");

        Function ctor = funcMgr.getFunctionAt(addr(FUN_WORKFLOW_CTOR));
        if (ctor == null) {
            w("FATAL: no function at " + Long.toHexString(FUN_WORKFLOW_CTOR));
            saveAndExit();
            return;
        }

        LinkedHashSet<Long> seen = new LinkedHashSet<>();
        InstructionIterator it = listing.getInstructions(ctor.getBody(), true);
        int insIdx = 0;
        while (it.hasNext()) {
            Instruction ins = it.next();
            insIdx++;
            for (Reference r : ins.getReferencesFrom()) {
                if (r.getReferenceType().isFlow() || r.getReferenceType().isCall()) continue;
                long t = r.getToAddress().getOffset();
                if (t < RDATA_LIKELY_MIN || t >= RDATA_LIKELY_MAX) continue;
                if (seen.add(t)) {
                    w(String.format("  [ins +%-3d] %s @ %s -> 0x%s",
                        insIdx, ins.getMnemonicString(), ins.getAddress(), Long.toHexString(t)));
                }
            }
        }
        w("");

        // ── Identify the DeviceMgrStateMachine vtable ────────────────
        w("################################################################################");
        w("## Step 2 - identify DeviceMgrStateMachine::vftable");
        w("################################################################################");
        w("");

        Long dmsmVtable = null;
        for (Long t : seen) {
            if (t == FAS_STATEMACHINE_VTABLE) continue;
            if (t == SENTINEL_NULL_DAT) continue;
            if (t == SENTINEL_NULL_DAT_28) continue;
            // Heuristic: the first non-sentinel rdata ref AFTER FasStateMachine::vftable
            // (which is encountered first in the iter order) is the
            // DeviceMgrStateMachine vtable.
            //
            // Verify by checking that the address starts a vtable-like
            // sequence (the first ushort at +0 is a code pointer in
            // PE_MIN..PE_MAX range).
            if (looksLikeVtable(t)) {
                dmsmVtable = t;
                w("  identified: DeviceMgrStateMachine::vftable @ 0x" + Long.toHexString(t));
                break;
            } else {
                w("  candidate ruled out (first slot is not a code ptr): 0x" + Long.toHexString(t));
            }
        }
        w("");

        if (dmsmVtable == null) {
            w("  Could not identify DeviceMgrStateMachine vtable from data refs.");
            w("");
            saveAndExit();
            return;
        }

        // ── Dump the vtable + decompile longest methods ──────────────
        w("################################################################################");
        w("## Step 3 - DeviceMgrStateMachine::vftable @ 0x" + Long.toHexString(dmsmVtable));
        w("################################################################################");
        w("");

        List<Function> slotFuncs = new ArrayList<>();
        w("  slot | offset    | func-ptr        | function name");
        w("  -----+-----------+-----------------+---------------------------");
        for (int slot = 0; slot < MAX_VTABLE_SLOTS; slot++) {
            Address slotAddr = addr(dmsmVtable + (long) slot * 8L);
            long ptr;
            try {
                byte[] buf = new byte[8];
                mem.getBytes(slotAddr, buf);
                ptr = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN).getLong();
            } catch (Exception ex) {
                w(String.format("  %3d  | +0x%-7x | (read err)", slot, slot * 8));
                break;
            }
            if (ptr < PE_MIN || ptr >= PE_MAX) {
                w(String.format("  %3d  | +0x%-7x | 0x%-15s | (not code - END)", slot, slot * 8, Long.toHexString(ptr)));
                break;
            }
            Function f = funcMgr.getFunctionAt(addr(ptr));
            String fname = f == null ? "(no func)" : f.getName();
            w(String.format("  %3d  | +0x%-7x | 0x%-15s | %s", slot, slot * 8, Long.toHexString(ptr), fname));
            if (f != null) slotFuncs.add(f);
        }
        w("");

        // ── Decompile each slot, rank by body-line count, surface top ──
        w("################################################################################");
        w("## Step 4 - rank slots by decompile-line count, surface top candidates");
        w("################################################################################");
        w("");

        Map<Function, Integer> bodyLineCount = new HashMap<>();
        Map<Function, String> bodyText = new HashMap<>();
        for (Function f : slotFuncs) {
            DecompileResults r = decomp.decompileFunction(f, 60, monitor);
            if (!r.decompileCompleted()) continue;
            DecompiledFunction dc = r.getDecompiledFunction();
            String body = dc == null ? "" : dc.getC();
            bodyLineCount.put(f, body.split("\n").length);
            bodyText.put(f, body);
        }

        List<Function> ranked = new ArrayList<>(bodyLineCount.keySet());
        ranked.sort((a, b) -> Integer.compare(bodyLineCount.get(b), bodyLineCount.get(a)));

        w("Slots ranked by decompile-line count (largest first):");
        for (int i = 0; i < ranked.size(); i++) {
            Function f = ranked.get(i);
            int sIdx = slotFuncs.indexOf(f);
            w(String.format("  rank %2d  slot %2d  %-12s  lines=%d",
                i + 1, sIdx, f.getName(), bodyLineCount.get(f)));
        }
        w("");

        // ── Decompile the top 6 by line count ────────────────────────
        w("--- Decompiles of top 6 longest vtable methods ---");
        w("");
        for (int i = 0; i < Math.min(6, ranked.size()); i++) {
            Function f = ranked.get(i);
            int sIdx = slotFuncs.indexOf(f);
            w("--- rank " + (i + 1) + " (slot " + sIdx + "): " + f.getName() + " @ " + f.getEntryPoint() + "  lines=" + bodyLineCount.get(f) + " ---");
            int max = 200;
            int idx = 0;
            for (String l : bodyText.get(f).split("\n")) {
                if (idx++ >= max) { w("  ... (truncated at " + max + " lines)"); break; }
                w("  " + l);
            }
            w("");
        }

        saveAndExit();
    }

    private boolean looksLikeVtable(long addr) {
        try {
            byte[] buf = new byte[8];
            mem.getBytes(addr(addr), buf);
            long firstSlot = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN).getLong();
            return firstSlot >= PE_MIN && firstSlot < PE_MAX
                && funcMgr.getFunctionAt(addr(firstSlot)) != null;
        } catch (Exception ex) {
            return false;
        }
    }

    private void saveAndExit() throws Exception {
        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private Address addr(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
