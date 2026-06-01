// FindAM4EditFirmwareEmitter.java - Ghidra GhidraScript
//
// HOP 4 Phase 1.5: locate the AM4-Edit firmware-update emitter and its
// bit-packing loop. The outer SysEx envelope of
// `samples/factory/AM4_firmware_v2p00.syx` decoded cleanly:
//
//   fn=0x7D  FIRMWARE_HEADER (1 frame, 5-byte payload `00 60 73 35 01`)
//   fn=0x7E  FIRMWARE_CHUNK  (7,096 frames, 482-byte payload each;
//                              first 2 bytes = septet-packed
//                              chunk-data-byte-count = 480; remaining
//                              480 bytes = packed firmware data)
//   fn=0x7F  FIRMWARE_FOOTER (1 frame, 5-byte payload `40 01 00 00 00`)
//
// The 3,406,080-byte concatenated packed payload is 7-bit clean (a
// MIDI requirement); the high bits of the actual firmware bytes are
// packed into the stream somehow. Five candidate unpacks tested in TS
// (msb-first-8to7, msb-first-reverse-bits, msb-last-8to7, 3-to-2
// ushort, no-unpack) all fail the ARM Cortex-M sanity check. The
// custom packing format lives in AM4-Edit's firmware-upload code path.
//
// Anchors to find the emitter:
//   (a) The 5-byte file magic `00 60 73 35 01` (header payload) is
//       almost certainly a compile-time constant somewhere in .rdata.
//       Locate it, walk xrefs back to the containing function.
//   (b) The 5-byte footer payload `40 01 00 00 00` is similarly
//       likely a constant. Less specific than (a) due to common-bytes
//       collisions; secondary anchor.
//   (c) The immediate value 0x7E used as an SysEx fn-byte. We search
//       for MOV/CMP/CALL instructions referencing 0x7E and filter to
//       call sites near the SysEx envelope builders identified by
//       MapAM4EditHostEmitters (4 builders at 0x14037aa20, 0x14037c310,
//       0x14037e670, 0x14037e950).
//   (d) The constant 480 (= 0x1E0) or its septet-encoding 0x60 0x03
//       used as a chunk-payload length. 480 is the unpacked-input size
//       to the packing loop.
//
// For each candidate emitter, the script extracts the body and looks
// for the packing pattern:
//   - A loop over the input data (typically 480 bytes per chunk)
//   - Bit operations: right-shift, left-shift, AND with 0x7F or 0x80
//   - Output buffer writes (often the SysEx envelope buffer)
//   - Inner-loop counter modulo 7 or 8 (the packing stride)
//
// Output:
//   %PROJECT_ROOT%\packages\fractal-midi\samples\captured\decoded\
//     ghidra-am4-edit-firmware-emitter.txt
//
// @category AM4

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.lang.OperandType;
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
import java.util.*;

