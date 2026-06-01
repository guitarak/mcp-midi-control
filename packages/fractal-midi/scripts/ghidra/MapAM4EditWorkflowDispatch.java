// MapAM4EditWorkflowDispatch.java - Ghidra GhidraScript
//
// Follow-up to FindAM4EditPresetParser.java. The workflow registry
// (FUN_1402d83d0, 35+ named workflows) is the WRITE side. The READ
// side - the function(s) that consume inbound SysEx and route to a
// workflow's per-state handler - is the next mining target.
//
// Three complementary anchors:
//
//  1. Callers of FUN_1402d83d0. That tells us which parent class
//     owns all workflows. Sibling methods on that parent class are
//     candidate receive-side dispatchers.
//
//  2. Callers of FUN_140196500 (the registration helper), grouped by
//     containing function. 139 callers total. Most should be inside
//     FUN_1402d83d0. Outliers (functions that call it just a few
//     times) are either: (a) standalone workflow registrations not
//     in the main registry, or (b) the consumer side reading the
//     same struct fields (less likely - the helper is a writer not a
//     reader).
//
//  3. Functions referencing the "Get Preset Data" string constant.
//     If there's a string-keyed workflow lookup (analog of III's
//     iii-async-workflow-fn-registry name binder), this finds it.
//
// Output:
//   %PROJECT_ROOT%\samples\captured\decoded\ghidra-am4-edit-workflow-dispatch.txt
//
// @category AM4

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class MapAM4EditWorkflowDispatch extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-workflow-dispatch.txt";

    private static final long FUN_REGISTRY_CTOR = 0x1402d83d0L; // workflow registry constructor
    private static final long FUN_REG_HELPER    = 0x140196500L; // per-fn-byte registration helper

    // Workflow names we care about most (preset-binary related).
    private static final String[] HOT_NAMES = {
        "Get Preset Data",
        "File Export to Sysex",
        "File Export to Templates",
        "File Snapshot",
        "Save Preset",
        "Paste Preset",
        "Refresh Preset Names",
    };

    private static final int MAX_DECOMPILE_REGISTRY_CALLERS = 6;
    private static final int MAX_OUTLIER_DECOMPILES = 10;

    private final List<String> lines = new ArrayList<>();
    private FunctionManager funcMgr;
    private ReferenceManager refMgr;
    private Listing listing;
    private Memory mem;
    private DecompInterface decomp;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        refMgr = program.getReferenceManager();
        listing = program.getListing();
        mem = program.getMemory();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("MapAM4EditWorkflowDispatch.java");
        w("  Program: " + program.getName());
        w("  Output:  " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Anchor 1: callers of FUN_1402d83d0 (registry constructor) ──
        anchor1RegistryCallers();

        // ── Anchor 2: caller histogram of FUN_140196500 (reg helper) ──
        anchor2RegHelperHistogram();

        // ── Anchor 3: xrefs to HOT_NAMES strings ──────────────────────
        anchor3HotNameXrefs();

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private void anchor1RegistryCallers() throws Exception {
        w("################################################################################");
        w("## Anchor 1 - callers of FUN_1402d83d0 (workflow registry constructor)");
        w("################################################################################");
        w("");

        Address ea = addr(FUN_REGISTRY_CTOR);
        List<Function> callerFuncs = new ArrayList<>();
        Set<Long> seen = new HashSet<>();
        int callSites = 0;
        for (Reference r : refMgr.getReferencesTo(ea)) {
            if (!r.getReferenceType().isCall()) continue;
            callSites++;
            Function caller = funcMgr.getFunctionContaining(r.getFromAddress());
            if (caller == null) {
                w("  call from " + r.getFromAddress() + " (no containing function)");
                continue;
            }
            long ca = caller.getEntryPoint().getOffset();
            if (seen.add(ca)) {
                callerFuncs.add(caller);
                w("  call from " + caller.getName() + " @ " + r.getFromAddress());
            }
        }
        w("");
        w("Total call sites: " + callSites + "    Unique caller functions: " + callerFuncs.size());
        w("");

        int decompiled = 0;
        for (Function caller : callerFuncs) {
            if (decompiled++ >= MAX_DECOMPILE_REGISTRY_CALLERS) {
                w("(stopping after " + MAX_DECOMPILE_REGISTRY_CALLERS + " decompiles)");
                w("");
                break;
            }
            decompileWithHeader(caller, "registry-caller");
        }
    }

    private void anchor2RegHelperHistogram() throws Exception {
        w("################################################################################");
        w("## Anchor 2 - caller histogram of FUN_140196500 (registration helper)");
        w("################################################################################");
        w("");

        Address ea = addr(FUN_REG_HELPER);
        Map<Long, Integer> perCaller = new HashMap<>();
        Map<Long, String> nameByAddr = new HashMap<>();
        int callSites = 0;
        for (Reference r : refMgr.getReferencesTo(ea)) {
            if (!r.getReferenceType().isCall()) continue;
            callSites++;
            Function caller = funcMgr.getFunctionContaining(r.getFromAddress());
            if (caller == null) continue;
            long ca = caller.getEntryPoint().getOffset();
            perCaller.merge(ca, 1, Integer::sum);
            nameByAddr.put(ca, caller.getName());
        }
        w("Total call sites: " + callSites + "    Unique caller functions: " + perCaller.size());
        w("");

        List<Map.Entry<Long, Integer>> sorted = new ArrayList<>(perCaller.entrySet());
        sorted.sort((a, b) -> Integer.compare(b.getValue(), a.getValue()));

        w("Histogram (top = most calls, likely the main registry; outliers = candidates):");
        w("  count  | caller");
        w("  -------+--------------------------------");
        for (var e : sorted) {
            w(String.format("  %-6d | %s @ %s",
                e.getValue(), nameByAddr.get(e.getKey()), Long.toHexString(e.getKey())));
        }
        w("");

        // Decompile outliers (those that call FUN_140196500 between 1 and
        // 10 times - too few to be a top-level registry, possibly a
        // smaller workflow group or a consumer-side reader).
        w("--- Decompiling outlier callers (1-10 calls, up to " + MAX_OUTLIER_DECOMPILES + ") ---");
        w("");
        int decompiled = 0;
        for (var e : sorted) {
            if (decompiled >= MAX_OUTLIER_DECOMPILES) break;
            int count = e.getValue();
            if (count < 1 || count > 10) continue;
            Function f = funcMgr.getFunctionAt(addr(e.getKey()));
            if (f == null) continue;
            decompiled++;
            decompileWithHeader(f, "reg-helper outlier (" + count + " calls)");
        }
        if (decompiled == 0) {
            w("(no outliers; all callers register many fn-bytes)");
            w("");
        }
    }

    private void anchor3HotNameXrefs() throws Exception {
        w("################################################################################");
        w("## Anchor 3 - xrefs to preset-binary-related workflow name strings");
        w("################################################################################");
        w("");

        // Find addresses of each HOT_NAMES string in any defined memory block.
        for (String name : HOT_NAMES) {
            w("--- string: \"" + name + "\" ---");
            List<Address> hits = findString(name);
            if (hits.isEmpty()) {
                w("  (not found as a NUL-terminated literal in any block)");
                w("");
                continue;
            }
            for (Address strA : hits) {
                w("  found at " + strA);
                Set<Long> seen = new HashSet<>();
                int xrefCount = 0;
                for (Reference r : refMgr.getReferencesTo(strA)) {
                    xrefCount++;
                    Function caller = funcMgr.getFunctionContaining(r.getFromAddress());
                    if (caller == null) {
                        w("    xref from " + r.getFromAddress() + " (no func)");
                        continue;
                    }
                    long ca = caller.getEntryPoint().getOffset();
                    if (seen.add(ca)) {
                        w("    xref in " + caller.getName() + " @ " + r.getFromAddress());
                    }
                }
                if (xrefCount == 0) w("    (no direct xrefs)");
            }
            w("");
        }
    }

    private List<Address> findString(String needle) throws Exception {
        // Brute-force scan of all initialized memory for the NUL-terminated
        // ASCII literal. Cheap enough at AM4-Edit's size.
        List<Address> hits = new ArrayList<>();
        byte[] needleBytes = (needle + "\0").getBytes(StandardCharsets.US_ASCII);
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized() || !block.isRead()) continue;
            Address start = block.getStart();
            Address end = block.getEnd();
            byte[] buf = new byte[(int) Math.min(block.getSize(), 64L * 1024 * 1024)];
            try {
                mem.getBytes(start, buf);
            } catch (Exception ex) {
                continue;
            }
            for (int i = 0; i + needleBytes.length <= buf.length; i++) {
                boolean match = true;
                for (int j = 0; j < needleBytes.length; j++) {
                    if (buf[i + j] != needleBytes[j]) { match = false; break; }
                }
                if (match) {
                    hits.add(start.add(i));
                    if (hits.size() > 10) return hits; // safety cap
                }
            }
        }
        return hits;
    }

    private void decompileWithHeader(Function f, String tag) throws Exception {
        w("--- " + tag + ": " + f.getName() + " @ " + f.getEntryPoint() + " ---");
        DecompileResults r = decomp.decompileFunction(f, 90, monitor);
        if (!r.decompileCompleted()) {
            w("  // decompile failed: " + r.getErrorMessage());
            w("");
            return;
        }
        DecompiledFunction dc = r.getDecompiledFunction();
        String body = dc == null ? "// (no body)" : dc.getC();
        int max = 400;
        int i = 0;
        for (String l : body.split("\n")) {
            if (i++ >= max) { w("  ... (truncated at " + max + " lines)"); break; }
            w("  " + l);
        }
        w("");
    }

    private Address addr(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
