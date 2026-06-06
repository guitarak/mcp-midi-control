// DecompileAxeEditIIIRoutingComposer.java — Ghidra GhidraScript
//
// Recover the gen-3 sub=0x35 routing-write PAYLOAD COMPOSER from Axe-Edit III.
//
// Correction over FindAxeEditIIIBlockConnectEmitter.java: fn=0x33 is the
// INBOUND reply byte the "Block Connect" workflow LISTENS for, not the emitted
// byte. The editor EMITS routing as fn=0x01 sub=0x35, composed inside the
// workflow state-machine executor FUN_1401f4390 (switch @ L11215), which calls
// the fn=0x01 builder FUN_14033ec70. This script decompiles the executor + the
// builder + the workflow registrar, and pinpoints every 0x35 / 0x33 immediate
// site so the Block-Connect case (which computes endpoint bytes 21/22/23) is
// directly readable.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-routing-composer.txt
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

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.ArrayList;
import java.util.List;

public class DecompileAxeEditIIIRoutingComposer extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-routing-composer.txt";

    // Addresses from the 2026-05-22 inbound-dispatcher synthesis (this project).
    private static final long FUN_EXECUTOR = 0x1401f4390L; // workflow state machine (switch @ L11215)
    private static final long FUN_FN01_BUILDER = 0x14033ec70L; // fn=0x01 builder
    private static final long FUN_REGISTRAR = 0x1401f0f10L; // registers ~60 workflows incl Block Connect

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private Listing listing;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        listing = program.getListing();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("DecompileAxeEditIIIRoutingComposer.java");
        w("  executor      FUN_1401f4390  (sub=0x35 routing composed here)");
        w("  fn=01 builder FUN_14033ec70");
        w("  registrar     FUN_1401f0f10  (Block Connect workflow + state IDs)");
        w("================================================================================");
        w("");

        // 1. Pinpoint 0x35 and 0x33 immediates inside the executor — the routing case.
        scanImmediates(FUN_EXECUTOR, new long[] { 0x35, 0x33 });

        // 2. Full decompile of the three functions.
        decompile(FUN_EXECUTOR, "EXECUTOR FUN_1401f4390");
        decompile(FUN_FN01_BUILDER, "FN01 BUILDER FUN_14033ec70");
        decompile(FUN_REGISTRAR, "REGISTRAR FUN_1401f0f10");

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private void scanImmediates(long funcAddr, long[] targets) {
        Function f = funcMgr.getFunctionAt(addrOf(funcAddr));
        if (f == null) { w("// scanImmediates: no function @ 0x" + Long.toHexString(funcAddr)); w(""); return; }
        w("## Immediate-operand sites in " + f.getName() + " (targets: 0x35, 0x33):");
        InstructionIterator it = listing.getInstructions(f.getBody(), true);
        int hits = 0;
        while (it.hasNext()) {
            Instruction ins = it.next();
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    if (!(o instanceof Scalar)) continue;
                    long v = ((Scalar) o).getUnsignedValue();
                    for (long t : targets) {
                        if (v == t) {
                            w(String.format("   %s : %s   [imm 0x%x]", ins.getAddress(), ins.toString(), v));
                            hits++;
                        }
                    }
                }
            }
        }
        w("   (" + hits + " sites)");
        w("");
    }

    private void decompile(long funcAddr, String label) {
        Function f = funcMgr.getFunctionAt(addrOf(funcAddr));
        w("################################################################################");
        w("## " + label + " @ 0x" + Long.toHexString(funcAddr));
        w("################################################################################");
        if (f == null) { w("// no function at this address in current analysis"); w(""); return; }
        w("##   signature: " + f.getSignature());
        DecompileResults r = decomp.decompileFunction(f, 120, monitor);
        if (!r.decompileCompleted()) { w("// decompile failed: " + r.getErrorMessage()); w(""); return; }
        DecompiledFunction dc = r.getDecompiledFunction();
        String body = dc == null ? "// (no body)" : dc.getC();
        for (String l : body.split("\n")) w(l);
        w("");
    }

    private Address addrOf(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
