// FindAxeEditIIIRvaPointerArray.java — Ghidra GhidraScript
//
// Hypothesis: AxeEdit III stores SYSEX_*-name pointers as 32-bit RVAs
// (relative to image base 0x140000000) rather than full 64-bit absolute
// pointers. The flat-absolute-pointer scan (FindAxeEditIIIEnumPtrArray)
// found 0 runs. Maybe the table uses RVA encoding.
//
// Strategy:
//   1. Read every 4-byte slot in .rdata/.data.
//   2. Treat as u32, add to imageBase. If result is a known SYSEX_*
//      string address, record.
//   3. Find consecutive 4-byte-stride runs of these hits.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-rva-array.txt
//
// @category AxeFxIII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
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
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class FindAxeEditIIIRvaPointerArray extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-rva-array.txt";

    private static final String[] PREFIXES = { "SYSEX_", "MESSAGE_", "MIDI_ERROR_" };

    private final List<String> lines = new ArrayList<>();

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        Listing listing = program.getListing();
        Memory mem = program.getMemory();
        FunctionManager funcMgr = program.getFunctionManager();
        ReferenceManager refMgr = program.getReferenceManager();
        long imageBase = program.getImageBase().getOffset();

        w("================================================================================");
        w("FindAxeEditIIIRvaPointerArray.java");
        w("  Program:    " + program.getName());
        w("  Image base: 0x" + Long.toHexString(imageBase));
        w("  Output:     " + OUTPUT_PATH);
        w("================================================================================");

        // ── Collect known SYSEX_* strings ────────────────────────────
        Map<Long, String> stringByAddr = new TreeMap<>();
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
                    stringByAddr.put(d.getAddress().getOffset(), text);
                    break;
                }
            }
        }
        w("Indexed " + stringByAddr.size() + " known strings.");

        Set<Long> stringSet = stringByAddr.keySet();

        // ── Pass 1: RVA scan — 32-bit slots whose (slot + imageBase) is a string ──
        Map<Long, Long> rvaHit = new TreeMap<>(); // location → absolute string addr
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized()) continue;
            if (block.isExecute()) continue;
            long blockStart = block.getStart().getOffset();
            long blockEnd   = block.getEnd().getOffset();
            int len = (int) Math.min(blockEnd - blockStart + 1, 0x40000000);
            byte[] buf = new byte[len];
            try { mem.getBytes(block.getStart(), buf, 0, len); }
            catch (Exception ignored) { continue; }
            ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
            for (int i = 0; i + 4 <= len; i += 4) {
                long rva = bb.getInt(i) & 0xFFFFFFFFL;
                long abs = rva + imageBase;
                if (stringSet.contains(abs)) {
                    rvaHit.put(blockStart + i, abs);
                }
                // Also try interpreting as ABSOLUTE 32-bit address (some MSVC
                // builds inline a 32-bit absolute when ImageBase < 4GB —
                // doesn't apply at imageBase 0x140000000, but try anyway).
                if (stringSet.contains(rva)) {
                    rvaHit.put(blockStart + i, rva);
                }
            }
        }
        w("");
        w("RVA-mode hits: " + rvaHit.size());

        // ── Pass 2: consecutive stride-4 runs ────────────────────────
        List<long[]> runs = new ArrayList<>();
        long prev = -1; long runStart = -1; int runLen = 0;
        for (Map.Entry<Long, Long> e : rvaHit.entrySet()) {
            long loc = e.getKey();
            if (runStart < 0) { runStart = loc; runLen = 1; prev = loc; continue; }
            if (loc == prev + 4) { runLen++; prev = loc; continue; }
            if (runLen >= 3) runs.add(new long[] { runStart, runLen });
            runStart = loc; runLen = 1; prev = loc;
        }
        if (runLen >= 3) runs.add(new long[] { runStart, runLen });
        runs.sort((a, b) -> Long.compare(b[1], a[1]));

        w("Stride-4 RVA runs (>= 3 entries): " + runs.size());
        for (long[] r : runs) {
            w(String.format("  @ 0x%08x  len=%d", r[0], r[1]));
        }
        w("");

        // ── Pass 3: enumerate each run + spit out (index, name) ──────
        for (long[] r : runs) {
            long start = r[0];
            int len = (int) r[1];
            w("================================================================================");
            w("RVA-table @ 0x" + Long.toHexString(start) + " (" + len + " entries)");
            w("================================================================================");
            for (int i = 0; i < len; i++) {
                long loc = start + (long) i * 4;
                long absAddr = rvaHit.get(loc);
                String name = stringByAddr.get(absAddr);
                w(String.format("  idx=%3d (0x%02X)  @ 0x%08x  -> 0x%08x  name=%s",
                    i, i, loc, absAddr, name));
            }
        }
        w("");

        // ── Pass 4: also dump standalone hits (not in any run) ───────
        Set<Long> inRun = new HashSet<>();
        for (long[] r : runs) {
            for (int i = 0; i < r[1]; i++) inRun.add(r[0] + (long) i * 4);
        }
        w("Standalone RVA hits (not in a stride-4 run):");
        for (Map.Entry<Long, Long> e : rvaHit.entrySet()) {
            if (inRun.contains(e.getKey())) continue;
            long absAddr = e.getValue();
            String name = stringByAddr.get(absAddr);
            w(String.format("  @ 0x%08x  -> 0x%08x  name=%s",
                e.getKey(), absAddr, name));
        }

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }
}
