// DumpFractalEditorOpcodeTable64.java — Ghidra GhidraScript
//
// 64-bit-aware, multi-prefix version of DumpFractalEditorOpcodeTable.java.
//
// The 32-bit AxeEdit II binary stores its opcode descriptor as
// `{ const char* name; uint32_t opcode; }` = 8 bytes. The newer AM4-Edit
// (64-bit) and Axe-Edit III (64-bit) binaries use 8-byte pointers, so the
// equivalent struct is at least 16 bytes (8-byte ptr + 4-byte opcode +
// 4-byte padding) or potentially 24 bytes (8 + 8).
//
// This script:
//   - Detects the binary's pointer size from the program metadata.
//   - Scans for multiple opcode-name prefixes (SYSEX_, GET_, SET_, OP_)
//     since AM4-Edit and III use GET_/SET_ instead of SYSEX_.
//   - Tries multiple struct strides (12, 16, 20, 24) and reports any
//     stride with a run of >= 3 consecutive entries.
//   - Falls back to searching for {string_ptr} alone (no opcode field)
//     and reporting raw xref locations so we can inspect manually.
//
// Output: samples/captured/decoded/ghidra-<program>-opcode-map-v2.txt
//
// Run example (AM4):
//   analyzeHeadless %USERPROFILE% ghidra-am4-edit ^
//       -process AM4-Edit.exe -noanalysis -readOnly ^
//       -scriptPath %PROJECT_ROOT%\packages\fractal-midi\scripts\ghidra ^
//       -postScript DumpFractalEditorOpcodeTable64.java
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

public class DumpFractalEditorOpcodeTable64 extends GhidraScript {

    private static final String OUTPUT_DIR =
        "samples\\captured\\decoded\\";

    private static final String[] PREFIXES = {
        "SYSEX_", "MESSAGE_", "OP_", "FN_", "SYX_"
    };

    private static final int[] STRIDES = { 8, 12, 16, 20, 24, 32 };

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
        String outPath = OUTPUT_DIR + "ghidra-" + slug + "-opcode-map-v2.txt";

        w("================================================================================");
        w("DumpFractalEditorOpcodeTable64.java");
        w("  Program:    " + progName);
        w("  Ptr size:   " + ptrSize + " bytes");
        w("  Prefixes:   " + Arrays.toString(PREFIXES));
        w("  Output:     " + outPath);
        w("================================================================================");
        w("");

        // ── Pass 1: collect interesting strings ──────────────────────
        // Use BOTH defined-data iterator AND raw memory scan, since
        // auto-analysis may not have defined every string yet.
        Map<Long, String> stringByAddr = collectInterestingStrings();
        w("Distinct interesting strings: " + stringByAddr.size());
        Map<String, Integer> countByPrefix = new TreeMap<>();
        for (String name : stringByAddr.values()) {
            for (String p : PREFIXES) {
                if (name.startsWith(p)) {
                    countByPrefix.merge(p, 1, Integer::sum);
                    break;
                }
            }
        }
        for (Map.Entry<String, Integer> e : countByPrefix.entrySet()) {
            w(String.format("  %-8s  %d strings", e.getKey() + "*", e.getValue()));
        }
        w("");
        if (stringByAddr.isEmpty()) {
            writeOut(outPath);
            return;
        }

