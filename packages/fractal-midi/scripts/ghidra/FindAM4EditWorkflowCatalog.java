// FindAM4EditWorkflowCatalog.java — Ghidra GhidraScript
//
// Check whether AM4-Edit uses the same state-machine architecture as
// AxeEdit III (where FUN_1401f0f10 registers 44+ named workflows).
//
// Two hypotheses:
//
//   H1 (matches III): AM4-Edit has an analog function that calls
//   FUN_14005faa0-style label-string registration + FUN_1401bac70-style
//   fn-byte subscription. Recover the same Rosetta Stone for AM4.
//
//   H2 (different arch): AM4-Edit is simpler (4 slots, fewer ops) and
//   uses a different dispatch model — fall through and report negative.
//
// Strategy:
//   1. Find the AM4 analog of FUN_14005faa0 — the std::string registrator.
//      Look for functions that take a (str *, char *) signature and copy
//      the string into the first arg.
//   2. Find the AM4 analog of FUN_1401bac70 — the subscription hook. A
//      3-arg function called repeatedly with small int constants from
//      the same context struct.
//   3. Look for functions that call BOTH within close proximity — those
//      are workflow initializers analogous to III's FUN_1401f0f10.
//
// Output: samples/captured/decoded/ghidra-am4-edit-workflow-catalog.txt
//
// @category AM4Edit

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
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
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class FindAM4EditWorkflowCatalog extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-workflow-catalog.txt";

    // Look for short capitalized phrases that look like workflow names.
    // The III used names like "Query device version", "Change Preset", etc.
    // AM4 plausibly has analogous strings: "Query device version",
    // "Save Preset", "Set Tempo", "Bypass Block", etc.
    //
    // Capture all short ASCII strings (2..50 chars, starts with capital,
    // contains a space or dash, no path separators) — these are the
    // workflow-label candidates.

    private static final int MAX_FUNCS_TO_DECOMPILE = 15;

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private Listing listing;
    private Memory mem;
    private ReferenceManager refMgr;

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        funcMgr = program.getFunctionManager();
        listing = program.getListing();
        mem = program.getMemory();
        refMgr = program.getReferenceManager();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("FindAM4EditWorkflowCatalog.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Pass 1: enumerate candidate workflow-label strings ───────
        // Look for ASCII strings 4..60 chars, starting with a capital
        // letter, containing a space or letter+letter (workflow names
        // are usually phrases like "Save Preset", "Query device version").
        Map<Long, String> workflowLabels = new TreeMap<>();
        DataIterator dataIter = listing.getDefinedData(true);
        while (dataIter.hasNext()) {
            if (monitor.isCancelled()) break;
            Data d = dataIter.next();
            if (!d.hasStringValue()) continue;
            StringDataInstance s = StringDataInstance.getStringDataInstance(d);
            if (s == null) continue;
            String text = s.getStringValue();
            if (text == null) continue;
            if (!isWorkflowLabel(text)) continue;
            workflowLabels.put(d.getAddress().getOffset(), text);
        }
        w("Workflow-label candidates: " + workflowLabels.size());
        int sample = 0;
        for (var e : workflowLabels.entrySet()) {
            if (sample++ >= 50) break;
            w(String.format("  0x%08x  \"%s\"", e.getKey(), e.getValue()));
        }
        w("");

        // ── Pass 2: rank functions by # of label-string refs ─────────
        // The workflow initializer in III had ~44 unique label refs.
        // The AM4 analog (if it exists) will have many label refs too.
        Set<Long> labelAddrs = workflowLabels.keySet();
        Map<Address, List<Long>> funcLabelRefs = new HashMap<>();
        InstructionIterator it = listing.getInstructions(true);
        while (it.hasNext()) {
            Instruction ins = it.next();
            Function f = funcMgr.getFunctionContaining(ins.getAddress());
            if (f == null) continue;
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    long v = -1;
                    if (o instanceof Scalar) v = ((Scalar) o).getUnsignedValue();
                    else if (o instanceof Address) v = ((Address) o).getOffset();
                    if (v < 0 || !labelAddrs.contains(v)) continue;
                    funcLabelRefs.computeIfAbsent(f.getEntryPoint(),
                        k -> new ArrayList<>()).add(v);
                }
            }
            // Also Ghidra-resolved references.
            for (Reference r : ins.getReferencesFrom()) {
                long toAddr = r.getToAddress().getOffset();
                if (!labelAddrs.contains(toAddr)) continue;
                funcLabelRefs.computeIfAbsent(f.getEntryPoint(),
                    k -> new ArrayList<>()).add(toAddr);
            }
        }

        List<Map.Entry<Address, List<Long>>> ranked =
            new ArrayList<>(funcLabelRefs.entrySet());
        ranked.sort((a, b) -> {
            int aDistinct = new HashSet<>(a.getValue()).size();
            int bDistinct = new HashSet<>(b.getValue()).size();
            return Integer.compare(bDistinct, aDistinct);
        });

        w("################################################################################");
        w("## TOP 20 — functions referencing the most distinct workflow-label strings");
        w("################################################################################");
        w("  rank | func @ entry         | distinct labels | sample");
        w("  -----+----------------------+-----------------+--------------------------");
        for (int i = 0; i < Math.min(20, ranked.size()); i++) {
            var e = ranked.get(i);
            Function f = funcMgr.getFunctionAt(e.getKey());
            String fname = f == null ? "?" : f.getName();
            Set<Long> distinct = new LinkedHashSet<>(e.getValue());
            String sampleStr = distinct.stream().limit(3)
                .map(a -> "\"" + workflowLabels.get(a) + "\"")
                .reduce((a, b) -> a + ", " + b).orElse("");
            w(String.format("  %4d | %-20s | %15d | %s",
                i + 1, fname + " @ " + e.getKey(), distinct.size(), sampleStr));
        }
        w("");

        // ── Pass 3: decompile top candidates ─────────────────────────
        w("################################################################################");
        w("## DECOMPILED TOP CANDIDATES");
        w("################################################################################");
        w("");
        for (int i = 0; i < Math.min(MAX_FUNCS_TO_DECOMPILE, ranked.size()); i++) {
            var e = ranked.get(i);
            Function f = funcMgr.getFunctionAt(e.getKey());
            if (f == null) continue;
            Set<Long> distinct = new LinkedHashSet<>(e.getValue());
            w("--- #" + (i + 1) + ": " + f.getName() + " @ " + e.getKey()
                + " (" + distinct.size() + " distinct labels) ---");
            w("    Labels: ");
            for (Long la : distinct) {
                w("      \"" + workflowLabels.get(la) + "\"");
            }
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
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private boolean isWorkflowLabel(String s) {
        if (s.length() < 4 || s.length() > 60) return false;
        char c0 = s.charAt(0);
        if (!(c0 >= 'A' && c0 <= 'Z')) return false;
        // Allow letters, digits, spaces, basic punct.
        boolean hasSpaceOrLowercase = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == ' ' || (c >= 'a' && c <= 'z')) hasSpaceOrLowercase = true;
            if (c == '/' || c == '\\' || c == '\n' || c == '\t') return false;
            // Limit to printable ASCII.
            if (c < 32 || c > 126) return false;
        }
        if (!hasSpaceOrLowercase) return false;
        // Reject obvious file paths or class names.
        if (s.contains(".cpp") || s.contains(".h") || s.contains(".dll")) return false;
        if (s.contains("(") || s.contains(")")) return false;
        // Reject all-caps macro-style strings.
        if (s.equals(s.toUpperCase())) return false;
        return true;
    }
}
