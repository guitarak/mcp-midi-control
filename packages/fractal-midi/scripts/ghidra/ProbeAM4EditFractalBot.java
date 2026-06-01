// ProbeAM4EditFractalBot.java - Ghidra GhidraScript
//
// Quick probe: is Fractal-Bot integrated into AM4-Edit.exe, or is it
// a separate tool launched externally?
//
// The previous FindAM4EditFirmwareEmitter run found ZERO occurrences
// of:
//   - the firmware header payload constant `00 60 73 35 01`
//   - the SysEx envelope prefix `F0 00 01 74 15 7E` (chunk emitter)
//   - the SysEx envelope prefix `F0 00 01 74 15 7D` (header emitter)
//
// And 3 of 4 mined "SysEx builder" candidates have ZERO references.
//
// This script tests three hypotheses about where the firmware emitter
// lives:
//
//   H1: Fractal-Bot is integrated as a JUCE component inside
//       AM4-Edit.exe. Evidence would be string references to
//       "Fractal-Bot" / "FractalBot" / "firmware" / "Update Firmware"
//       in .rdata, with xrefs to a function that builds fn=0x7D/0x7E/0x7F
//       envelopes.
//   H2: AM4-Edit shell-launches a separate Fractal-Bot.exe. Evidence
//       would be string references to "Fractal-Bot.exe" or similar
//       and a CreateProcess / ShellExecute call site.
//   H3: AM4-Edit launches Fractal-Bot via URL (download / web link).
//       Evidence: "https://" + "fractal" + "bot" string clusters and
//       ShellExecute-with-URL call sites.
//
// Output:
//   %PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded\
//     ghidra-am4-edit-fractal-bot-probe.txt
//
// @category AM4

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSetView;
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

