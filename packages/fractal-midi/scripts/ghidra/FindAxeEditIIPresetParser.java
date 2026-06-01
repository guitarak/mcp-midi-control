// FindAxeEditIIPresetParser.java — Ghidra GhidraScript
//
// AxeEdit II (32-bit Axe-Edit.exe) emits and receives the PATCH_DUMP
// envelope at fn 0x77 (PATCH_START) / 0x78 (PATCH_DATA) / 0x79 (PATCH_END).
// Total payload = 12,951 bytes (66 messages, 4-byte header + 64 chunks
// of 194 bytes + 3-byte footer).
//
// For BK-070 (per-scene byte offsets), we need the function that
// PARSES the 12,951-byte preset binary into the editor's internal
// per-scene state representation. That parser will contain explicit
// byte-offset accesses like `state->scene[N].amp_channel = buf[OFFSET];`
//
// This script:
//   1. Finds every function containing the magic immediates that the
//      parser would use:
//        - 0x77 / 0x78 / 0x79 (fn bytes)
//        - 12951 / 0x3297 (total payload length)
//        - 194 / 0xC2 (chunk size)
//        - 64 / 0x40 (chunk count)
//   2. Ranks by # of magic-immediate hits per function.
//   3. Decompiles the top 30.
//
// Output: samples/captured/decoded/ghidra-axe-edit-preset-parser.txt
//
// @category AxeFxII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.scalar.Scalar;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class FindAxeEditIIPresetParser extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-preset-parser.txt";

    private static final long[] MAGIC_IMMS = {
        0x77,    // PATCH_START fn byte
        0x78,    // PATCH_DATA fn byte
        0x79,    // PATCH_END fn byte
        12951,   // total preset binary size
        194,     // chunk payload size
        64,      // chunk count
        0x3297,  // 12951 in hex
        0xC2,    // 194 in hex
    };

    private static final int MAX_DECOMPILE = 20;

    private final List<String> lines = new ArrayList<>();

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        Listing listing = program.getListing();
        FunctionManager funcMgr = program.getFunctionManager();
        DecompInterface decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("FindAxeEditIIPresetParser.java");
        w("  Program:    " + program.getName());
        w("  Output:     " + OUTPUT_PATH);
        w("  Magic imms: " + Arrays.toString(MAGIC_IMMS));
        w("================================================================================");
        w("");

        // ── Walk every instruction, tally immediate hits per function ──
        Map<Address, Map<Long, Integer>> funcToImms = new HashMap<>();
        Set<Long> immSet = new HashSet<>();
        for (long v : MAGIC_IMMS) immSet.add(v);

        InstructionIterator it = listing.getInstructions(true);
        int scanned = 0;
        while (it.hasNext()) {
            Instruction ins = it.next();
            scanned++;
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    if (!(o instanceof Scalar)) continue;
                    long v = ((Scalar) o).getUnsignedValue();
                    if (!immSet.contains(v)) continue;
                    Function f = funcMgr.getFunctionContaining(ins.getAddress());
                    if (f == null) continue;
                    funcToImms
                        .computeIfAbsent(f.getEntryPoint(), k -> new HashMap<>())
                        .merge(v, 1, Integer::sum);
                }
            }
        }
        w("Instructions scanned: " + scanned);
        w("Functions touching magic immediates: " + funcToImms.size());
        w("");

        // ── Score each function (weight rare immediates higher) ──────
        // Common values (0x77 / 0x78 / 0x79 / 0x40 / 0xC2) appear in
        // many unrelated contexts. Rare values (12951 / 0x3297) are
        // strong evidence.
        Map<Long, Integer> immWeight = new HashMap<>();
        immWeight.put(0x77L, 1);
        immWeight.put(0x78L, 1);
        immWeight.put(0x79L, 1);
        immWeight.put(12951L, 100);
        immWeight.put(0x3297L, 100);
        immWeight.put(194L, 10);
        immWeight.put(64L, 1);
        immWeight.put(0xC2L, 10);

        Map<Address, Integer> funcScores = new HashMap<>();
        for (var e : funcToImms.entrySet()) {
            int score = 0;
            for (var ie : e.getValue().entrySet()) {
                score += immWeight.getOrDefault(ie.getKey(), 0) * ie.getValue();
                // Bonus for having multiple distinct magic immediates.
            }
            score += e.getValue().size() * 5;
            funcScores.put(e.getKey(), score);
        }

        // Sort and dump top 50
        List<Map.Entry<Address, Integer>> ranked = new ArrayList<>(funcScores.entrySet());
        ranked.sort((a, b) -> Integer.compare(b.getValue(), a.getValue()));

        w("################################################################################");
        w("## TOP 50 — functions ranked by magic-immediate score");
        w("################################################################################");
        w("");
        for (int i = 0; i < Math.min(50, ranked.size()); i++) {
            var e = ranked.get(i);
            Function f = funcMgr.getFunctionAt(e.getKey());
            String fname = f == null ? "(no func)" : f.getName();
            Map<Long, Integer> imms = funcToImms.get(e.getKey());
            String immDesc = imms.entrySet().stream()
                .map(x -> String.format("%s=%d", hexImm(x.getKey()), x.getValue()))
                .reduce((a, b) -> a + ", " + b).orElse("");
            w(String.format("  %3d. score=%-6d  %s @ %s  [%s]",
                i + 1, e.getValue(), fname, e.getKey(), immDesc));
        }
        w("");

        // ── Decompile top N ──────────────────────────────────────────
        w("################################################################################");
        w("## DECOMPILED TOP " + MAX_DECOMPILE);
        w("################################################################################");
        w("");
        for (int i = 0; i < Math.min(MAX_DECOMPILE, ranked.size()); i++) {
            var e = ranked.get(i);
            Function f = funcMgr.getFunctionAt(e.getKey());
            if (f == null) continue;
            Map<Long, Integer> imms = funcToImms.get(e.getKey());
            String immDesc = imms.entrySet().stream()
                .map(x -> String.format("%s=%d", hexImm(x.getKey()), x.getValue()))
                .reduce((a, b) -> a + ", " + b).orElse("");
            w("--- #" + (i + 1) + ": " + f.getName() + " @ " + e.getKey()
                + "  score=" + e.getValue() + "  imms=[" + immDesc + "] ---");
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

    private String hexImm(long v) { return "0x" + Long.toHexString(v); }
}
