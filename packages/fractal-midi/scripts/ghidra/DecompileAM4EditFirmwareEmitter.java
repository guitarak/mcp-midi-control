// DecompileAM4EditFirmwareEmitter.java - Ghidra GhidraScript
//
// HOP 4 Phase 1.5 step 2: decompile the firmware-emitter candidates
// identified by ProbeAM4EditFractalBot. Only 2 functions in
// AM4-Edit.exe (out of 16,940) carry both 0xF0 (SysEx start) AND 0x7E
// (firmware chunk fn-byte):
//
//   FUN_1401bf340 — also the xref target of the "Firmware" string
//                   constant at .rdata 1405da800; PRIMARY candidate.
//   FUN_1404d2a10 — no Firmware-string xref but carries all four
//                   firmware fn-bytes 0x7D/0x7E/0x7F + 0xF0.
//
// Plus the two functions that own the "Fractal-Bot" / "FractalBot"
// string xrefs (likely UI/menu emitters but worth a look):
//
//   FUN_14014c9d0 — xref target for both "Fractal-Bot" + "fractal-bot"
//                   strings (probably a menu/label registration).
//   FUN_140243d80 — xref target for "FractalBot" string.
//
// And two more from the "Firmware" string xref set:
//
//   FUN_1401bd880 — Firmware xref @ 1405dad38.
//   FUN_1401dbfb0 — Firmware xref @ 1405dda00.
//
// Plus the FIRMWARE-uppercase xref:
//
//   FUN_14014b1b0 — FIRMWARE xref @ 1405560c8.
//
// Output:
//   %PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded\
//     ghidra-am4-edit-firmware-emitter-decompile.txt
//
// @category AM4

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Program;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class DecompileAM4EditFirmwareEmitter extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-firmware-emitter-decompile.txt";

    private static final long[] CANDIDATES = {
        0x1401bf340L,  // Firmware string + 0xF0/0x7E both present (PRIMARY)
        0x1404d2a10L,  // 0xF0 + 0x7D/0x7E/0x7F all present
        0x14014c9d0L,  // Fractal-Bot string xref
        0x140243d80L,  // FractalBot string xref
        0x1401bd880L,  // Firmware string xref
        0x1401dbfb0L,  // Firmware string xref
        0x14014b1b0L,  // FIRMWARE string xref
    };

    @Override
    public void run() throws Exception {
        PrintWriter out = new PrintWriter(new FileWriter(OUTPUT_PATH));
        try {
            Program program = currentProgram;
            FunctionManager fm = program.getFunctionManager();
            DecompInterface decomp = new DecompInterface();
            decomp.openProgram(program);

            println("================================================================================");
            println("DecompileAM4EditFirmwareEmitter");
            println("  Program:  " + program.getName());
            println("  Output:   " + OUTPUT_PATH);
            println("================================================================================");

            out.println("================================================================================");
            out.println("DecompileAM4EditFirmwareEmitter");
            out.println("  Program:  " + program.getName());
            out.println("  Image base: 0x" + Long.toHexString(program.getImageBase().getOffset()));
            out.println("================================================================================");
            out.println();

            for (long off : CANDIDATES) {
                Address addr = toAddr(off);
                Function f = fm.getFunctionAt(addr);
                if (f == null) f = fm.getFunctionContaining(addr);
                out.println("================================================================================");
                if (f == null) {
                    out.println("## NO FUNCTION at @ 0x" + Long.toHexString(off));
                    out.println("================================================================================");
                    out.println();
                    continue;
                }
                out.println("## " + f.getName() + " @ " + f.getEntryPoint() +
                    "  body=" + f.getBody().getNumAddresses() + " addresses");
                out.println("================================================================================");
                DecompileResults res = decomp.decompileFunction(f, 90, monitor);
                if (!res.decompileCompleted()) {
                    out.println("(decompile failed: " + res.getErrorMessage() + ")");
                    out.println();
                    continue;
                }
                DecompiledFunction dec = res.getDecompiledFunction();
                String code = dec.getC();
                String[] lines = code.split("\n");
                int cap = Math.min(lines.length, 600);
                for (int i = 0; i < cap; i++) {
                    out.println(lines[i]);
                }
                if (lines.length > cap) {
                    out.println("// ... (" + (lines.length - cap) + " more lines truncated)");
                }
                out.println();
            }

            decomp.dispose();

            out.println("================================================================================");
            out.println("DONE");
            out.println("================================================================================");
        } finally {
            out.close();
        }
    }
}
