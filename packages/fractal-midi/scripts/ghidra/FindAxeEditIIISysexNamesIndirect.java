// FindAxeEditIIISysexNamesIndirect.java — Ghidra GhidraScript
//
// Prior attempts to find code refs to the 23 SYSEX_* strings at
// .rdata 0x1405abf80..0x1405ac298 came up empty (0 functions reference
// any of them by direct LEA/MOV operand). Three hypotheses to test:
//
//   H1: The strings are referenced via PE relocations rather than
//       direct LEAs. Look for relocations whose target falls in the
//       SYSEX_* address range.
//
//   H2: The strings are referenced indirectly via wider pointer-array
//       windows beyond the 8-byte-stride search we did earlier. Try
//       arbitrary windows (stride 4, 12, 16, 24, 32, plus 2-of-3
//       interleaved patterns).
//
//   H3: The strings are referenced through INSTRUCTION OFFSET-RELATIVE
//       addressing where the displacement isn't picked up as an
//       absolute address by Ghidra's operand iterator. Walk every
//       LEA/MOV instruction and compute the EFFECTIVE absolute target
//       (instruction address + 4-byte displacement). This catches
//       RIP-relative loads on x86-64 that Ghidra didn't resolve.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-sysex-xref-attempt.txt
//
// @category AxeFxIII

import ghidra.app.script.GhidraScript;
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
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;

