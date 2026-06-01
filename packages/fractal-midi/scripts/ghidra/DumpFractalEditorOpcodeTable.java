// DumpFractalEditorOpcodeTable.java — Ghidra GhidraScript
//
// Generic version of DumpAxeEditIIOpcodeTable.java. Works on any
// Fractal editor binary (AM4-Edit.exe / Axe-Edit.exe / Axe-Edit-III.exe)
// by AUTO-DISCOVERING the SYSEX_* string pool and the OpcodeDescriptor
// struct array instead of hardcoding pool addresses.
//
// Output filename includes the program name so multiple editors can
// be mined into separate files without collision.
//
// Run example (AM4):
//   analyzeHeadless %USERPROFILE% ghidra-am4-edit ^
//       -process AM4-Edit.exe -noanalysis -readOnly ^
//       -scriptPath %PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra ^
//       -postScript DumpFractalEditorOpcodeTable.java
//
// Run example (Axe-Fx III):
//   analyzeHeadless %USERPROFILE% ghidra-axe-edit-iii ^
//       -process Axe-Edit-III.exe -noanalysis -readOnly ^
//       -scriptPath %PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra ^
//       -postScript DumpFractalEditorOpcodeTable.java
//
// Output:
//   samples/captured/decoded/ghidra-<program>-opcode-map.txt
//
// @category Fractal

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class DumpFractalEditorOpcodeTable extends GhidraScript {

    private static final String OUTPUT_DIR =
        "samples\\captured\\decoded\\";

    private final List<String> lines = new ArrayList<>();
    private Listing listing;
    private Memory mem;
    private AddressSpace as;

    private void w(String s) {
        lines.add(s);
        println(s);
    }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        listing = program.getListing();
        as = program.getAddressFactory().getDefaultAddressSpace();
        mem = program.getMemory();

        String progName = program.getName();
        // Strip extension for the output filename.
        String slug = progName.replaceFirst("(?i)\\.exe$", "").toLowerCase();
        String outPath = OUTPUT_DIR + "ghidra-" + slug + "-opcode-map.txt";

        w("================================================================================");
        w("Fractal editor RE — DumpFractalEditorOpcodeTable.java");
        w("  Auto-discover the SYSEX_* string pool + OpcodeDescriptor struct array.");
        w("  Program: " + progName);
        w("  Output:  " + outPath);
        w("================================================================================");
        w("");

        // ── Pass 1: enumerate every SYSEX_* string in the binary ─────
        Map<Long, String> stringByAddr = new TreeMap<>();
        DataIterator dataIter = listing.getDefinedData(true);
        while (dataIter.hasNext()) {
            if (monitor.isCancelled()) break;
            Data d = dataIter.next();
            if (!d.hasStringValue()) continue;
            StringDataInstance s = StringDataInstance.getStringDataInstance(d);
            if (s == null) continue;
            String text = s.getStringValue();
            if (text == null || !text.startsWith("SYSEX_")) continue;
            stringByAddr.put(d.getAddress().getOffset(), text);
        }
        w("Found " + stringByAddr.size() + " SYSEX_* strings in the binary.");
        if (stringByAddr.isEmpty()) {
            w("");
            w("No SYSEX_* strings found. This binary may not use the AxeEdit-family");
            w("opcode-name convention, OR the strings live under a different prefix.");
            w("Inspect the binary manually via Ghidra's defined strings panel.");
            writeOut(outPath);
            return;
        }

        // ── Pass 2: find all 4-byte locations whose value is a string
        //   address AND whose successor 4-byte slot is a u32 in 0..0xFF
        //   (the opcode field). Build {location → [name_ptr, opcode]}.
        // ─────────────────────────────────────────────────────────────
        Set<Long> stringSet = stringByAddr.keySet();
        Map<Long, long[]> entries = new TreeMap<>();
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized()) continue;
            if (block.isExecute()) continue;
            long blockStart = block.getStart().getOffset();
            long blockEnd   = block.getEnd().getOffset();
            byte[] buf;
            try {
                buf = new byte[(int) Math.min(blockEnd - blockStart + 1, 0x40000000)];
                mem.getBytes(block.getStart(), buf, 0, buf.length);
            } catch (Exception ignored) {
                continue;
            }
            ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i + 8 <= buf.length; i += 4) {
                if (monitor.isCancelled()) break;
                long namePtr = bb.getInt(i) & 0xFFFFFFFFL;
                long opcode  = bb.getInt(i + 4) & 0xFFFFFFFFL;
                if (!stringSet.contains(namePtr)) continue;
                if (opcode > 0xFF) continue;
                entries.put(blockStart + i, new long[] { namePtr, opcode });
            }
        }
        w("Candidate {name, opcode} entries: " + entries.size());
        w("");

        // ── Pass 3: group into stride-8 runs ─────────────────────────
        List<List<long[]>> runs = new ArrayList<>();
        List<long[]> cur = null;
        Long prev = null;
        for (Map.Entry<Long, long[]> e : entries.entrySet()) {
            long loc = e.getKey();
            long[] vals = e.getValue();
            if (prev == null || loc != prev + 8) {
                if (cur != null && cur.size() >= 3) runs.add(cur);
                cur = new ArrayList<>();
            }
            cur.add(new long[] { loc, vals[0], vals[1] });
            prev = loc;
        }
        if (cur != null && cur.size() >= 3) runs.add(cur);
        runs.sort((a, b) -> b.size() - a.size());

        w("Stride-8 runs (>= 3 entries):");
        for (int i = 0; i < runs.size(); i++) {
            List<long[]> run = runs.get(i);
            String firstName = stringByAddr.get(run.get(0)[1]);
            String lastName  = stringByAddr.get(run.get(run.size() - 1)[1]);
            w(String.format("  [%2d] @ 0x%08x  %d entries  first=%s..last=%s",
                i, run.get(0)[0], run.size(), firstName, lastName));
        }
        w("");

        // ── Pass 4: full enum-value-keyed map ────────────────────────
        w("################################################################################");
        w("## ENUM-VALUE → OPCODE-NAME MAP (raw — apply wire = enum - 1 separately)");
        w("################################################################################");
        w("");
        TreeMap<Long, String> enumToName = new TreeMap<>();
        for (List<long[]> run : runs) {
            for (long[] entry : run) {
                long enumValue = entry[2];
                String name = stringByAddr.get(entry[1]);
                if (enumToName.containsKey(enumValue) && !enumToName.get(enumValue).equals(name)) {
                    w(String.format("  WARN: enum 0x%02X has duplicate names: %s / %s",
                        enumValue, enumToName.get(enumValue), name));
                }
                enumToName.put(enumValue, name);
            }
        }
        for (Map.Entry<Long, String> e : enumToName.entrySet()) {
            w(String.format("  0x%02X  %s", e.getKey(), e.getValue()));
        }
        w("");
        w("Total distinct enum values: " + enumToName.size());
        w("");
        w("NOTE: AxeEdit II uses `wire_byte = enum_value - 1`. Verify this offset");
        w("rule holds on this binary by cross-checking 3+ known wire bytes (e.g.");
        w("the SET_PARAM envelope's wire byte) against the names above. If the");
        w("offset is different (0, -1, +1, etc.), document it in the device's");
        w("SYSEX-MAP.md.");

        writeOut(outPath);
    }

    private void writeOut(String path) throws Exception {
        try (PrintWriter out = new PrintWriter(new FileWriter(path))) {
            for (String l : lines) out.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + path);
    }
}
