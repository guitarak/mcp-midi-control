// MineAxeEditIIIEnvelopeEmitters.java — Ghidra GhidraScript
//
// AxeEdit III hardcodes each SysEx fn-byte INLINE in its emitter
// function, not via a dispatcher table. From the v2 trace:
//
//     local_48 = 0x740100f0;    // F0 00 01 74  (envelope constant)
//     local_44 = *(...)+0x30;   // model byte from device-handle struct
//     local_43 = 0x77;          // fn byte hardcoded
//
// Each builder is a separate function and hardcodes its fn byte.
//
// This script:
//   1. Walks every instruction in the III binary looking for the 4-byte
//      immediate constant 0x740100F0 (the envelope LE word).
//   2. For each hit, locates the containing function.
//   3. Within that function, scans subsequent instructions for byte-
//      immediate stores to stack offsets sequentially after the envelope
//      slot — the fn byte is the FIRST byte-store after the model-byte
//      slot (or any 0x00..0x7F immediate inside ~16 instructions of the
//      envelope-constant store).
//   4. Outputs a table of (function-addr, fn_byte_candidates) for the
//      operator to compare against the 23 SYSEX_* name pool.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-envelope-emitters.txt
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
import java.util.*;

public class MineAxeEditIIIEnvelopeEmitters extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-envelope-emitters.txt";

    // The Fractal envelope as a 32-bit little-endian constant:
    //   F0 00 01 74  ->  0x740100F0
    private static final long ENVELOPE_LE32 = 0x740100F0L;

    // Window for scanning byte-immediates after the envelope-constant store.
    private static final int LOOKAHEAD_INSTRS = 24;

    private final List<String> lines = new ArrayList<>();
    private DecompInterface decomp;

    private void w(String s) {
        lines.add(s);
        println(s);
    }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        Listing listing = program.getListing();
        FunctionManager funcMgr = program.getFunctionManager();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        w("================================================================================");
        w("MineAxeEditIIIEnvelopeEmitters.java");
        w("  Program:    " + program.getName());
        w("  Output:     " + OUTPUT_PATH);
        w("================================================================================");
        w("");
        w("Searching for MOV-immediate of 0x740100F0 (envelope F0 00 01 74)...");
        w("");

        // ── Pass 1: collect every instruction with immediate operand 0x740100F0 ──
        Map<Address, List<Instruction>> emitterToInstrs = new LinkedHashMap<>();
        InstructionIterator it = listing.getInstructions(true);
        int scanned = 0;
        int hits = 0;
        while (it.hasNext()) {
            Instruction ins = it.next();
            scanned++;
            boolean matched = false;
            for (int op = 0; op < ins.getNumOperands(); op++) {
                Object[] objs = ins.getOpObjects(op);
                for (Object o : objs) {
                    if (o instanceof Scalar) {
                        long v = ((Scalar) o).getUnsignedValue();
                        if (v == ENVELOPE_LE32) { matched = true; break; }
                    }
                }
                if (matched) break;
            }
            if (!matched) continue;

            Function f = funcMgr.getFunctionContaining(ins.getAddress());
            if (f == null) continue;
            hits++;

            // Collect this instruction + N subsequent in-function instructions.
            List<Instruction> seq = new ArrayList<>();
            seq.add(ins);
            Instruction next = ins;
            for (int i = 0; i < LOOKAHEAD_INSTRS; i++) {
                next = listing.getInstructionAfter(next.getAddress());
                if (next == null) break;
                if (!f.getBody().contains(next.getAddress())) break;
                seq.add(next);
            }
            emitterToInstrs.computeIfAbsent(f.getEntryPoint(), k -> new ArrayList<>()).addAll(seq);
        }

        w("Instructions scanned: " + scanned);
        w("0x740100F0 immediate matches: " + hits);
        w("Distinct emitter functions: " + emitterToInstrs.size());
        w("");

        // ── Pass 2: for each emitter, extract byte-immediate candidates ──
        // The fn byte sits in `local_43`, immediately after `local_44` (model
        // byte) which is the result of an indirect load — NOT an immediate.
        // So we report all byte-immediate stores in the window. The operator
        // cross-references against captures / wire knowledge to disambiguate.
        for (var entry : emitterToInstrs.entrySet()) {
            Address fa = entry.getKey();
            Function f = funcMgr.getFunctionAt(fa);
            if (f == null) continue;

            // Deduplicate instructions for this function.
            LinkedHashSet<Instruction> unique = new LinkedHashSet<>(entry.getValue());

            // Collect byte-store immediates in the window. We look for
            // any small immediate <= 0xFF that the function uses as an
            // operand value somewhere after the envelope hit.
            Map<Long, Integer> byteImms = new LinkedHashMap<>();
            for (Instruction ins : unique) {
                for (int op = 0; op < ins.getNumOperands(); op++) {
                    for (Object o : ins.getOpObjects(op)) {
                        if (o instanceof Scalar) {
                            long v = ((Scalar) o).getUnsignedValue();
                            if (v == ENVELOPE_LE32) continue;       // skip envelope itself
                            if (v == 0xF7) continue;                // SysEx end byte — noise
                            if (v == 0x10) continue;                // model byte — noise
                            if (v == 0) continue;
                            if (v == 1) continue;
                            if (v == 2) continue;
                            if (v > 0x7F) continue;
                            byteImms.merge(v, 1, Integer::sum);
                        }
                    }
                }
            }

            w("################################################################################");
            w("## EMITTER: " + f.getName() + " @ " + fa + "  (window: " + unique.size() + " instrs)");
            w("################################################################################");
            w("  Byte-immediate candidates (1..0x7F, excl envelope/model/F7):");
            byteImms.entrySet().stream()
                .sorted((a, b) -> Integer.compare(b.getValue(), a.getValue()))
                .forEachOrdered(e -> w(String.format("    0x%02X  count=%d", e.getKey(), e.getValue())));
            w("");
            w("  Window instructions:");
            for (Instruction ins : unique) {
                w(String.format("    %s  %s", ins.getAddress(), ins.toString()));
            }
            w("");
        }

        // ── Pass 3: decompile each emitter so the fn byte can be read directly ──
        w("################################################################################");
        w("## DECOMPILED EMITTER BODIES");
        w("################################################################################");
        w("");
        for (Address fa : emitterToInstrs.keySet()) {
            Function f = funcMgr.getFunctionAt(fa);
            if (f == null) continue;
            w("--- " + f.getName() + " @ " + fa + " ---");
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
}
