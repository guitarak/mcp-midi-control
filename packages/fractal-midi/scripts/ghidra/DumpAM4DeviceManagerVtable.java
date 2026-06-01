// DumpAM4DeviceManagerVtable.java - Ghidra GhidraScript
//
// MapAM4EditWorkflowDispatch.java surfaced AM4DeviceManager as the
// parent class that owns all workflows. Its constructor is
// FUN_1402df090 at line 24 of the decompile, where the first
// assignment is:
//
//   *param_1 = AM4DeviceManager::vftable;
//
// The vtable name is preserved in the binary (likely from
// MSVC-generated RTTI). The vtable holds function pointers to all
// virtual methods on AM4DeviceManager including, almost certainly,
// the MIDI input callback (analog of JUCE
// MidiInputCallback::handleIncomingMidiMessage). That callback is
// the entry point for inbound SysEx including the 0x77/0x78/0x79
// preset-dump stream.
//
// Also dump:
//   - FUN_1402da290 - called immediately before the workflow registry
//     in the constructor. Likely sets up the MIDI receive callback /
//     subscription chain.
//   - FUN_14031d230 - the workflow base-class constructor (called 42
//     times in AM4DeviceManager's ctor with stride 0x34 (52) starting
//     at offset 0x1f6). Tells us the workflow object layout: vtable
//     ptr at offset 0, the rest at known field offsets.
//
// Output:
//   %PROJECT_ROOT%\samples\captured\decoded\ghidra-am4-edit-devicemanager-vtable.txt
//
// @category AM4

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
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.symbol.SymbolTable;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class DumpAM4DeviceManagerVtable extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-devicemanager-vtable.txt";

    private static final long FUN_RECEIVE_SETUP_CANDIDATE = 0x1402da290L;
    private static final long FUN_WORKFLOW_BASE_CTOR      = 0x14031d230L;

    // 64-bit image range for pointer plausibility.
    private static final long PE_MIN = 0x140000000L;
    private static final long PE_MAX = 0x150000000L;

    // Walk a vtable until we hit a non-function value (NULL, RTTI data,
    // a string ptr, etc.).
    private static final int MAX_VTABLE_SLOTS = 64;

    private final List<String> lines = new ArrayList<>();
    private Program program;
    private FunctionManager funcMgr;
    private Listing listing;
    private Memory mem;
    private SymbolTable symTbl;
    private DecompInterface decomp;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        program = currentProgram;
        funcMgr = program.getFunctionManager();
        listing = program.getListing();
        mem = program.getMemory();
        symTbl = program.getSymbolTable();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("DumpAM4DeviceManagerVtable.java");
        w("  Program: " + program.getName());
        w("  Output:  " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Find AM4DeviceManager::vftable symbol ────────────────────
        w("################################################################################");
        w("## Step 1 - locate AM4DeviceManager::vftable");
        w("################################################################################");
        w("");

        Address vtableAddr = null;
        SymbolIterator syms = symTbl.getAllSymbols(true);
        while (syms.hasNext()) {
            Symbol s = syms.next();
            String n = s.getName();
            if (n.contains("AM4DeviceManager") && (n.contains("vftable") || n.contains("vtable"))) {
                w("  found symbol: " + s.getName() + " @ " + s.getAddress() + " (parent: " + s.getParentNamespace() + ")");
                vtableAddr = s.getAddress();
            }
        }
        if (vtableAddr == null) {
            // Fallback: scan symbol table for any "vftable" containing AM4 or similar.
            w("  (no direct match; falling back to broader vftable scan)");
            syms = symTbl.getAllSymbols(true);
            int shown = 0;
            while (syms.hasNext() && shown < 40) {
                Symbol s = syms.next();
                String n = s.getName().toLowerCase();
                if (n.contains("vftable") && (n.contains("am4") || n.contains("manager") || n.contains("workflow") || n.contains("preset"))) {
                    w("  candidate: " + s.getName() + " @ " + s.getAddress());
                    shown++;
                }
            }
            w("");
            w("  Cannot proceed without vtable address. Aborting vtable dump.");
            w("");
        } else {
            w("");
            // ── Dump the vtable slots ────────────────────────────────
            w("################################################################################");
            w("## Step 2 - dump AM4DeviceManager::vftable slots");
            w("################################################################################");
            w("");
            dumpVtable(vtableAddr, "AM4DeviceManager");
            w("");
        }

        // ── Decompile FUN_1402da290 (called before workflow registry) ──
        w("################################################################################");
        w("## Step 3 - FUN_1402da290 (called right before workflow registry)");
        w("################################################################################");
        w("");
        decompileFn(FUN_RECEIVE_SETUP_CANDIDATE, "pre-registry setup", 300);

        // ── Decompile FUN_14031d230 (workflow base-class constructor) ──
        w("################################################################################");
        w("## Step 4 - FUN_14031d230 (workflow base-class constructor, called 42x)");
        w("################################################################################");
        w("");
        decompileFn(FUN_WORKFLOW_BASE_CTOR, "workflow base ctor", 200);

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private void dumpVtable(Address vtableStart, String classLabel) throws Exception {
        w("Vtable: " + classLabel + " @ " + vtableStart);
        w("  slot | offset    | func-ptr      | function name + xref count");
        w("  -----+-----------+---------------+-----------------------------");
        for (int slot = 0; slot < MAX_VTABLE_SLOTS; slot++) {
            Address slotAddr = vtableStart.add(slot * 8L);
            long ptr;
            try {
                byte[] buf = new byte[8];
                mem.getBytes(slotAddr, buf);
                ptr = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN).getLong();
            } catch (Exception ex) {
                w(String.format("  %3d  | +0x%-7x | (read error) | %s", slot, slot * 8, ex.getMessage()));
                break;
            }
            if (ptr < PE_MIN || ptr >= PE_MAX) {
                w(String.format("  %3d  | +0x%-7x | 0x%-13s | (not a code ptr — END or RTTI)", slot, slot * 8, Long.toHexString(ptr)));
                break;
            }
            Address fa = addr(ptr);
            Function f = funcMgr.getFunctionAt(fa);
            String fname = f == null ? "(no function defined)" : f.getName();
            w(String.format("  %3d  | +0x%-7x | 0x%-13s | %s", slot, slot * 8, Long.toHexString(ptr), fname));
        }
        w("");

        // Decompile the first ~8 vtable methods to surface the receive callback.
        w("--- Decompiling first 12 vtable methods (looking for MIDI receive) ---");
        w("");
        for (int slot = 0; slot < 12; slot++) {
            Address slotAddr = vtableStart.add(slot * 8L);
            long ptr;
            try {
                byte[] buf = new byte[8];
                mem.getBytes(slotAddr, buf);
                ptr = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN).getLong();
            } catch (Exception ex) {
                break;
            }
            if (ptr < PE_MIN || ptr >= PE_MAX) break;
            Function f = funcMgr.getFunctionAt(addr(ptr));
            if (f == null) continue;
            w("--- vtable slot " + slot + ": " + f.getName() + " @ " + f.getEntryPoint() + " ---");
            DecompileResults r = decomp.decompileFunction(f, 60, monitor);
            if (!r.decompileCompleted()) {
                w("  // decompile failed: " + r.getErrorMessage());
                w("");
                continue;
            }
            DecompiledFunction dc = r.getDecompiledFunction();
            String body = dc == null ? "// (no body)" : dc.getC();
            int max = 120;
            int i = 0;
            for (String l : body.split("\n")) {
                if (i++ >= max) { w("  ... (truncated at " + max + " lines)"); break; }
                w("  " + l);
            }
            w("");
        }
    }

    private void decompileFn(long fa, String label, int maxLines) throws Exception {
        Function f = funcMgr.getFunctionAt(addr(fa));
        if (f == null) {
            w("  (no function at 0x" + Long.toHexString(fa) + ")");
            w("");
            return;
        }
        w("--- " + label + ": " + f.getName() + " @ " + f.getEntryPoint() + " ---");
        DecompileResults r = decomp.decompileFunction(f, 90, monitor);
        if (!r.decompileCompleted()) {
            w("  // decompile failed: " + r.getErrorMessage());
            w("");
            return;
        }
        DecompiledFunction dc = r.getDecompiledFunction();
        String body = dc == null ? "// (no body)" : dc.getC();
        int i = 0;
        for (String l : body.split("\n")) {
            if (i++ >= maxLines) { w("  ... (truncated at " + maxLines + " lines)"); break; }
            w("  " + l);
        }
        w("");
    }

    private Address addr(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
