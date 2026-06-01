// DecodeAxeEditIIINewFnBytes.java — Ghidra GhidraScript
//
// Decompiles the III emit functions for the three fn-bytes that
// surfaced in PreciseAxeEditIIIHostEmitters.java but aren't in the
// 44-workflow Rosetta Stone:
//
//   fn=0x08 — 6 emit sites
//   fn=0x43 — 2 emit sites
//   fn=0xFF — 1 emit site
//
// For each site, dumps:
//   - the emit function's decompile
//   - the immediate caller's decompile (one level up, for context)
//   - any nearby .rdata string anchors (within ±0x200 of the call addr)
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-new-fnbytes-decode.txt
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

public class DecodeAxeEditIIINewFnBytes extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-new-fnbytes-decode.txt";

    // From host-emitter-map-ghidra.md "PER-FN-BYTE EMITTER DETAIL".
    // Each entry is { fn_byte_label, emit_function_addr, call_site_addr }.
    private static final String[][] EMIT_SITES = {
        // fn=0x08 — six sites
        { "0x08", "140150570", "1401505b5" },
        { "0x08", "14015d6f0", "14015dce8" },
        { "0x08", "1401c0690", "1401c0dd3" },
        { "0x08", "1401c12f0", "1401c1340" },
        { "0x08", "14033b290", "14033b2ac" },
        { "0x08", "1401f4390", "1401f4bb0" },
        // fn=0x43 — two sites
        { "0x43", "14033d040", "14033d05c" },
        { "0x43", "14014bcd0", "14014c232" },
        // fn=0xFF — single site
        { "0xFF", "14033db70", "14033dbf9" },
    };

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private Listing listing;
    private ReferenceManager refMgr;
    private final Set<String> alreadyDecompiled = new HashSet<>();

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
        w("DecodeAxeEditIIINewFnBytes.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("");
        w("  Decompiles the III emit functions for fn-bytes 0x08 / 0x43 / 0xFF.");
        w("  These bytes surfaced in the precise host-emit scan but aren't in");
        w("  the 44-workflow Rosetta Stone — their operations are unknown.");
        w("================================================================================");
        w("");

        // Group sites by fn-byte for organized output.
        Map<String, List<String[]>> byFn = new LinkedHashMap<>();
        for (String[] site : EMIT_SITES) {
            byFn.computeIfAbsent(site[0], k -> new ArrayList<>()).add(site);
        }

        for (var e : byFn.entrySet()) {
            String fnByte = e.getKey();
            w("################################################################################");
            w("## fn=" + fnByte + "  (" + e.getValue().size() + " emit sites)");
            w("################################################################################");
            w("");

            for (String[] site : e.getValue()) {
                Address emitAddr = addrOf(parseHex(site[1]));
                Address callAddr = addrOf(parseHex(site[2]));

                w("================================================================================");
                w("EMIT FUNCTION: FUN_" + site[1] + " (call site @ " + callAddr + ")");
                w("================================================================================");
                w("");

                // ── Nearby strings (±0x200) at call addr ──
                w("--- Nearby .rdata string xrefs (±0x200 around call site) ---");
                List<String> nearby = findNearbyStrings(callAddr, 0x200);
                if (nearby.isEmpty()) {
                    w("  (none)");
                } else {
                    for (String s : nearby) w("  " + s);
                }
                w("");

                // ── Decompile the emit function ──
                w("--- DECOMPILE of FUN_" + site[1] + " ---");
                Function emitFn = funcMgr.getFunctionAt(emitAddr);
                if (emitFn == null) {
                    w("  (no function at " + emitAddr + ")");
                    w("");
                    continue;
                }
                w("  signature: " + emitFn.getSignature());
                String body = decompile(emitFn);
                for (String l : body.split("\n")) w("  " + l);
                w("");

                // ── Decompile one level up (callers of the emit fn) ──
                w("--- CALLERS of FUN_" + site[1] + " (one level up for context) ---");
                Set<Function> callers = new LinkedHashSet<>();
                for (Reference r : refMgr.getReferencesTo(emitAddr)) {
                    if (!r.getReferenceType().isCall()) continue;
                    Function cf = funcMgr.getFunctionContaining(r.getFromAddress());
                    if (cf != null && cf != emitFn) callers.add(cf);
                }
                if (callers.isEmpty()) {
                    w("  (no callers — possibly the emit fn is dispatched indirectly)");
                } else {
                    for (Function caller : callers) {
                        w("  CALLER: " + caller.getName() + " @ " + caller.getEntryPoint());
                        // Skip re-decompile if we already showed this caller body.
                        String key = caller.getEntryPoint().toString();
                        if (alreadyDecompiled.add(key)) {
                            String cBody = decompile(caller);
                            for (String l : cBody.split("\n")) w("    " + l);
                        } else {
                            w("    (decompile already shown earlier)");
                        }
                        w("");
                    }
                }
                w("");
            }
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

    /**
     * Scan +/- radius bytes around addr looking for any defined string Data.
     * Returns one line per hit: "addr: \"string content\"".
     */
    private List<String> findNearbyStrings(Address callAddr, int radius) {
        List<String> hits = new ArrayList<>();
        // Look at references FROM addresses within the radius window.
        long callOff = callAddr.getOffset();
        long start = callOff - radius;
        long end = callOff + radius;
        for (long off = start; off <= end; off += 1) {
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
        // Dedup while preserving order.
        Set<String> seen = new LinkedHashSet<>(hits);
        return new ArrayList<>(seen);
    }

    private Address addrOf(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }

    private static long parseHex(String s) {
        return Long.parseLong(s, 16);
    }
}