public class FindAxeEditIIISysexNamesIndirect extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-sysex-xref-attempt.txt";

    // 23 SYSEX_* anchor addresses and names.
    private static final long[] SYSEX_STRINGS = {
        0x1405abf80L, 0x1405abf90L, 0x1405abfa0L, 0x1405abfb8L,
        0x1405abfd0L, 0x1405abff8L, 0x1405ac010L, 0x1405ac028L,
        0x1405ac048L, 0x1405ac070L, 0x1405ac0b8L, 0x1405ac0d0L,
        0x1405ac0e8L, 0x1405ac100L, 0x1405ac150L, 0x1405ac1c0L,
        0x1405ac1e0L, 0x1405ac200L, 0x1405ac218L, 0x1405ac238L,
        0x1405ac250L, 0x1405ac268L, 0x1405ac298L,
    };
    private static final String[] SYSEX_NAMES = {
        "SYSEX_A3_TUNER", "SYSEX_A3_TEMPO", "SYSEX_SETGET_LOOPER", "SYSEX_GET_SCENENAME",
        "SYSEX_FS_PASSTHRU_MESSAGE", "SYSEX_SETGET_TEMPO", "SYSEX_PATCH_STATUS",
        "SYSEX_GUI_CONTROL", "SYSEX_FS_MESSAGE", "SYSEX_DSP_MESSAGE",
        "SYSEX_GET_PATCHNAME", "SYSEX_SETGET_SCENE", "SYSEX_SETGET_CHANNEL",
        "SYSEX_SETGET_BYPASS", "SYSEX_FOOTSWITCH_END", "SYSEX_A3_SYSTEM_DATA_START",
        "SYSEX_SYSTEM_DUMP", "SYSEX_FOOTSWITCH_DUMP", "SYSEX_EFFECT_DUMP",
        "SYSEX_FOOTSWITCH_DATA", "SYSEX_FOOTSWITCH_START", "SYSEX_A3_SYSTEM_DATA_END",
        "SYSEX_A3_SYSTEM_DATA",
    };

    private final List<String> lines = new ArrayList<>();
    private Memory mem;
    private Listing listing;
    private FunctionManager funcMgr;
    private ReferenceManager refMgr;

    private void w(String s) { lines.add(s); println(s); }

    private String nameFor(long addr) {
        for (int i = 0; i < SYSEX_STRINGS.length; i++)
            if (SYSEX_STRINGS[i] == addr) return SYSEX_NAMES[i];
        return null;
    }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        mem = program.getMemory();
        listing = program.getListing();
        funcMgr = program.getFunctionManager();
        refMgr = program.getReferenceManager();

        w("================================================================================");
        w("FindAxeEditIIISysexNamesIndirect.java");
        w("  Program:  " + program.getName());
        w("  Output:   " + OUTPUT_PATH);
        w("================================================================================");
        w("");

        Set<Long> targetSet = new HashSet<>();
        for (long a : SYSEX_STRINGS) targetSet.add(a);

        // ── H1: PE relocations targeting SYSEX_* range ────────────────
        w("################################################################################");
        w("## H1 — PE relocations into SYSEX_* range");
        w("################################################################################");
        w("");

        var relocIt = program.getRelocationTable().getRelocations();
        int relocScanned = 0;
        int relocMatches = 0;
        Map<Long, List<Long>> targetToRelocs = new HashMap<>();
        while (relocIt.hasNext()) {
            var r = relocIt.next();
            relocScanned++;
            long off = r.getAddress().getOffset();
            // For an absolute PE relocation, the 8-byte slot at this
            // address holds the absolute target after loading. Read it.
            byte[] buf = new byte[8];
            try { mem.getBytes(r.getAddress(), buf, 0, 8); } catch (Exception ex) { continue; }
            long val = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN).getLong();
            if (targetSet.contains(val)) {
                targetToRelocs.computeIfAbsent(val, k -> new ArrayList<>()).add(off);
                relocMatches++;
            }
        }
        w("Relocations scanned: " + relocScanned);
        w("Relocations targeting a SYSEX_* string: " + relocMatches);
        for (var e : targetToRelocs.entrySet()) {
            String n = nameFor(e.getKey());
            w("  " + n + " (@ 0x" + Long.toHexString(e.getKey()) + "): "
                + e.getValue().size() + " reloc sites");
            for (long site : e.getValue()) {
                Function f = funcMgr.getFunctionContaining(addrOf(site));
                w("    reloc @ 0x" + Long.toHexString(site)
                    + (f == null ? "  (not in function)" : "  in " + f.getName()
                        + " @ " + f.getEntryPoint()));
            }
        }
        w("");

        // ── H2: pointer-table scan with wider strides ────────────────
        w("################################################################################");
        w("## H2 — pointer-array scan with extended strides");
        w("################################################################################");
        w("");
        int[] strides = { 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 };
        for (int stride : strides) {
            int hits = scanForPointerRuns(targetSet, stride, 3);
            w("  stride=" + stride + ": runs ≥ 3 = " + hits);
        }
        w("");

        // ── H3: instruction-effective-address scan ────────────────────
        w("################################################################################");
        w("## H3 — instruction effective-address scan");
        w("################################################################################");
        w("");
        w("Walk every instruction; for any operand that is a Scalar or");
        w("Address, compute the EFFECTIVE absolute target = (next_ip +");
        w("operand) for RIP-relative addressing modes. Compare against");
        w("the SYSEX_* set.");
        w("");

        Map<Long, List<Address>> effectiveHits = new HashMap<>();
        InstructionIterator it = listing.getInstructions(true);
        int insScanned = 0;
        while (it.hasNext()) {
            Instruction ins = it.next();
            insScanned++;
            long nextIp = ins.getAddress().getOffset() + ins.getLength();
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    long v = -1;
                    if (o instanceof Address) v = ((Address) o).getOffset();
                    else if (o instanceof Scalar) {
                        long s = ((Scalar) o).getSignedValue();
                        // Try as RIP-relative offset.
                        long candidate = nextIp + s;
                        if (targetSet.contains(candidate)) v = candidate;
                        // Try as absolute (already covered by v above for Address ops).
                        else if (targetSet.contains(((Scalar) o).getUnsignedValue())) {
                            v = ((Scalar) o).getUnsignedValue();
                        }
                    }
                    if (v < 0 || !targetSet.contains(v)) continue;
                    effectiveHits.computeIfAbsent(v, k -> new ArrayList<>()).add(ins.getAddress());
                }
            }
        }
        w("  scanned " + insScanned + " instructions");
        w("  hits per SYSEX_*:");
        for (int i = 0; i < SYSEX_STRINGS.length; i++) {
            long a = SYSEX_STRINGS[i];
            List<Address> hits = effectiveHits.get(a);
            int count = hits == null ? 0 : hits.size();
            w(String.format("    %-30s @ 0x%-12x  hits=%d",
                SYSEX_NAMES[i], a, count));
            if (hits != null && hits.size() > 0 && hits.size() < 30) {
                for (Address h : hits) {
                    Function f = funcMgr.getFunctionContaining(h);
                    String fn = f == null ? "(no func)" : f.getName() + " @ " + f.getEntryPoint();
                    w("      " + h + "  in " + fn);
                }
            }
        }
        w("");

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private int scanForPointerRuns(Set<Long> targets, int stride, int minRun) throws Exception {
        int totalRuns = 0;
        for (MemoryBlock block : mem.getBlocks()) {
            if (!block.isInitialized()) continue;
            if (block.isExecute()) continue;
            long blockStart = block.getStart().getOffset();
            int len = (int) Math.min(block.getSize(), 0x40000000);
            byte[] buf = new byte[len];
            try { mem.getBytes(block.getStart(), buf, 0, len); } catch (Exception ex) { continue; }
            ByteBuffer bb = ByteBuffer.wrap(buf).order(ByteOrder.LITTLE_ENDIAN);
            // Pointer width = 8 bytes (64-bit). Aligned offsets.
            for (int off = 0; off + 8 <= len; off += 4) {
                long p0 = bb.getLong(off);
                if (!targets.contains(p0)) continue;
                int run = 1;
                int nextOff = off + stride;
                while (nextOff + 8 <= len) {
                    long pi = bb.getLong(nextOff);
                    if (!targets.contains(pi)) break;
                    run++;
                    nextOff += stride;
                }
                if (run >= minRun) {
                    totalRuns++;
                    String first = nameFor(p0);
                    long last = bb.getLong(off + (run - 1) * stride);
                    String lastName = nameFor(last);
                    w(String.format("    stride=%d run @ 0x%08x  len=%d  first=%s last=%s",
                        stride, blockStart + off, run, first, lastName));
                }
            }
        }
        return totalRuns;
    }

    private Address addrOf(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }
}
