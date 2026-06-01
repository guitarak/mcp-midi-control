// ProbeSysexStringsGeneric.java — Ghidra GhidraScript
//
// Diagnostic probe for Fractal editor binaries that DO NOT match the
// AxeEdit II OpcodeDescriptor convention. When DumpFractalEditorOpcodeTable
// finds <50 SYSEX_* strings and 0 candidate {name,opcode} stride-8
// entries, this script:
//
//   1. Dumps every SYSEX_* (and FN_*, OP_*, MIDI_*) string in the binary
//      with its address.
//   2. For each string, lists the addresses that hold a pointer TO that
//      string (xrefs from data).
//   3. For each xref location, dumps the 16 bytes before and after, so
//      we can spot alternative struct layouts (stride-16, reversed
//      field order, u8 opcode + padding, etc.).
//
// Output: samples/captured/decoded/ghidra-<program>-sysex-string-probe.txt
//
// Run example:
//   analyzeHeadless %USERPROFILE% ghidra-am4-edit ^
//       -process AM4-Edit.exe -noanalysis -readOnly ^
//       -scriptPath %PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra ^
//       -postScript ProbeSysexStringsGeneric.java
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

public class ProbeSysexStringsGeneric extends GhidraScript {

    private static final String OUTPUT_DIR =
        "samples\\captured\\decoded\\";

    private final List<String> lines = new ArrayList<>();
    private Listing listing;
    private Memory mem;
    private AddressSpace as;
    private int ptrSize;

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
        ptrSize = program.getDefaultPointerSize();

        String progName = program.getName();
        String slug = progName.replaceFirst("(?i)\\.exe$", "").toLowerCase().replace(' ', '-');
        String outPath = OUTPUT_DIR + "ghidra-" + slug + "-sysex-string-probe.txt";

        w("================================================================================");
        w("ProbeSysexStringsGeneric.java");
        w("  Program: " + progName + "  (ptr size = " + ptrSize + ")");
        w("  Output:  " + outPath);
        w("================================================================================");
        w("");

        // ── Pass 1: collect all interesting strings ─────────────────
        Map<Long, String> strings = new TreeMap<>();
        DataIterator dataIter = listing.getDefinedData(true);
        while (dataIter.hasNext()) {
            if (monitor.isCancelled()) break;
            Data d = dataIter.next();
            if (!d.hasStringValue()) continue;
            StringDataInstance s = StringDataInstance.getStringDataInstance(d);
            if (s == null) continue;
            String text = s.getStringValue();
            if (text == null) continue;
            if (text.startsWith("SYSEX_") || text.startsWith("FN_")
                || text.startsWith("OP_")  || text.startsWith("MIDI_")
                || text.startsWith("SYX_")) {
                strings.put(d.getAddress().getOffset(), text);
            }
        }
        w("Interesting strings (SYSEX_/FN_/OP_/MIDI_/SYX_): " + strings.size());
        w("");
        for (Map.Entry<Long, String> e : strings.entrySet()) {
            w(String.format("  0x%08x  %s", e.getKey(), e.getValue()));
        }
        w("");

        // ── Pass 2: build full data-pointer map ─────────────────────
        // Map<location → string-address-it-points-to>
        Map<Long, Long> ptrToString = new TreeMap<>();
        Set<Long> stringAddrs = strings.keySet();
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized()) continue;
            if (block.isExecute()) continue;
            long blockStart = block.getStart().getOffset();
            long blockEnd   = block.getEnd().getOffset();
            int len = (int) Math.min(blockEnd - blockStart + 1, 0x40000000);
            byte[] buf = new byte[len];
            try {
                mem.getBytes(block.getStart(), buf, 0, len);
            } catch (Exception ignored) { continue; }
            ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i + ptrSize <= len; i += 4) {
                long candidate;
                if (ptrSize == 8) candidate = bb.getLong(i);
                else              candidate = bb.getInt(i) & 0xFFFFFFFFL;
                if (stringAddrs.contains(candidate)) {
                    ptrToString.put(blockStart + i, candidate);
                }
            }
        }
        w("Pointers to interesting strings: " + ptrToString.size());
        w("");

        // ── Pass 3: per-string xref dump with surrounding bytes ─────
        w("################################################################################");
        w("## PER-STRING XREFS WITH SURROUNDING BYTES");
        w("################################################################################");
        w("");
        // group xrefs by the string they point to
        Map<Long, List<Long>> xrefsByStr = new TreeMap<>();
        for (Map.Entry<Long, Long> e : ptrToString.entrySet()) {
            xrefsByStr.computeIfAbsent(e.getValue(), k -> new ArrayList<>()).add(e.getKey());
        }
        for (Map.Entry<Long, String> sEntry : strings.entrySet()) {
            long strAddr = sEntry.getKey();
            String name  = sEntry.getValue();
            List<Long> xrefs = xrefsByStr.getOrDefault(strAddr, Collections.emptyList());
            w(String.format("─── %-40s @ 0x%08x  (%d xrefs)", name, strAddr, xrefs.size()));
            for (long loc : xrefs) {
                w(String.format("    xref @ 0x%08x:", loc));
                dumpContext(loc);
            }
            w("");
        }

        // ── Pass 4: stride-16 + stride-12 + reverse-order probe ─────
        w("################################################################################");
        w("## STRIDE PROBE — looking for OpcodeDescriptor-like layouts");
        w("##   For each xref location, check whether (loc - stride*k) for");
        w("##   stride in {8, 12, 16} also holds a pointer to a SYSEX_ string.");
        w("##   If multiple aligned consecutive locations satisfy this, that's");
        w("##   the struct stride.");
        w("################################################################################");
        w("");
        int[] strides = {8, 12, 16, 24, 32};
        for (int stride : strides) {
            // Build a run: starting at every xref, count consecutive {loc, loc+stride, ...} hits.
            int maxRun = 0;
            long maxStart = -1L;
            for (long start : ptrToString.keySet()) {
                int count = 1;
                long cur = start + stride;
                while (ptrToString.containsKey(cur)) {
                    count++;
                    cur += stride;
                }
                if (count > maxRun) {
                    maxRun = count;
                    maxStart = start;
                }
            }
            if (maxRun >= 3) {
                w(String.format("  stride %d  max run = %d  starts @ 0x%08x",
                    stride, maxRun, maxStart));
            } else {
                w(String.format("  stride %d  no run >= 3", stride));
            }
        }
        w("");

        writeOut(outPath);
    }

    private void dumpContext(long loc) {
        // Print 16 bytes before and 32 bytes after, formatted as hex with separators.
        long start = loc - 16;
        try {
            Address a = as.getAddress(start);
            byte[] buf = new byte[48];
            mem.getBytes(a, buf, 0, 48);
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 48; i++) {
                if (i == 16) hex.append("[");
                if (i == 16 + ptrSize) hex.append("]");
                if (i > 0 && (i % 4) == 0 && i != 16 && i != 16 + ptrSize) hex.append(" ");
                hex.append(String.format("%02x", buf[i] & 0xFF));
            }
            w("        " + hex.toString());
        } catch (Exception e) {
            w("        (cannot read context @ " + Long.toHexString(start) + ")");
        }
    }

    private void writeOut(String path) throws Exception {
        try (PrintWriter out = new PrintWriter(new FileWriter(path))) {
            for (String l : lines) out.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + path);
    }
}
