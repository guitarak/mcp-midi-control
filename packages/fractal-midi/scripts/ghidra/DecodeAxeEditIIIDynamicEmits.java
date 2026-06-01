// DecodeAxeEditIIIDynamicEmits.java — Ghidra GhidraScript
//
// Decompiles the 3 III host-emit sites where the precise data-flow
// scan could not resolve the fn-byte to a constant. For each one:
//
//   - Dump the emit function's decompile.
//   - Dump every caller of the emit function (one level up) — this is
//     where the fn-byte is most often passed in as a constant arg.
//   - Print nearby .rdata string xrefs at each call site for context.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-dynamic-emits-decode.txt
//
// @category AxeFxIII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class DecodeAxeEditIIIDynamicEmits extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-dynamic-emits-decode.txt";

    // From host-emitter-map-ghidra.md "Dynamic fn-byte emits" appendix.
    // Each entry is { emit_function_addr, call_site_addr, builder_label }.
    private static final String[][] SITES = {
        { "14014ced0", "14014cfc0", "FUN_1403434b0" },
        { "1401a1a20", "1401a2597", "FUN_1403434b0" },
        { "140335f50", "140336009", "FUN_1403437d0" },
    };

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private Listing listing;
    private ReferenceManager refMgr;

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
        w("DecodeAxeEditIIIDynamicEmits.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("");
        w("  Decompiles the 3 III host-emit sites where pcode data-flow analysis");
        w("  couldn't resolve the fn-byte to a constant. The fn-byte is loaded");
        w("  from a struct field or passed in as a function argument; this script");
        w("  walks one level up to the callers to find where it gets set.");
        w("================================================================================");
        w("");

        for (String[] site : SITES) {
            Address emitAddr = addrOf(parseHex(site[0]));
            Address callAddr = addrOf(parseHex(site[1]));
            String builder = site[2];

            w("################################################################################");
            w("## EMIT FUNCTION: FUN_" + site[0] + "   (call site @ " + callAddr + ", builder " + builder + ")");
            w("################################################################################");
            w("");

            // Nearby strings.
            w("--- Nearby .rdata string xrefs (±0x200 around call site) ---");
            List<String> nearby = findNearbyStrings(callAddr, 0x200);
            if (nearby.isEmpty()) w("  (none)");
            else for (String s : nearby) w("  " + s);
            w("");

            // Decompile the emit function.
            Function emitFn = funcMgr.getFunctionAt(emitAddr);
            if (emitFn != null) {
                w("--- DECOMPILE of emit fn FUN_" + site[0] + " ---");
                w("  signature: " + emitFn.getSignature());
                String body = decompile(emitFn);
                for (String l : body.split("\n")) w("  " + l);
                w("");
            }

            // Find callers and decompile each one.
            Set<Function> callers = new LinkedHashSet<>();
            for (Reference r : refMgr.getReferencesTo(emitAddr)) {
                if (!r.getReferenceType().isCall()) continue;
                Function cf = funcMgr.getFunctionContaining(r.getFromAddress());
                if (cf != null && cf != emitFn) callers.add(cf);
            }
            w("--- " + callers.size() + " CALLER(S) of FUN_" + site[0] + " ---");
            if (callers.isEmpty()) {
                w("  (no callers — emit fn is dispatched indirectly via function pointer)");
            } else {
                int idx = 0;
                for (Function caller : callers) {
                    idx += 1;
                    w("  CALLER #" + idx + ": " + caller.getName() + " @ " + caller.getEntryPoint());
                    w("    signature: " + caller.getSignature());
                    String body = decompile(caller);
                    for (String l : body.split("\n")) w("    " + l);
                    w("");
                }
            }
            w("");
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private String decompile(Function fn) {
        DecompileResults r = decomp.decompileFunction(fn, 120, monitor);
        if (!r.decompileCompleted()) return "// decompile failed: " + r.getErrorMessage();
        DecompiledFunction dc = r.getDecompiledFunction();
        return dc == null ? "// (no body)" : dc.getC();
    }

    private List<String> findNearbyStrings(Address callAddr, int radius) {
        List<String> hits = new ArrayList<>();
        long callOff = callAddr.getOffset();
        for (long off = callOff - radius; off <= callOff + radius; off += 1) {
            Address a = addrOf(off);
            for (Reference r : refMgr.getReferencesFrom(a)) {
                Address to = r.getToAddress();
                Data data = listing.getDataAt(to);
                if (data == null) continue;
                if (!data.hasStringValue()) continue;
                StringDataInstance sdi = StringDataInstance.getStringDataInstance(data);
                if (sdi == null) continue;
                String s = sdi.getStringValue();
                if (s == null || s.length() < 3 || s.length() > 200) continue;
                hits.add(to + ": \"" + s.replace("\n", "\\n") + "\"");
            }
        }
        Set<String> seen = new LinkedHashSet<>(hits);
        return new ArrayList<>(seen);
    }

    private Address addrOf(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }

    private static long parseHex(String s) { return Long.parseLong(s, 16); }
}