public class ProbeAM4EditFractalBot extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-fractal-bot-probe.txt";

    private static final String[] SEARCH_STRINGS = {
        "Fractal-Bot",
        "FractalBot",
        "Fractal Bot",
        "fractal-bot",
        "fractalbot",
        "Firmware",
        "firmware",
        "FIRMWARE",
        "Update Firmware",
        "Send to Device",
        "Fractal Audio",
        "fractalaudio.com",
        ".syx",
        "AM4_firmware",
        "firmware-update",
        "fractal-presets",
        "Tools menu",
        "ShellExecute",
    };

    @Override
    public void run() throws Exception {
        PrintWriter out = new PrintWriter(new FileWriter(OUTPUT_PATH));
        try {
            Program program = currentProgram;
            Memory memory = program.getMemory();
            Listing listing = program.getListing();
            ReferenceManager refMgr = program.getReferenceManager();
            FunctionManager funcMgr = program.getFunctionManager();

            print("================================================================================");
            println("ProbeAM4EditFractalBot");
            println("  Program:  " + program.getName());
            println("  Output:   " + OUTPUT_PATH);
            println("================================================================================");

            out.println("================================================================================");
            out.println("ProbeAM4EditFractalBot");
            out.println("  Program:  " + program.getName());
            out.println("  Image base: 0x" + Long.toHexString(program.getImageBase().getOffset()));
            out.println("================================================================================");
            out.println();

            // ----- Section 1: search for indicative strings -----
            out.println("################################################################################");
            out.println("## STRING SEARCH — Fractal-Bot / firmware vocabulary");
            out.println("################################################################################");
            out.println();
            for (String needle : SEARCH_STRINGS) {
                byte[] pattern = needle.getBytes(StandardCharsets.US_ASCII);
                List<Address> hits = scanMemoryForBytes(memory, pattern);
                if (hits.isEmpty()) {
                    out.println("[" + String.format("%-20s", '"' + needle + '"') + "]  no hits");
                    continue;
                }
                out.println("[" + String.format("%-20s", '"' + needle + '"') + "]  hits=" + hits.size());
                int shown = 0;
                for (Address a : hits) {
                    if (shown++ >= 5) {
                        out.println("    ... (" + (hits.size() - shown + 1) + " more)");
                        break;
                    }
                    MemoryBlock blk = memory.getBlock(a);
                    out.println("    @ " + a + "  block=" + (blk != null ? blk.getName() : "?"));
                    int refCount = 0;
                    for (Reference r : refMgr.getReferencesTo(a)) refCount++;
                    out.println("      xrefs: " + refCount);
                    int xshown = 0;
                    for (Reference r : refMgr.getReferencesTo(a)) {
                        if (xshown++ >= 3) {
                            out.println("        ... (" + (refCount - xshown + 1) + " more)");
                            break;
                        }
                        Address from = r.getFromAddress();
                        Function c = funcMgr.getFunctionContaining(from);
                        out.println("        from " + from + (c != null ?
                            "  in " + c.getName() + " @ " + c.getEntryPoint() : ""));
                    }
                }
                out.println();
            }

            // ----- Section 2: look for the .syx file extension constant in
            //                  vicinity of a file-dialog OR a memory-write
            out.println("################################################################################");
            out.println("## SECTION 2: Wide-area scan for the byte sequence 0x7E used as an");
            out.println("## SysEx fn-byte. We count instructions in the entire binary that have");
            out.println("## immediate 0x7E AND immediate 0xF0 within a 32-instruction window.");
            out.println("################################################################################");
            out.println();
            int candidateCount = 0;
            // For each function, scan: does the body contain both 0xF0 and
            // 0x7E in close proximity (suggesting a byte-by-byte SysEx
            // envelope build)?
            int totalFuncs = 0;
            int funcsWith7e = 0;
            int funcsWithF0 = 0;
            int funcsWithBoth = 0;
            for (Function f : funcMgr.getFunctions(true)) {
                totalFuncs++;
                boolean has7e = false, hasF0 = false, has7d = false, has7f = false;
                ghidra.program.model.listing.InstructionIterator iter =
                    listing.getInstructions(f.getBody(), true);
                while (iter.hasNext()) {
                    ghidra.program.model.listing.Instruction insn = iter.next();
                    for (int op = 0; op < insn.getNumOperands(); op++) {
                        for (Object o : insn.getOpObjects(op)) {
                            if (o instanceof ghidra.program.model.scalar.Scalar) {
                                long v = ((ghidra.program.model.scalar.Scalar) o).getValue();
                                if (v == 0x7eL) has7e = true;
                                if (v == 0xF0L) hasF0 = true;
                                if (v == 0x7dL) has7d = true;
                                if (v == 0x7fL) has7f = true;
                            }
                        }
                    }
                }
                if (has7e) funcsWith7e++;
                if (hasF0) funcsWithF0++;
                if (has7e && hasF0) {
                    funcsWithBoth++;
                    if (candidateCount < 60) {
                        out.println("  candidate: " + f.getName() + " @ " + f.getEntryPoint() +
                            "  has 0x7d=" + has7d + " 0x7e=" + has7e + " 0x7f=" + has7f + " 0xF0=" + hasF0);
                    }
                    candidateCount++;
                }
            }
            out.println();
            out.println("totals: total_funcs=" + totalFuncs +
                "  with_7e=" + funcsWith7e +
                "  with_F0=" + funcsWithF0 +
                "  with_both=" + funcsWithBoth);
            out.println();

            out.println("================================================================================");
            out.println("DONE");
            out.println("================================================================================");
        } finally {
            out.close();
        }
    }

    private List<Address> scanMemoryForBytes(Memory memory, byte[] pattern) {
        List<Address> hits = new ArrayList<>();
        AddressSetView searchable = memory.getLoadedAndInitializedAddressSet();
        Address start = searchable.getMinAddress();
        Address end = searchable.getMaxAddress();
        Address cur = start;
        int hardCap = 500;
        while (cur != null && cur.compareTo(end) <= 0 && hits.size() < hardCap) {
            Address found = memory.findBytes(cur, end, pattern, null, true, monitor);
            if (found == null) break;
            hits.add(found);
            try {
                cur = found.add(1);
            } catch (Exception e) {
                break;
            }
        }
        return hits;
    }
}
