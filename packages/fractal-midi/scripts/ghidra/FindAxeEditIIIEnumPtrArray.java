// FindAxeEditIIIEnumPtrArray.java — Ghidra GhidraScript
//
// AxeEdit III (64-bit) does NOT use the {name_ptr, opcode_u32} struct
// pattern that AxeEdit II uses. DumpFractalEditorOpcodeTable64.java
// returned exactly 1 candidate row when run against III.
//
// Hypothesis: III stores SYSEX_* names as a FLAT pointer array, where
// the array INDEX is the enum value. Scan .rdata for a stretch of
// consecutive 8-byte pointers, each resolving to a SYSEX_*/MESSAGE_*
// string. The starting offset of the run defines the enum-zero anchor;
// the per-index name maps directly to a candidate function byte.
//
// This is the pattern AxeEdit III's logger uses for symbolic names —
// see MIDI_ERROR_BAD_CHKSUM and friends which were already recovered
// from a similar pointer array at 0x140598108.
//
// Output: %PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded\ghidra-axe-edit-iii-enum-ptr-array.txt
//
// @category AxeFxIII

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

public class FindAxeEditIIIEnumPtrArray extends GhidraScript {

    private static final String OUTPUT_DIR =
        "samples\\captured\\decoded\\";

    private static final String[] PREFIXES = {
        "SYSEX_", "MESSAGE_", "MIDI_ERROR_", "OP_", "FN_", "SYX_"
    };

    private static final int MIN_RUN_LEN = 3;

    private final List<String> lines = new ArrayList<>();
    private Listing listing;
    private Memory mem;
    private int ptrSize;

    private void w(String s) {
        lines.add(s);
        println(s);
    }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        listing = program.getListing();
        mem = program.getMemory();
        ptrSize = program.getDefaultPointerSize();

        String progName = program.getName();
        String slug = progName.replaceFirst("(?i)\\.exe$", "").toLowerCase().replace(' ', '-');
        String outPath = OUTPUT_DIR + "ghidra-" + slug + "-enum-ptr-array.txt";

        w("================================================================================");
        w("FindAxeEditIIIEnumPtrArray.java");
        w("  Program:    " + progName);
        w("  Ptr size:   " + ptrSize + " bytes");
        w("  Prefixes:   " + Arrays.toString(PREFIXES));
        w("  Output:     " + outPath);
        w("================================================================================");
        w("");

        // ── 1. Collect every interesting string ──────────────────────
        Map<Long, String> stringByAddr = collectStrings();
        w("Found " + stringByAddr.size() + " interesting strings:");
        Map<String, Integer> byPrefix = new TreeMap<>();
        for (String name : stringByAddr.values()) {
            for (String p : PREFIXES) {
                if (name.startsWith(p)) { byPrefix.merge(p, 1, Integer::sum); break; }
            }
        }
        for (var e : byPrefix.entrySet()) w("  " + e.getKey() + "*  " + e.getValue() + " strings");
        w("");

        if (stringByAddr.isEmpty()) { writeOut(outPath); return; }

        // ── 2. Scan .rdata-like blocks for consecutive pointer runs ─
        // For each 8-byte-aligned offset, treat as a candidate u64
        // pointer. If it resolves to a known interesting string and the
        // adjacent 8-byte slots also resolve to interesting strings,
        // extend the run.
        // ─────────────────────────────────────────────────────────────
        Set<Long> stringSet = stringByAddr.keySet();
        List<long[]> runs = new ArrayList<>(); // [blockStart, runStart, runLen]
        Map<Long, String> indexToName = new TreeMap<>();

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

            // Pass A: find which offsets contain a known string-ptr.
            // 8-byte aligned.
            List<Long> hitOffs = new ArrayList<>();
            for (int i = 0; i + ptrSize <= len; i += ptrSize) {
                long ptr = (ptrSize == 8) ? bb.getLong(i) : (bb.getInt(i) & 0xFFFFFFFFL);
                if (stringSet.contains(ptr)) hitOffs.add((long) i);
            }
            if (hitOffs.isEmpty()) continue;

            w("Block " + block.getName() + " @ 0x" + Long.toHexString(blockStart)
                + " — " + hitOffs.size() + " offsets contain a known string-ptr");

