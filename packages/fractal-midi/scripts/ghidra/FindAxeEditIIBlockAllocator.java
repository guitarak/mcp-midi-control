// FindAxeEditIIBlockAllocator.java — Ghidra GhidraScript
//
// BK-070 Session 116 — hunting for the function that maps placed blocks
// to (chunk, ushort) positions in the 12,951-byte preset binary.
//
// What we know:
//   - FUN_00512f30 is the PATCH_DUMP envelope dispatcher (handles 0x77/
//     0x78/0x79 messages, validates hash via FUN_00544cc0, accumulates
//     decoded ushorts into a growing buffer at param_1+0x1c).
//   - FUN_0054d0c0 parses one chunk's payload into native ushorts.
//   - FUN_0054d1d0 parses the footer payload, stores expected hash at
//     param_1+0x5c.
//   - FUN_0054d3d0 parses the header payload (bank/preset/expected
//     count) into param_1+0x48/+0x4a/+0x4c.
//   - FUN_00544cc0 is the XOR-fold hash.
//   - FUN_00620810 appends decoded ushorts to the growing buffer
//     (signature: void(growing_buf_handle, source_buf_handle)).
//   - Each preset binary's per-block paramBase is LAYOUT-DEPENDENT
//     (Session 116). The allocation algorithm is hidden in the parser/
//     encoder chain — most likely a function that, given a placed-block
//     list, computes per-block (chunk, ushort) bases or sequentially
//     packs each block's params into chunks.
//
// What this script does:
//   (1) Walk callers of FUN_00512f30 — find who CONSUMES the parsed
//       flat ushort buffer.
//   (2) Walk callers of FUN_00620810 — find who APPENDS ushorts on the
//       parse side; and on the encoder side, the inverse who emits to
//       0x78 chunks.
//   (3) Walk callers of FUN_00544cc0 (hash) — both verify (parser) and
//       compute (encoder).
//   (4) For each found caller, decompile and dump.
//   (5) Also: rank ALL functions by how many distinct block-id
//       immediates (100..160) they touch, on the theory that the
//       allocator function references the block-id range to look up
//       per-type sizes.
//
// Output: samples/captured/decoded/ghidra-axe-edit-block-allocator.txt
//
// @category AxeFxII

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
import ghidra.program.model.symbol.ReferenceManager;
import ghidra.program.model.symbol.ReferenceIterator;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class FindAxeEditIIBlockAllocator extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-block-allocator.txt";

    // Functions whose callers we want to inspect.
    private static final long[] SEED_FUNCS = {
        0x00512f30L,  // PATCH_DUMP envelope dispatcher
        0x0054d0c0L,  // chunk-payload parser
        0x0054d1d0L,  // footer-payload parser
        0x0054d3d0L,  // header-payload parser
        0x00544cc0L,  // XOR-fold hash
        0x00620810L,  // ushort-append (growing buffer)
    };

    // Block-id range from AXE_FX_II_BLOCKS (100..164 covers all placeable
    // blocks plus a margin).
    private static final int BLOCK_ID_MIN = 100;
    private static final int BLOCK_ID_MAX = 164;

    private static final int MAX_DECOMPILE_PER_LIST = 6;

    private final List<String> lines = new ArrayList<>();

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        Listing listing = program.getListing();
        FunctionManager funcMgr = program.getFunctionManager();
        ReferenceManager refMgr = program.getReferenceManager();
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("FindAxeEditIIBlockAllocator.java — hunting block→chunk allocator");
        w("  Program:    " + program.getName());
        w("  Output:     " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Section A — Caller graph for each seed function ──────────
        for (long seed : SEED_FUNCS) {
            Address seedAddr = program.getAddressFactory().getDefaultAddressSpace().getAddress(seed);
            Function seedFunc = funcMgr.getFunctionAt(seedAddr);
            String seedName = seedFunc == null ? "(no func)" : seedFunc.getName();
            w("################################################################################");
            w("## Callers of " + seedName + " @ " + seedAddr);
            w("################################################################################");

            Set<Address> callerEntries = new TreeSet<>();
            ReferenceIterator it = refMgr.getReferencesTo(seedAddr);
            while (it.hasNext()) {
                Reference r = it.next();
                Address callSite = r.getFromAddress();
                Function caller = funcMgr.getFunctionContaining(callSite);
                if (caller == null) continue;
                callerEntries.add(caller.getEntryPoint());
            }
            w("  Distinct callers: " + callerEntries.size());
            int i = 0;
            for (Address ce : callerEntries) {
                Function f = funcMgr.getFunctionAt(ce);
                w(String.format("    %2d. %s @ %s", ++i, f.getName(), ce));
            }
            w("");

            // Decompile up to MAX_DECOMPILE_PER_LIST callers.
            w("--- Decompiled callers ---");
            int j = 0;
            for (Address ce : callerEntries) {
                if (j++ >= MAX_DECOMPILE_PER_LIST) break;
                Function f = funcMgr.getFunctionAt(ce);
                w("--- caller " + j + ": " + f.getName() + " @ " + ce + " ---");
                DecompileResults rr = decomp.decompileFunction(f, 90, monitor);
                if (!rr.decompileCompleted()) {
                    w("  // decompile failed: " + rr.getErrorMessage());
                    continue;
                }
                DecompiledFunction dc = rr.getDecompiledFunction();
                String body = dc == null ? "// (no body)" : dc.getC();
                for (String l : body.split("\n")) w("  " + l);
                w("");
            }
            w("");
        }

        // ── Section B — Block-id immediate scan ──────────────────────
        // Rank functions by how many distinct block_id values they
        // reference. The allocator should touch many (it walks the
        // placed-block list and looks up per-block sizes).
        w("################################################################################");
        w("## SECTION B — Functions ranked by distinct block-id immediates (100..164)");
        w("################################################################################");

        Map<Address, Set<Long>> funcToBlockIds = new HashMap<>();
        InstructionIterator instIt = listing.getInstructions(true);
        int scanned = 0;
        while (instIt.hasNext()) {
            Instruction ins = instIt.next();
            scanned++;
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    if (!(o instanceof Scalar)) continue;
                    long v = ((Scalar) o).getUnsignedValue();
                    if (v < BLOCK_ID_MIN || v > BLOCK_ID_MAX) continue;
                    Function f = funcMgr.getFunctionContaining(ins.getAddress());
                    if (f == null) continue;
                    funcToBlockIds
                        .computeIfAbsent(f.getEntryPoint(), k -> new TreeSet<>())
                        .add(v);
                }
            }
        }
        w("  Instructions scanned: " + scanned);
        w("  Functions touching block-id range: " + funcToBlockIds.size());
        w("");

        List<Map.Entry<Address, Set<Long>>> ranked = new ArrayList<>(funcToBlockIds.entrySet());
        ranked.sort((a, b) -> Integer.compare(b.getValue().size(), a.getValue().size()));
        w("--- TOP 30 by # distinct block-ids ---");
        for (int k = 0; k < Math.min(30, ranked.size()); k++) {
            var e = ranked.get(k);
            Function f = funcMgr.getFunctionAt(e.getKey());
            String fname = f == null ? "(no func)" : f.getName();
            String idList = e.getValue().toString();
            w(String.format("  %3d. %-20s @ %s  count=%d  ids=%s",
                k + 1, fname, e.getKey(), e.getValue().size(),
                idList.length() > 80 ? idList.substring(0, 77) + "..." : idList));
        }
        w("");

        // Decompile top 8 — these are the strongest "block-aware"
        // function candidates.
        w("--- DECOMPILED TOP 8 (block-id rich) ---");
        for (int k = 0; k < Math.min(8, ranked.size()); k++) {
            var e = ranked.get(k);
            Function f = funcMgr.getFunctionAt(e.getKey());
            if (f == null) continue;
            w("--- block-id-rich " + (k + 1) + ": " + f.getName() + " @ " + e.getKey()
                + "  ids=" + e.getValue() + " ---");
            DecompileResults rr = decomp.decompileFunction(f, 90, monitor);
            if (!rr.decompileCompleted()) {
                w("  // decompile failed: " + rr.getErrorMessage());
                continue;
            }
            DecompiledFunction dc = rr.getDecompiledFunction();
            String body = dc == null ? "// (no body)" : dc.getC();
            for (String l : body.split("\n")) w("  " + l);
            w("");
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }
}
