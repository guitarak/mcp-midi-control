// PreciseAxeEditIIIHostEmitters.java — Ghidra GhidraScript
//
// Replaces the earlier 14-instruction-window fn-byte detection (which
// had false positives — any `0x10` literal inside a function body would
// tag it as a Save Preset emitter, even when 0x10 is a block-ID, scene
// index, or dialog mode flag) with HighFunction PcodeOp data-flow
// analysis.
//
// For every CALL pcode op targeting one of the III's two generic
// SysEx builders (FUN_1403434b0 or FUN_1403437d0):
//   - Identify the fn-byte argument's Varnode (arg index 1 — second
//     positional arg per both builders' signatures).
//   - If the Varnode is a constant, record (caller, call_addr, fn_byte).
//   - If not constant, trace its def back one step via Varnode.getDef()
//     and re-check. If still not constant, mark as DYNAMIC.
//
// The output is a clean per-fn-byte emitter list with zero
// "imm-in-the-vicinity" false positives. Compares cleanly against
// MapAxeEditIIIHostEmitters.java's window-based output.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-host-emitters-precise.txt
//
// @category AxeFxIII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Program;
import ghidra.program.model.pcode.HighFunction;
import ghidra.program.model.pcode.PcodeOp;
import ghidra.program.model.pcode.PcodeOpAST;
import ghidra.program.model.pcode.Varnode;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class PreciseAxeEditIIIHostEmitters extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-host-emitters-precise.txt";

    // The III's two generic SysEx builders.
    //
    // FUN_1403434b0 — 4-arg `(buf, fn_byte, ?, payload_ptr)`
    // FUN_1403437d0 — 5-arg `(buf, fn_byte, payload, len, model)`
    //
    // For both, the fn-byte is the SECOND positional arg. In a PcodeOp
    // CALL, input[0] is the call target Varnode, input[1] is the FIRST
    // positional arg, input[2] is the SECOND positional arg (= fn_byte).
    private static final long FUN_BUILDER_A = 0x1403434b0L;
    private static final long FUN_BUILDER_B = 0x1403437d0L;
    // FUN_14014d2a0 hardcodes fn=0x77 (PRESET_DUMP HEADER) — its callers
    // all emit fn=0x77 by definition; included for completeness.
    private static final long FUN_BUILDER_C = 0x14014d2a0L;

    // Workflow labels (subset — same source as MapAxeEditIIIHostEmitters).
    private static final String[][] WORKFLOW_NAMES = {
        { "0x0E", "Initialization (sub)" },
        { "0x0F", "Initialization (sub)" },
        { "0x10", "Save Preset" },
        { "0x12", "Revert Preset" },
        { "0x14", "Set Preset Name" },
        { "0x15", "Change Scene" },
        { "0x18", "Swap Scenes" },
        { "0x19", "File Snapshot / Export / Get Preset Data" },
        { "0x1A", "Export User Cab" },
        { "0x1B", "Import Preset Bundle" },
        { "0x1C", "Export Preset Bundle" },
        { "0x1F", "Paste Preset (sub)" },
        { "0x20", "Import User Cab (sub)" },
        { "0x22", "Paste Preset / Import User Cab (sub)" },
        { "0x24", "Block list (Delete/Insert/Move sub)" },
        { "0x28", "Insert Block (sub)" },
        { "0x30", "Reset Block" },
        { "0x31", "Move Block" },
        { "0x40", "Load/Select Preset" },
        { "0x46", "Query device version" },
        { "0x47", "Initialization / Param Definitions (sub)" },
        { "0x77", "PRESET_DUMP HEADER (hardcoded via FUN_14014d2a0)" },
    };

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private ReferenceManager refMgr;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        refMgr = program.getReferenceManager();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("PreciseAxeEditIIIHostEmitters.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("");
        w("  Replaces the 14-instruction-window fn-byte detection from");
        w("  MapAxeEditIIIHostEmitters.java with HighFunction pcode data-flow");
        w("  analysis. For every CALL to FUN_1403434b0 / FUN_1403437d0, walk");
        w("  the fn-byte arg's Varnode chain to find its actual constant.");
        w("================================================================================");
        w("");

        // ── Step 1: collect distinct callers of the two builders ────
        Set<Function> callers = new LinkedHashSet<>();
        for (long builderAddr : new long[] { FUN_BUILDER_A, FUN_BUILDER_B }) {
            Address ba = addrOf(builderAddr);
            for (Reference r : refMgr.getReferencesTo(ba)) {
                if (!r.getReferenceType().isCall()) continue;
                Function cf = funcMgr.getFunctionContaining(r.getFromAddress());
                if (cf != null) callers.add(cf);
            }
        }
        w("Step 1: distinct callers of FUN_1403434b0 / FUN_1403437d0 = " + callers.size());
        w("");

        // ── Step 2: decompile each caller and scan its PcodeOps ────
        // fnByte → set of (caller, call_addr).
        Map<Long, List<EmitSite>> fnByteToEmits = new TreeMap<>();
        List<EmitSite> dynamicEmits = new ArrayList<>();
        int processed = 0;
        for (Function caller : callers) {
            processed += 1;
            if (processed % 25 == 1) {
                println("  Decompiling " + processed + "/" + callers.size() + ": " + caller.getName());
            }

            DecompileResults res = decomp.decompileFunction(caller, 90, monitor);
            if (!res.decompileCompleted()) continue;
            HighFunction hf = res.getHighFunction();
            if (hf == null) continue;

            Iterator<PcodeOpAST> it = hf.getPcodeOps();
            while (it.hasNext()) {
                PcodeOpAST op = it.next();
                int opc = op.getOpcode();
                if (opc != PcodeOp.CALL && opc != PcodeOp.CALLIND) continue;
                Varnode target = op.getInput(0);
                if (target == null) continue;
                long targetAddr;
                if (target.isConstant() || target.isAddress()) {
                    targetAddr = target.getAddress().getOffset();
                } else {
                    continue;
                }
                if (targetAddr != FUN_BUILDER_A && targetAddr != FUN_BUILDER_B) continue;

                // Find the fn-byte arg = SECOND positional arg = input index 2
                // (input[0] = call target, input[1] = first positional = buf,
                //  input[2] = second positional = fn_byte).
                if (op.getNumInputs() < 3) continue;
                Varnode fnArg = op.getInput(2);
                Long fnByte = traceConstantValue(fnArg, 8);
                Address callAddr = op.getSeqnum().getTarget();

                EmitSite site = new EmitSite();
                site.caller = caller;
                site.callAddr = callAddr;
                site.builder = targetAddr;
                site.fnByte = fnByte;

                if (fnByte == null) {
                    dynamicEmits.add(site);
                } else {
                    fnByteToEmits.computeIfAbsent(fnByte, k -> new ArrayList<>()).add(site);
                }
            }
        }

        // ── Step 3: include FUN_14014d2a0 callers as fn=0x77 emits ──
        Address bc = addrOf(FUN_BUILDER_C);
        Set<Function> bcCallers = new LinkedHashSet<>();
        for (Reference r : refMgr.getReferencesTo(bc)) {
            if (!r.getReferenceType().isCall()) continue;
            Function cf = funcMgr.getFunctionContaining(r.getFromAddress());
            if (cf != null) {
                EmitSite site = new EmitSite();
                site.caller = cf;
                site.callAddr = r.getFromAddress();
                site.builder = FUN_BUILDER_C;
                site.fnByte = 0x77L;
                fnByteToEmits.computeIfAbsent(0x77L, k -> new ArrayList<>()).add(site);
                bcCallers.add(cf);
            }
        }

        // ── Step 4: render summary ──
        Map<String, String> labelByFn = new HashMap<>();
        for (String[] e : WORKFLOW_NAMES) labelByFn.put(e[0], e[1]);

        w("################################################################################");
        w("## PRECISE HOST-EMITTER MAP (fn-byte arg traced via PcodeOp data-flow)");
        w("################################################################################");
        w("");
        w(String.format("  %-7s | %-7s | %s", "fn", "emits", "workflow label"));
        w("  --------+---------+-----------------------------------------------");
        for (var e : fnByteToEmits.entrySet()) {
            String fnHex = String.format("0x%02X", e.getKey());
            String label = labelByFn.getOrDefault(fnHex, "(no workflow label)");
            w(String.format("  %-7s | %7d | %s", fnHex, e.getValue().size(), label));
        }
        w("");
        w("Dynamic fn-byte emits (arg not a constant — runtime-determined): "
                + dynamicEmits.size());
        w("");

        // ── Step 5: per-fn-byte caller detail ──
        w("################################################################################");
        w("## PER-FN-BYTE EMITTER DETAIL");
        w("################################################################################");
        w("");
        for (var e : fnByteToEmits.entrySet()) {
            String fnHex = String.format("0x%02X", e.getKey());
            String label = labelByFn.getOrDefault(fnHex, "");
            w(fnHex + "  " + label);
            // Dedup by (caller, callAddr).
            Set<String> seen = new LinkedHashSet<>();
            for (EmitSite site : e.getValue()) {
                String key = site.caller.getName() + "@" + site.callAddr;
                if (!seen.add(key)) continue;
                String builderLabel = site.builder == FUN_BUILDER_A ? "FUN_1403434b0"
                        : site.builder == FUN_BUILDER_B ? "FUN_1403437d0"
                        : site.builder == FUN_BUILDER_C ? "FUN_14014d2a0 (hardcoded 0x77)"
                        : String.format("0x%x", site.builder);
                w(String.format("  %-30s @ %-16s  via %s",
                        site.caller.getName(),
                        site.callAddr.toString(),
                        builderLabel));
            }
            w("");
        }

        // ── Step 6: dynamic-emit dump (worth manual inspection) ──
        if (!dynamicEmits.isEmpty()) {
            w("################################################################################");
            w("## DYNAMIC fn-byte EMITS (fn arg is not a constant — runtime-loaded)");
            w("################################################################################");
            w("");
            w("These call sites pass the fn-byte as a non-constant Varnode.");
            w("Typical pattern: fn is loaded from a struct field (e.g. *(uint *)(obj + 0x30))");
            w("or passed in from a caller. Listed here for manual inspection.");
            w("");
            for (EmitSite site : dynamicEmits) {
                String builderLabel = site.builder == FUN_BUILDER_A ? "FUN_1403434b0"
                        : site.builder == FUN_BUILDER_B ? "FUN_1403437d0"
                        : String.format("0x%x", site.builder);
                w(String.format("  %-30s @ %-16s  via %s",
                        site.caller.getName(),
                        site.callAddr.toString(),
                        builderLabel));
            }
            w("");
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    /**
     * Walk a Varnode's def chain looking for a constant value.
     * Handles common decompiler patterns:
     *   - direct constant (Varnode.isConstant)
     *   - COPY of a constant
     *   - INT_ZEXT / INT_SEXT of a constant
     *   - SUBPIECE of a constant
     *   - INT_AND of a constant with a register (mask of constant)
     * Returns null if the chain doesn't terminate in a unique constant
     * within `maxDepth` steps.
     */
    private Long traceConstantValue(Varnode v, int maxDepth) {
        if (v == null) return null;
        if (maxDepth <= 0) return null;
        if (v.isConstant()) {
            // Truncate to byte (fn-byte is u8 on the wire even though the
            // builder takes int).
            return v.getOffset() & 0xFFL;
        }
        PcodeOp def = v.getDef();
        if (def == null) return null;
        int opc = def.getOpcode();
        switch (opc) {
            case PcodeOp.COPY:
            case PcodeOp.CAST:
            case PcodeOp.INT_ZEXT:
            case PcodeOp.INT_SEXT:
            case PcodeOp.SUBPIECE:
                return traceConstantValue(def.getInput(0), maxDepth - 1);
            case PcodeOp.INT_AND:
                // INT_AND(x, mask) where x is constant → constant.
                // Or INT_AND(reg, mask) → not constant.
                Long lhs = traceConstantValue(def.getInput(0), maxDepth - 1);
                Long rhs = traceConstantValue(def.getInput(1), maxDepth - 1);
                if (lhs != null && rhs != null) return lhs & rhs;
                return null;
            case PcodeOp.MULTIEQUAL:
                // Phi node — multiple incoming values. If all incoming
                // values trace to the same constant, return it.
                Long agreed = null;
                for (int i = 0; i < def.getNumInputs(); i += 1) {
                    Long got = traceConstantValue(def.getInput(i), maxDepth - 1);
                    if (got == null) return null;
                    if (agreed == null) agreed = got;
                    else if (!agreed.equals(got)) return null;
                }
                return agreed;
            default:
                return null;
        }
    }

    private Address addrOf(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }

    private static class EmitSite {
        Function caller;
        Address callAddr;
        long builder;
        Long fnByte;
    }
}
