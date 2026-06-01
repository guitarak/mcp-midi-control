// DumpAxeEditIIIPresetReceiver.java — Ghidra GhidraScript
//
// Find AxeEdit III's PATCH_DUMP RECEIVER — the function that parses
// incoming 0x77/0x78/0x79 frames from the Axe-Fx III.
//
// On AxeEdit II we found FUN_00512f30 dispatching on fn-byte 'w'/'x'/'y'
// (0x77/0x78/0x79) to per-frame parsers. We expect the III to have an
// analogous dispatcher. Strategy:
//
//   1. Walk every instruction, finding immediates equal to 0x77, 0x78,
//      0x79 (the wire fn bytes the device sends back).
//   2. Rank functions by how many of those three immediates they touch.
//      A receiver dispatcher will have exactly 0x77 + 0x78 + 0x79 hits.
//   3. Cross-rank by proximity to 0x10 (model byte) immediates — confirms
//      the function operates on Fractal SysEx frames.
//   4. Decompile the top candidates + first-level callees.
//
// Bonus: scan for Huffman compression markers — common signatures like
// the 256-entry decompression LUT used by Forum #159885 community RE's
// claim that III uses Huffman on preset binaries.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-preset-receiver.txt
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
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.RefType;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class DumpAxeEditIIIPresetReceiver extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-preset-receiver.txt";

    private static final int MAX_DECOMPILE = 12;

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;
    private FunctionManager funcMgr;
    private Listing listing;
    private final Set<Address> seen = new HashSet<>();

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        listing = program.getListing();
        funcMgr = program.getFunctionManager();
        Memory mem = program.getMemory();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("DumpAxeEditIIIPresetReceiver.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        // ── Pass 1: per-function immediate hit counts ────────────────
        // We track immediates 0x77, 0x78, 0x79 (the fn bytes) and
        // 'w'=0x77 / 'x'=0x78 / 'y'=0x79 chars (same value-space; II
        // used these directly as char literals).
        // Also track 0x10 (III model byte), 0x07 (II model byte for
        // sanity), 0xF0 (SysEx start), 0xF7 (SysEx end), 0x64 (ACK fn).
        long[] FN_BYTES = { 0x77, 0x78, 0x79 };
        long[] MODEL_BYTES = { 0x10 };
        long[] SYSEX_MARKERS = { 0xF0, 0xF7 };
        long[] ACK_BYTES = { 0x64 };

        Map<Address, int[]> hitsByFunc = new HashMap<>();
        // [0..2] = 0x77/0x78/0x79; [3] = model; [4] = sysex_markers; [5] = ack
        InstructionIterator it = listing.getInstructions(true);
        int insScanned = 0;
        while (it.hasNext()) {
            Instruction ins = it.next();
            insScanned++;
            Function f = funcMgr.getFunctionContaining(ins.getAddress());
            if (f == null) continue;
            int[] bucket = hitsByFunc.computeIfAbsent(f.getEntryPoint(), k -> new int[6]);
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    if (!(o instanceof Scalar)) continue;
                    long v = ((Scalar) o).getUnsignedValue();
                    for (int i = 0; i < FN_BYTES.length; i++)
                        if (v == FN_BYTES[i]) bucket[i]++;
                    for (long m : MODEL_BYTES) if (v == m) bucket[3]++;
                    for (long m : SYSEX_MARKERS) if (v == m) bucket[4]++;
                    for (long m : ACK_BYTES) if (v == m) bucket[5]++;
                }
            }
        }
        w("Scanned " + insScanned + " instructions in " + hitsByFunc.size() + " functions.");
        w("");

        // ── Rank by sum of (0x77, 0x78, 0x79) hits ───────────────────
        // A receiver dispatcher should have hits in ALL THREE.
        List<Map.Entry<Address, int[]>> ranked = new ArrayList<>(hitsByFunc.entrySet());
        ranked.sort((a, b) -> {
            int sa = a.getValue()[0] + a.getValue()[1] + a.getValue()[2];
            int sb = b.getValue()[0] + b.getValue()[1] + b.getValue()[2];
            // Bonus for having ALL THREE non-zero (dispatcher pattern)
            int triA = (a.getValue()[0] > 0 ? 100 : 0)
                     + (a.getValue()[1] > 0 ? 100 : 0)
                     + (a.getValue()[2] > 0 ? 100 : 0);
            int triB = (b.getValue()[0] > 0 ? 100 : 0)
                     + (b.getValue()[1] > 0 ? 100 : 0)
                     + (b.getValue()[2] > 0 ? 100 : 0);
            return Integer.compare(sb + triB, sa + triA);
        });

        w("################################################################################");
        w("## TOP 30 — functions with 0x77/0x78/0x79 immediates");
        w("################################################################################");
        w("  rank | func @ entry             | x77 | x78 | x79 | x10 | F0/F7 | x64");
        w("  -----+--------------------------+-----+-----+-----+-----+-------+-----");
        Set<Address> tripleHits = new LinkedHashSet<>();
        for (int i = 0; i < Math.min(30, ranked.size()); i++) {
            var e = ranked.get(i);
            int[] b = e.getValue();
            Function f = funcMgr.getFunctionAt(e.getKey());
            String fname = f == null ? "?" : f.getName();
            w(String.format("  %4d | %-24s | %3d | %3d | %3d | %3d | %5d | %3d",
                i + 1, fname + " @ " + e.getKey(), b[0], b[1], b[2], b[3], b[4], b[5]));
            // Tripple hit = candidate dispatcher
            if (b[0] > 0 && b[1] > 0 && b[2] > 0) tripleHits.add(e.getKey());
        }
        w("");
        w("Candidates with hits on ALL of 0x77/0x78/0x79 (dispatcher pattern): "
            + tripleHits.size());
        w("");

        // ── Pass 2: decompile top candidates ─────────────────────────
        w("################################################################################");
        w("## DECOMPILED TOP DISPATCHER CANDIDATES");
        w("################################################################################");
        w("");

        Set<Address> toDump = new LinkedHashSet<>(tripleHits);
        // Fill up to MAX_DECOMPILE with the next-best functions.
        for (var e : ranked) {
            if (toDump.size() >= MAX_DECOMPILE) break;
            toDump.add(e.getKey());
        }

        for (Address fa : toDump) {
            if (toDump.size() > MAX_DECOMPILE && !tripleHits.contains(fa)) continue;
            Function f = funcMgr.getFunctionAt(fa);
            if (f == null) continue;
            int[] b = hitsByFunc.get(fa);
            w("--- " + f.getName() + " @ " + fa
                + "  [0x77=" + b[0] + ", 0x78=" + b[1] + ", 0x79=" + b[2]
                + ", 0x10=" + b[3] + ", F0/F7=" + b[4] + ", 0x64=" + b[5] + "] ---");
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

        // ── Pass 3: Huffman-table search ─────────────────────────────
        // A classic Huffman decode LUT is a 256-entry table where each
        // entry is either a 16-bit { code_length, symbol } pair or a
        // small fixed-size struct. Common Fractal-relevant Huffman
        // signature: 0x100 contiguous entries each in a 4-byte stride.
        // We scan .rdata for runs of 256 entries with similar shape.
        w("################################################################################");
        w("## HUFFMAN / LZ DECOMPRESSION TABLE SCAN");
        w("################################################################################");
        w("  Looking for 256-entry tables (4- or 8-byte stride) with");
        w("  ascending symbol values — a typical Huffman code table shape.");
        w("");
        scanForHuffmanTables(mem);

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private void scanForHuffmanTables(Memory mem) throws Exception {
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized()) continue;
            if (block.isExecute()) continue;
            long start = block.getStart().getOffset();
            long end = block.getEnd().getOffset();
            int len = (int) Math.min(end - start + 1, 0x40000000);
            byte[] buf = new byte[len];
            try { mem.getBytes(block.getStart(), buf, 0, len); }
            catch (Exception ignored) { continue; }

            // Walk 4-byte aligned offsets. At each offset, check if the
            // next 256 × 4-byte slots look like a "code length, symbol"
            // pattern: low byte is the symbol (0..255), high bytes encode
            // length or freq. Heuristic: in a 256-entry table covering
            // symbols 0..255, each symbol's index should appear exactly
            // once in the low byte across the table.
            int hits = 0;
            for (int off = 0; off + 256 * 4 <= len && hits < 10; off += 4) {
                Set<Integer> lowBytes = new HashSet<>();
                boolean monotonic = true;
                int prevSym = -1;
                for (int i = 0; i < 256; i++) {
                    int sym = buf[off + i * 4] & 0xff;
                    lowBytes.add(sym);
                    if (sym < prevSym) monotonic = false;
                    prevSym = sym;
                }
                // A true symbol-permutation table will have all 256
                // distinct low-bytes. Don't insist on monotonic since
                // Huffman tables can be reordered by code length.
                if (lowBytes.size() == 256) {
                    w(String.format("  Candidate @ 0x%08x  stride=4  monotonic=%s",
                        start + off, monotonic));
                    hits++;
                }
            }
            if (hits == 0) {
                w("  Block " + block.getName() + " @ 0x" + Long.toHexString(start)
                    + ": no 256-entry symbol-permutation tables found.");
            }
        }
    }
}