            // Pass B: group consecutive 8-byte-stride offsets into runs.
            int idx = 0;
            while (idx < hitOffs.size()) {
                long startOff = hitOffs.get(idx);
                int runLen = 1;
                int next = idx + 1;
                while (next < hitOffs.size() && hitOffs.get(next) == startOff + (long) runLen * ptrSize) {
                    runLen++;
                    next++;
                }
                if (runLen >= MIN_RUN_LEN) {
                    runs.add(new long[] { blockStart, startOff, (long) runLen });
                }
                idx = next;
            }
        }

        // Sort runs longest first.
        runs.sort((a, b) -> Long.compare(b[2], a[2]));

        w("");
        w("Stride-" + ptrSize + " pointer runs (≥ " + MIN_RUN_LEN + " entries) into known strings:");
        for (int i = 0; i < runs.size(); i++) {
            long[] r = runs.get(i);
            long absStart = r[0] + r[1];
            long absEnd   = absStart + (r[2] - 1) * ptrSize;
            w(String.format("  [%2d] @ 0x%08x..0x%08x  %d entries",
                i, absStart, absEnd, r[2]));
        }
        w("");

        // ── 3. Dump each run's per-index contents ────────────────────
        for (int ri = 0; ri < runs.size(); ri++) {
            long[] r = runs.get(ri);
            long blockStart = r[0];
            long runStart = r[1];
            int runLen = (int) r[2];
            long absStart = blockStart + runStart;

            byte[] buf = new byte[runLen * ptrSize];
            mem.getBytes(currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(absStart),
                buf, 0, runLen * ptrSize);
            ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);

            w("################################################################################");
            w("## Run [" + ri + "] @ 0x" + Long.toHexString(absStart) + " (" + runLen + " entries)");
            w("################################################################################");
            for (int i = 0; i < runLen; i++) {
                long ptr = (ptrSize == 8) ? bb.getLong(i * ptrSize) : (bb.getInt(i * ptrSize) & 0xFFFFFFFFL);
                String name = stringByAddr.get(ptr);
                long absAddr = absStart + (long) i * ptrSize;
                w(String.format("  idx=%3d (0x%02X)  @ 0x%08x  ptr=0x%08x  name=%s",
                    i, i, absAddr, ptr, name == null ? "(unknown)" : name));
            }
            w("");
        }

        writeOut(outPath);
    }

    private Map<Long, String> collectStrings() {
        Map<Long, String> result = new TreeMap<>();
        DataIterator dataIter = listing.getDefinedData(true);
        while (dataIter.hasNext()) {
            if (monitor.isCancelled()) break;
            Data d = dataIter.next();
            if (!d.hasStringValue()) continue;
            StringDataInstance s = StringDataInstance.getStringDataInstance(d);
            if (s == null) continue;
            String text = s.getStringValue();
            if (text == null) continue;
            for (String p : PREFIXES) {
                if (text.startsWith(p)) {
                    result.put(d.getAddress().getOffset(), text);
                    break;
                }
            }
        }
        // Also raw-scan memory for undefined-string prefix matches.
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized()) continue;
            long blockStart = block.getStart().getOffset();
            long blockEnd   = block.getEnd().getOffset();
            int len = (int) Math.min(blockEnd - blockStart + 1, 0x40000000);
            byte[] buf = new byte[len];
            try { mem.getBytes(block.getStart(), buf, 0, len); }
            catch (Exception ignored) { continue; }
            int i = 0;
            while (i < len) {
                int c = buf[i] & 0xFF;
                if (!(c >= 'A' && c <= 'Z')) { i++; continue; }
                int j = i;
                while (j < len) {
                    int cj = buf[j] & 0xFF;
                    if (cj == 0) break;
                    if (!(cj == '_' || (cj >= 'A' && cj <= 'Z') || (cj >= 'a' && cj <= 'z') || (cj >= '0' && cj <= '9'))) {
                        j = -1; break;
                    }
                    j++;
                }
                if (j < 0 || j >= len || j - i < 4) { i++; continue; }
                String text = new String(buf, i, j - i, java.nio.charset.StandardCharsets.US_ASCII);
                for (String p : PREFIXES) {
                    if (text.startsWith(p)) {
                        long addr = blockStart + i;
                        result.putIfAbsent(addr, text);
                        break;
                    }
                }
                i = j + 1;
            }
        }
        return result;
    }

    private void writeOut(String path) throws Exception {
        try (PrintWriter out = new PrintWriter(new FileWriter(path))) {
            for (String l : lines) out.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + path);
    }
}