        // ── Pass 2: find candidate {ptr, opcode} locations ──────────
        Set<Long> stringSet = stringByAddr.keySet();
        // entries: location → [namePtr, opcode, ptrSize_used]
        Map<Long, long[]> entries = new TreeMap<>();
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
            int ps = ptrSize;
            for (int i = 0; i + ps + 4 <= len; i += 4) {
                if (monitor.isCancelled()) break;
                long namePtr;
                if (ps == 8) namePtr = bb.getLong(i);
                else         namePtr = bb.getInt(i) & 0xFFFFFFFFL;
                if (!stringSet.contains(namePtr)) continue;
                long opcode = bb.getInt(i + ps) & 0xFFFFFFFFL;
                if (opcode > 0xFF) continue;
                entries.put(blockStart + i, new long[] { namePtr, opcode });
            }
        }
        w("Candidate {namePtr, u32-opcode-0..FF} locations: " + entries.size());
        w("");

        // ── Pass 3: stride probe ────────────────────────────────────
        // For each stride, find the longest run of consecutive entries
        // at that stride. Pick the stride with the longest run.
        int bestStride = -1;
        int bestRun = 0;
        long bestStart = -1L;
        for (int stride : STRIDES) {
            for (long start : entries.keySet()) {
                int count = 1;
                long cur = start + stride;
                while (entries.containsKey(cur)) {
                    count++;
                    cur += stride;
                }
                if (count > bestRun) {
                    bestRun = count;
                    bestStride = stride;
                    bestStart = start;
                }
            }
        }
        w("Best stride: " + bestStride + " bytes, run length " + bestRun
            + ", starts @ 0x" + Long.toHexString(bestStart));
        w("");
        if (bestRun < 3) {
            w("No stride run >= 3 found. Dumping each candidate as a standalone");
            w("(location, name, opcode) row instead.");
            w("");
            for (Map.Entry<Long, long[]> e : entries.entrySet()) {
                long loc = e.getKey();
                long ptr = e.getValue()[0];
                long opc = e.getValue()[1];
                w(String.format("  @ 0x%08x  ptr=0x%08x  opcode=0x%02X  name=%s",
                    loc, ptr, opc, stringByAddr.get(ptr)));
            }
            writeOut(outPath);
            return;
        }

        // ── Pass 4: enumerate the best run + any other runs of >= 3 ─
        // Find every run at the chosen stride.
        List<List<long[]>> runs = new ArrayList<>();
        Set<Long> seen = new HashSet<>();
        for (Map.Entry<Long, long[]> e : entries.entrySet()) {
            long loc = e.getKey();
            if (seen.contains(loc)) continue;
            // Only start from the head of a run (prev is not an entry).
            if (entries.containsKey(loc - bestStride)) continue;
            List<long[]> run = new ArrayList<>();
            long cur = loc;
            while (entries.containsKey(cur)) {
                long[] vals = entries.get(cur);
                run.add(new long[] { cur, vals[0], vals[1] });
                seen.add(cur);
                cur += bestStride;
            }
            if (run.size() >= 3) runs.add(run);
        }
        runs.sort((a, b) -> b.size() - a.size());

        w("Stride-" + bestStride + " runs (>= 3 entries):");
        for (int i = 0; i < runs.size(); i++) {
            List<long[]> run = runs.get(i);
            String firstName = stringByAddr.get(run.get(0)[1]);
            String lastName  = stringByAddr.get(run.get(run.size() - 1)[1]);
            w(String.format("  [%2d] @ 0x%08x  %d entries  first=%s..last=%s",
                i, run.get(0)[0], run.size(), firstName, lastName));
        }
        w("");

        // ── Pass 5: full enum-value-keyed map ───────────────────────
        w("################################################################################");
        w("## ENUM-VALUE → OPCODE-NAME MAP (raw — apply wire = enum - 1 separately");
        w("##   if that rule holds; verify against known wire bytes first.)");
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
        w("NOTE: AxeEdit II uses `wire_byte = enum_value - 1`. Verify by");
        w("cross-checking against 3+ known wire bytes from captured traffic.");
        w("If the offset is different (0, -1, +1, etc.), document it in the");
        w("device's SYSEX-MAP.md.");

        writeOut(outPath);
    }

    private Map<Long, String> collectInterestingStrings() {
        Map<Long, String> result = new TreeMap<>();
        // Pass A: defined-data iterator (fast, but misses undefined strings)
        DataIterator dataIter = listing.getDefinedData(true);
        while (dataIter.hasNext()) {
            if (monitor.isCancelled()) break;
            Data d = dataIter.next();
            if (!d.hasStringValue()) continue;
            StringDataInstance s = StringDataInstance.getStringDataInstance(d);
            if (s == null) continue;
            String text = s.getStringValue();
            if (text == null) continue;
            if (matchesPrefix(text)) {
                result.put(d.getAddress().getOffset(), text);
            }
        }
        // Pass B: raw memory scan for undefined strings.
        // Look for ASCII byte sequences in initialized memory (including
        // execute blocks, since PE/MSVC sometimes inlines string literals
        // in .text) that match our prefixes and end with NUL.
        int passBBlocks = 0;
        int passBFound = 0;
        int passBTotalStrs = 0;
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized()) continue;
            long blockStart = block.getStart().getOffset();
            long blockEnd   = block.getEnd().getOffset();
            int len = (int) Math.min(blockEnd - blockStart + 1, 0x40000000);
            byte[] buf = new byte[len];
            try {
                mem.getBytes(block.getStart(), buf, 0, len);
            } catch (Exception ignored) { continue; }
            passBBlocks++;
            int blockStrs = 0;
            int blockHits = 0;
            int i = 0;
            while (i < len) {
                int c = buf[i] & 0xFF;
                if (!(c >= 'A' && c <= 'Z')) { i++; continue; }
                int j = i;
                while (j < len) {
                    int cj = buf[j] & 0xFF;
                    if (cj == 0) break;
                    if (!isStringChar(cj)) { j = -1; break; }
                    j++;
                }
                if (j < 0 || j >= len || j - i < 4) { i++; continue; }
                String text = new String(buf, i, j - i, java.nio.charset.StandardCharsets.US_ASCII);
                blockStrs++;
                if (matchesPrefix(text)) {
                    long addr = blockStart + i;
                    if (!result.containsKey(addr)) {
                        result.put(addr, text);
                        passBFound++;
                        blockHits++;
                    }
                }
                i = j + 1;
            }
            passBTotalStrs += blockStrs;
            if (blockHits > 0) {
                println(String.format("  Block %-20s strs=%6d  hits=%4d",
                    block.getName(), blockStrs, blockHits));
            }
        }
        println("Pass B (raw scan): scanned " + passBBlocks + " blocks, "
            + passBTotalStrs + " total strings, " + passBFound + " new prefix-matching");
        return result;
    }

    private boolean matchesPrefix(String s) {
        for (String p : PREFIXES) if (s.startsWith(p)) return true;
        return false;
    }

    private boolean isStringChar(int c) {
        if (c >= 'A' && c <= 'Z') return true;
        if (c >= 'a' && c <= 'z') return true;
        if (c >= '0' && c <= '9') return true;
        if (c == '_') return true;
        return false;
    }

    private void writeOut(String path) throws Exception {
        try (PrintWriter out = new PrintWriter(new FileWriter(path))) {
            for (String l : lines) out.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + path);
    }
}