public class FindAM4EditFirmwareEmitter extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-am4-edit-firmware-emitter.txt";

    private static final byte[] FIRMWARE_HEADER_MAGIC =
        { (byte) 0x00, (byte) 0x60, (byte) 0x73, (byte) 0x35, (byte) 0x01 };
    private static final byte[] FIRMWARE_FOOTER_MAGIC =
        { (byte) 0x40, (byte) 0x01, (byte) 0x00, (byte) 0x00, (byte) 0x00 };
    private static final byte[] SYSEX_ENVELOPE_PREFIX_7E =
        { (byte) 0xF0, (byte) 0x00, (byte) 0x01, (byte) 0x74, (byte) 0x15, (byte) 0x7E };
    private static final byte[] SYSEX_ENVELOPE_PREFIX_7D =
        { (byte) 0xF0, (byte) 0x00, (byte) 0x01, (byte) 0x74, (byte) 0x15, (byte) 0x7D };

    // SysEx builder addresses from MapAM4EditHostEmitters (commit
    // history search: "AM4 SysEx builders (from envelope-constant scan)").
    private static final long[] SYSEX_BUILDERS = {
        0x14037aa20L,
        0x14037c310L,
        0x14037e670L,
        0x14037e950L,
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
            println("FindAM4EditFirmwareEmitter");
            println("  Program:  " + program.getName());
            println("  Output:   " + OUTPUT_PATH);
            println("================================================================================");

            out.println("================================================================================");
            out.println("FindAM4EditFirmwareEmitter");
            out.println("  Program:  " + program.getName());
            out.println("  Image base: 0x" + Long.toHexString(program.getImageBase().getOffset()));
            out.println("================================================================================");
            out.println();

            // --- Anchor A: search for 5-byte header magic `00 60 73 35 01` ----
            out.println("################################################################################");
            out.println("## ANCHOR A: firmware header magic `00 60 73 35 01`");
            out.println("################################################################################");
            out.println();
            List<Address> headerMagicHits = scanMemoryForBytes(memory, FIRMWARE_HEADER_MAGIC);
            out.println("hits: " + headerMagicHits.size());
            for (Address a : headerMagicHits) {
                out.println("  @ " + a.toString());
                MemoryBlock blk = memory.getBlock(a);
                out.println("    block: " + (blk != null ? blk.getName() : "?"));
                printXrefsAndContainingFunction(out, a, refMgr, funcMgr);
            }
            out.println();

            // --- Anchor B: footer magic `40 01 00 00 00` ----
            out.println("################################################################################");
            out.println("## ANCHOR B: firmware footer magic `40 01 00 00 00`");
            out.println("## (5-byte hits — less specific; common-bytes; filter by location)");
            out.println("################################################################################");
            out.println();
            List<Address> footerHits = scanMemoryForBytes(memory, FIRMWARE_FOOTER_MAGIC);
            out.println("hits: " + footerHits.size());
            int footerLimit = Math.min(footerHits.size(), 30);
            for (int i = 0; i < footerLimit; i++) {
                Address a = footerHits.get(i);
                out.println("  @ " + a.toString());
                MemoryBlock blk = memory.getBlock(a);
                out.println("    block: " + (blk != null ? blk.getName() : "?"));
                if (refMgr.getReferenceCountTo(a) > 0) {
                    printXrefsAndContainingFunction(out, a, refMgr, funcMgr);
                }
            }
            if (footerHits.size() > footerLimit) {
                out.println("  ... (" + (footerHits.size() - footerLimit) + " more, omitted)");
            }
            out.println();

            // --- Anchor C: full SysEx envelope `F0 00 01 74 15 7E` ----
            out.println("################################################################################");
            out.println("## ANCHOR C: SysEx envelope `F0 00 01 74 15 7E` (chunk emitter envelope)");
            out.println("################################################################################");
            out.println();
            List<Address> envHits7e = scanMemoryForBytes(memory, SYSEX_ENVELOPE_PREFIX_7E);
            out.println("hits: " + envHits7e.size());
            for (Address a : envHits7e) {
                out.println("  @ " + a.toString());
                printXrefsAndContainingFunction(out, a, refMgr, funcMgr);
            }
            out.println();

            out.println("################################################################################");
            out.println("## ANCHOR C2: SysEx envelope `F0 00 01 74 15 7D` (header emitter envelope)");
            out.println("################################################################################");
            out.println();
            List<Address> envHits7d = scanMemoryForBytes(memory, SYSEX_ENVELOPE_PREFIX_7D);
            out.println("hits: " + envHits7d.size());
            for (Address a : envHits7d) {
                out.println("  @ " + a.toString());
                printXrefsAndContainingFunction(out, a, refMgr, funcMgr);
            }
            out.println();

            // --- Anchor D: callers of the 4 mined SysEx envelope builders
            out.println("################################################################################");
            out.println("## ANCHOR D: callers of mined SysEx envelope builders");
            out.println("## (per ghidra-am4-edit-host-emitter-map.txt 'AM4 SysEx builders' line)");
            out.println("################################################################################");
            out.println();
            for (long builderOff : SYSEX_BUILDERS) {
                Address builderAddr = toAddr(builderOff);
                Function builder = funcMgr.getFunctionAt(builderAddr);
                out.println("builder @ " + builderAddr +
                    "  name=" + (builder != null ? builder.getName() : "?"));
                ReferenceManager rm = program.getReferenceManager();
                Set<Function> distinctCallers = new TreeSet<>(Comparator.comparing(
                    f -> f.getEntryPoint().getOffset()));
                int refCount = 0;
                for (Reference r : rm.getReferencesTo(builderAddr)) {
                    refCount++;
                    Function caller = funcMgr.getFunctionContaining(r.getFromAddress());
                    if (caller != null) distinctCallers.add(caller);
                }
                out.println("  references-to: " + refCount + "  distinct callers: " +
                    distinctCallers.size());

                // For each distinct caller, scan its instruction stream for
                // immediate values 0x7D / 0x7E / 0x7F (firmware fn-bytes).
                // Note: AM4-Edit also references 0x7F in non-firmware
                // contexts (e.g. it's used as a sentinel in the preset
                // header per SYSEX-MAP §10b). 0x7E is more specific.
                int firmwareCallers = 0;
                for (Function c : distinctCallers) {
                    int[] sigs = scanFunctionForFirmwareSigs(c, listing);
                    if (sigs[1] > 0 || sigs[0] > 0) {
                        firmwareCallers++;
                        out.println("    >>> caller " + c.getName() + " @ " + c.getEntryPoint() +
                            "   imm_7d=" + sigs[0] + "  imm_7e=" + sigs[1] +
                            "  imm_7f=" + sigs[2] + "  imm_480=" + sigs[3]);
                    }
                }
                out.println("  callers with fn=0x7D or 0x7E hits: " + firmwareCallers);
                out.println();
            }

            // --- Decompile any function that appears as a likely emitter
            out.println("################################################################################");
            out.println("## DECOMPILES — likely firmware emitter candidates");
            out.println("################################################################################");
            out.println();

            // Gather candidate functions: those identified by ANY of the
            // anchors above. We prioritize (a) header-magic xref function
            // (most specific), (b) functions calling SysEx builders with
            // 0x7D or 0x7E immediates, (c) functions containing the
            // packing-stride constant 480.
            Set<Function> candidates = new LinkedHashSet<>();

            // Header magic xref → containing function
            for (Address a : headerMagicHits) {
                for (Reference r : refMgr.getReferencesTo(a)) {
                    Function c = funcMgr.getFunctionContaining(r.getFromAddress());
                    if (c != null) candidates.add(c);
                }
            }

            // Callers of SysEx builders that use 0x7E immediate
            for (long builderOff : SYSEX_BUILDERS) {
                Address builderAddr = toAddr(builderOff);
                for (Reference r : refMgr.getReferencesTo(builderAddr)) {
                    Function caller = funcMgr.getFunctionContaining(r.getFromAddress());
                    if (caller == null) continue;
                    int[] sigs = scanFunctionForFirmwareSigs(caller, listing);
                    if (sigs[1] > 0 || sigs[0] > 0) {
                        candidates.add(caller);
                    }
                }
            }

            out.println("candidate count: " + candidates.size());
            out.println();

            DecompInterface decomp = new DecompInterface();
            decomp.openProgram(program);

            int limit = Math.min(candidates.size(), 12);
            int idx = 0;
            for (Function f : candidates) {
                if (idx++ >= limit) break;
                out.println("================================================================================");
                out.println("## " + f.getName() + " @ " + f.getEntryPoint());
                out.println("================================================================================");
                int[] sigs = scanFunctionForFirmwareSigs(f, listing);
                out.println("   firmware-sig counts: imm_7d=" + sigs[0] +
                    "  imm_7e=" + sigs[1] +
                    "  imm_7f=" + sigs[2] +
                    "  imm_480(0x1E0)=" + sigs[3] +
                    "  imm_7f-mask=" + sigs[4] +
                    "  imm_80=" + sigs[5]);
                out.println("   body size: " + f.getBody().getNumAddresses() + " addresses");
                DecompileResults results = decomp.decompileFunction(f, 60, monitor);
                if (results.decompileCompleted()) {
                    DecompiledFunction dec = results.getDecompiledFunction();
                    String code = dec.getC();
                    // Cap at 400 lines per function to keep output manageable.
                    String[] lines = code.split("\n");
                    int cap = Math.min(lines.length, 400);
                    for (int i = 0; i < cap; i++) {
                        out.println("   " + lines[i]);
                    }
                    if (lines.length > cap) {
                        out.println("   ... (" + (lines.length - cap) + " more lines)");
                    }
                } else {
                    out.println("   (decompile failed: " + results.getErrorMessage() + ")");
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

    /**
     * Scan the program memory for a specific byte sequence; return all
     * matches (any block, any permission set).
     */
    private List<Address> scanMemoryForBytes(Memory memory, byte[] pattern) {
        List<Address> hits = new ArrayList<>();
        AddressSetView searchable = memory.getLoadedAndInitializedAddressSet();
        Address start = searchable.getMinAddress();
        Address end = searchable.getMaxAddress();
        Address cur = start;
        while (cur != null && cur.compareTo(end) <= 0) {
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

    private void printXrefsAndContainingFunction(PrintWriter out, Address dataAddr,
            ReferenceManager refMgr, FunctionManager funcMgr) {
        List<Reference> refs = new ArrayList<>();
        for (Reference r : refMgr.getReferencesTo(dataAddr)) refs.add(r);
        out.println("    xrefs: " + refs.size());
        int shown = 0;
        for (Reference r : refs) {
            if (shown++ >= 8) {
                out.println("    ... (" + (refs.size() - shown + 1) + " more)");
                break;
            }
            Address from = r.getFromAddress();
            Function c = funcMgr.getFunctionContaining(from);
            out.println("      from " + from + (c != null ?
                "  in " + c.getName() + " @ " + c.getEntryPoint() : "  (not in a function)"));
        }
    }

    /**
     * Scan a function body for immediate values matching firmware-emitter
     * signature constants. Returns [imm_7D, imm_7E, imm_7F, imm_480,
     * imm_7F_mask, imm_80].
     */
    private int[] scanFunctionForFirmwareSigs(Function f, Listing listing) {
        int imm7d = 0, imm7e = 0, imm7f = 0, imm480 = 0, imm7fMask = 0, imm80 = 0;
        InstructionIterator iter = listing.getInstructions(f.getBody(), true);
        while (iter.hasNext()) {
            Instruction insn = iter.next();
            int opCount = insn.getNumOperands();
            for (int op = 0; op < opCount; op++) {
                Object[] objs = insn.getOpObjects(op);
                for (Object o : objs) {
                    if (o instanceof Scalar) {
                        long v = ((Scalar) o).getValue();
                        if (v == 0x7d) imm7d++;
                        if (v == 0x7e) imm7e++;
                        if (v == 0x7f) imm7f++;
                        if (v == 480) imm480++;
                        if (v == 0x7f && opCount > 1) imm7fMask++; // 7F-mask used as bit mask
                        if (v == 0x80) imm80++;
                    }
                }
            }
        }
        return new int[] { imm7d, imm7e, imm7f, imm480, imm7fMask, imm80 };
    }
}
