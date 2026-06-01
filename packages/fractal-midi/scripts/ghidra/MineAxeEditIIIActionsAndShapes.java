// MineAxeEditIIIActionsAndShapes.java — Ghidra GhidraScript
//
// Two-in-one mining pass to close the remaining structural III gaps:
//
// PART A — fn=0x01 SET_PARAMETER action-code enumeration
//   Find every caller of FUN_14033ec70 (the fn=0x01 wrapper).
//   Each caller initializes a 6-field struct before calling. The
//   FIRST field (param_3[0]) is the action code (Field A in
//   fn01-builder-ghidra.md). Decompile each caller to extract its
//   action code constant.
//
// PART B — Remaining host-emit wire shape decompiles
//   For fn-bytes 0x10 (Save Preset), 0x14 (Set Preset Name),
//   0x15 (Change Scene), 0x19 (File ops), 0x30 (Reset Block),
//   0x31 (Move Block), find every host-side caller (CALLs to
//   FUN_1403434b0 or FUN_1403437d0 with the fn-byte immediate)
//   and decompile.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt
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
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.RefType;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class MineAxeEditIIIActionsAndShapes extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-actions-and-shapes.txt";

    private static final long FUN_BUILDER_A = 0x1403434b0L;
    private static final long FUN_BUILDER_B = 0x1403437d0L;
    private static final long FUN_FN01_WRAPPER = 0x14033ec70L;

    // Host-emit wire shapes to decompile (fn-byte → label).
    private static final long[][] TARGET_FNS = {
        { 0x10, 1 },   // Save Preset
        { 0x14, 2 },   // Set Preset Name
        { 0x15, 3 },   // Change Scene
        { 0x19, 4 },   // File Snapshot / Export / Get Preset Data
        { 0x30, 5 },   // Reset Block
        { 0x31, 6 },   // Move Block
    };
    private static final String[] FN_LABELS = {
        "Save Preset",                                        // 0x10
        "Set Preset Name",                                    // 0x14
        "Change Scene",                                       // 0x15
        "File Snapshot / Export / Get Preset Data",           // 0x19
        "Reset Block",                                        // 0x30
        "Move Block",                                         // 0x31
    };

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private Listing listing;
    private ReferenceManager refMgr;
    private final Set<Address> decompiled = new HashSet<>();

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        listing = program.getListing();
        refMgr = program.getReferenceManager();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("MineAxeEditIIIActionsAndShapes.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ═══════════════════════════════════════════════════════════════════
        // PART A: fn=0x01 action-code enumeration
        // ═══════════════════════════════════════════════════════════════════
        partA_actionCodes();

        // ═══════════════════════════════════════════════════════════════════
        // PART B: host-emit wire shape decompiles
        // ═══════════════════════════════════════════════════════════════════
        partB_hostEmitShapes();

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private void partA_actionCodes() throws Exception {
        w("################################################################################");
        w("## PART A — fn=0x01 SET_PARAMETER action-code enumeration");
        w("################################################################################");
        w("");
        w("FUN_14033ec70 is the fn=0x01 wrapper. param_3[0] is the action code.");
        w("Walk every caller and look for assignments to the first field of the");
        w("struct passed as param_3.");
        w("");

        // Find all callers of FUN_14033ec70.
        Set<Function> callers = new LinkedHashSet<>();
        Address fnAddr = addrOf(FUN_FN01_WRAPPER);
        for (Reference ref : refMgr.getReferencesTo(fnAddr)) {
            if (!ref.getReferenceType().isCall()) continue;
            Function callerFn = funcMgr.getFunctionContaining(ref.getFromAddress());
            if (callerFn != null) callers.add(callerFn);
        }
        w("Callers of FUN_14033ec70 (fn=0x01 wrapper): " + callers.size());
        w("");

        // Decompile each caller and look for action-code clues.
        for (Function caller : callers) {
            w("--- " + caller.getName() + " @ " + caller.getEntryPoint() + " ---");
            DecompileResults r = decomp.decompileFunction(caller, 90, monitor);
            if (!r.decompileCompleted()) {
                w("  // decompile failed: " + r.getErrorMessage());
                continue;
            }
            DecompiledFunction dc = r.getDecompiledFunction();
            String body = dc == null ? "" : dc.getC();

            // Extract lines that touch a struct's [0] slot (action code)
            // or the call site itself.
            String[] bodyLines = body.split("\n");
            for (String l : bodyLines) {
                String trim = l.trim();
                // Look for FUN_14033ec70 invocation lines.
                if (trim.contains("FUN_14033ec70")) {
                    w("  CALL: " + trim);
                }
                // Look for assignments that LOOK LIKE action-code setup.
                // The struct lives on the stack; assignments to its [0] index
                // are the action code.
                if (trim.matches(".*\\[0\\].*=.*[0-9].*;.*")
                    || trim.matches(".*local_[0-9a-f]+\\s*=\\s*[0-9].*;.*")) {
                    // Filter to lines mentioning small integer constants.
                    if (trim.contains("0x") || trim.matches(".*=\\s*\\d+;.*")) {
                        w("  ASSIGN: " + trim);
                    }
                }
            }
            w("");
        }

        w("################################################################################");
        w("## PART A.2 — Full decompile of each fn=0x01 caller (for action-code reading)");
        w("################################################################################");
        w("");
        int callerIdx = 0;
        for (Function caller : callers) {
            callerIdx++;
            if (decompiled.contains(caller.getEntryPoint())) continue;
            decompiled.add(caller.getEntryPoint());

            w("════════════════════════════════════════════════════════════════════════════════");
            w("CALLER #" + callerIdx + ": " + caller.getName() + " @ " + caller.getEntryPoint());
            w("  signature: " + caller.getSignature());
            w("════════════════════════════════════════════════════════════════════════════════");
            DecompileResults r = decomp.decompileFunction(caller, 90, monitor);
            if (!r.decompileCompleted()) {
                w("  // decompile failed: " + r.getErrorMessage());
                continue;
            }
            DecompiledFunction dc = r.getDecompiledFunction();
            String body = dc == null ? "// (no body)" : dc.getC();
            for (String l : body.split("\n")) w("  " + l);
            w("");
        }
    }

    private void partB_hostEmitShapes() throws Exception {
        w("################################################################################");
        w("## PART B — Host-emit wire shapes for remaining workflows");
        w("################################################################################");
        w("");

        Set<Long> builderTargets = new HashSet<>(Arrays.asList(FUN_BUILDER_A, FUN_BUILDER_B));

        for (int idx = 0; idx < TARGET_FNS.length; idx++) {
            long fnByte = TARGET_FNS[idx][0];
            String label = FN_LABELS[idx];
            w("════════════════════════════════════════════════════════════════════════════════");
            w("## fn=0x" + Long.toHexString(fnByte) + " — " + label);
            w("════════════════════════════════════════════════════════════════════════════════");
            w("");

            // Find every caller (CALL to a builder with fnByte as preceding
            // immediate within 14-instruction window).
            Set<Address> emitters = findEmittersOf(fnByte, builderTargets);
            w("Host emitters: " + emitters.size());
            for (Address fa : emitters) {
                Function f = funcMgr.getFunctionAt(fa);
                if (f == null) continue;
                w("  " + f.getName() + " @ " + fa);
            }
            w("");

            // Decompile each emitter (skip already-decompiled).
            for (Address fa : emitters) {
                if (!decompiled.add(fa)) {
                    w("(already decompiled: " + fa + ")");
                    w("");
                    continue;
                }
                Function f = funcMgr.getFunctionAt(fa);
                if (f == null) continue;
                w("--- " + f.getName() + " @ " + fa + " ---");
                w("  signature: " + f.getSignature());
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
        }
    }

    private Set<Address> findEmittersOf(long fnByte, Set<Long> builderTargets) {
        Set<Address> emitters = new LinkedHashSet<>();
        ArrayDeque<Instruction> window = new ArrayDeque<>();
        InstructionIterator it = listing.getInstructions(true);
        while (it.hasNext()) {
            Instruction ins = it.next();
            window.addLast(ins);
            if (window.size() > 14) window.removeFirst();

            if (!ins.getFlowType().isCall()) continue;
            long target = -1;
            for (Reference r : ins.getReferencesFrom()) {
                if (!r.getReferenceType().isCall()) continue;
                target = r.getToAddress().getOffset();
                break;
            }
            if (!builderTargets.contains(target)) continue;

            boolean hasFn = false;
            for (Instruction prev : window) {
                for (int op = 0; op < prev.getNumOperands(); op++) {
                    for (Object o : prev.getOpObjects(op)) {
                        if (!(o instanceof Scalar)) continue;
                        long v = ((Scalar) o).getUnsignedValue();
                        if (v == fnByte) { hasFn = true; break; }
                    }
                    if (hasFn) break;
                }
                if (hasFn) break;
            }
            if (!hasFn) continue;

            Function callerFn = funcMgr.getFunctionContaining(ins.getAddress());
            if (callerFn != null) emitters.add(callerFn.getEntryPoint());
        }
        return emitters;
    }

    private Address addrOf(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
