// AssociateAxeEditIIIFnByteWithName.java — Ghidra GhidraScript
//
// We have:
//   - 23 SYSEX_* strings in .rdata at known addresses.
//   - 27 distinct fn-byte literals passed to the generic SysEx builder
//     FUN_1403437d0 (and FUN_1403434b0) by ~25 caller functions.
//
// We want:  fn_byte → SYSEX_* name mapping.
//
// Strategy:
//   For each caller of FUN_1403437d0 / FUN_1403434b0, walk every instruction
//   in the caller's body and the bodies of its DIRECT callers (1 level up).
//   For each instruction, check whether any operand resolves to one of the
//   23 SYSEX_* string addresses. If yes, that string is a strong candidate
//   for the SYSEX_*-name of the fn-byte the caller passes.
//
//   This catches the common pattern where AxeEdit logs "Sending
//   SYSEX_FOO with payload..." before invoking the SysEx builder.
//
// Output: samples/captured/decoded/ghidra-axe-edit-iii-fnbyte-name-map.txt
//
// @category AxeFxIII

import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.decompiler.DecompiledFunction;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.scalar.Scalar;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceManager;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class AssociateAxeEditIIIFnByteWithName extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axe-edit-iii-fnbyte-name-map.txt";

    // The 23 SYSEX_* string anchor addresses + names.
    private static final long[][] SYSEX_STRINGS = {
        { 0x1405abf80L }, // SYSEX_A3_TUNER
        { 0x1405abf90L }, // SYSEX_A3_TEMPO
        { 0x1405abfa0L }, // SYSEX_SETGET_LOOPER          [v1.4: 0x0F]
        { 0x1405abfb8L }, // SYSEX_GET_SCENENAME          [v1.4: 0x0E]
        { 0x1405abfd0L }, // SYSEX_FS_PASSTHRU_MESSAGE
        { 0x1405abff8L }, // SYSEX_SETGET_TEMPO           [v1.4: 0x14]
        { 0x1405ac010L }, // SYSEX_PATCH_STATUS           [v1.4: 0x13]
        { 0x1405ac028L }, // SYSEX_GUI_CONTROL
        { 0x1405ac048L }, // SYSEX_FS_MESSAGE
        { 0x1405ac070L }, // SYSEX_DSP_MESSAGE
        { 0x1405ac0b8L }, // SYSEX_GET_PATCHNAME          [v1.4: 0x0D]
        { 0x1405ac0d0L }, // SYSEX_SETGET_SCENE           [v1.4: 0x0C]
        { 0x1405ac0e8L }, // SYSEX_SETGET_CHANNEL         [v1.4: 0x0B]
        { 0x1405ac100L }, // SYSEX_SETGET_BYPASS          [v1.4: 0x0A]
        { 0x1405ac150L }, // SYSEX_FOOTSWITCH_END
        { 0x1405ac1c0L }, // SYSEX_A3_SYSTEM_DATA_START
        { 0x1405ac1e0L }, // SYSEX_SYSTEM_DUMP
        { 0x1405ac200L }, // SYSEX_FOOTSWITCH_DUMP
        { 0x1405ac218L }, // SYSEX_EFFECT_DUMP
        { 0x1405ac238L }, // SYSEX_FOOTSWITCH_DATA
        { 0x1405ac250L }, // SYSEX_FOOTSWITCH_START
        { 0x1405ac268L }, // SYSEX_A3_SYSTEM_DATA_END
        { 0x1405ac298L }, // SYSEX_A3_SYSTEM_DATA
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

    // Caller functions and the fn byte each passes, recovered by
    // scripts/_research/parse-axeedit3-fnbyte-callers.ts.
    private static final long[][] FN_CALLERS = {
        { 0x1401a1a20L, 0x77 },
        { 0x14033db70L, 0xFF },
        { 0x1401d6f10L, 0x77 },
        { 0x140328a10L, 0x5A },
        { 0x140328a10L, 0x5C },
        { 0x140335000L, 0x7B },
        { 0x140335370L, 0x7C },
        { 0x1403359b0L, 0x5B },
        { 0x140336060L, 0x7A },
        { 0x14033ba50L, 0x77 },
        { 0x140150400L, 0x47 },
        { 0x140150570L, 0x08 },
        { 0x14015d6f0L, 0x08 },
        { 0x14015d6f0L, 0x47 },
        { 0x14033ac00L, 0x79 },
        { 0x14033ae30L, 0x78 },
        { 0x140333350L, 0x46 },
        { 0x1401c0690L, 0x08 },
        { 0x1401c15d0L, 0x00 },
        { 0x1401c12f0L, 0x08 },
        { 0x1401e3fb0L, 0x12 },
        { 0x14033ec70L, 0x01 },
        { 0x140339ed0L, 0x1F },
        { 0x1401e7a70L, 0x76 },
        { 0x140338fb0L, 0x74 },
        { 0x140339c40L, 0x75 },
        { 0x14033c6e0L, 0x19 },
        { 0x14033bee0L, 0x03 },
        { 0x14033ce70L, 0x1A },
        { 0x140211fe0L, 0x1B },
        { 0x14021ce90L, 0x76 },
        { 0x14021e300L, 0x76 },
        { 0x140253360L, 0x12 },
        { 0x140337060L, 0x40 },
        { 0x140336dd0L, 0x3F },
        { 0x14014d400L, 0x04 },
    };

    private final List<String> lines = new ArrayList<>();
    private Listing listing;
    private Memory mem;
    private FunctionManager funcMgr;
    private ReferenceManager refMgr;
    private DecompInterface decomp;

    private void w(String s) {
        lines.add(s);
        println(s);
    }

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        listing = program.getListing();
        mem = program.getMemory();
        funcMgr = program.getFunctionManager();
        refMgr = program.getReferenceManager();
        decomp = new DecompInterface();
        decomp.openProgram(program);

        Map<Long, String> sysexByAddr = new TreeMap<>();
        for (int i = 0; i < SYSEX_STRINGS.length; i++) sysexByAddr.put(SYSEX_STRINGS[i][0], SYSEX_NAMES[i]);
        Set<Long> sysexAddrs = sysexByAddr.keySet();

        w("================================================================================");
        w("AssociateAxeEditIIIFnByteWithName.java");
        w("  Program:   " + program.getName());
        w("  Output:    " + OUTPUT_PATH);
        w("================================================================================");
        w("");
        w("Scanning each caller's body + 1-level parents for SYSEX_* string operands.");
        w("");

        // Pre-index every instruction operand-resolution to a SYSEX_* string.
        Map<Address, Set<String>> funcToSysexHits = new HashMap<>();
        InstructionIterator it = listing.getInstructions(true);
        int insScanned = 0;
        while (it.hasNext()) {
            Instruction ins = it.next();
            insScanned++;
            for (int op = 0; op < ins.getNumOperands(); op++) {
                for (Object o : ins.getOpObjects(op)) {
                    long addr = -1;
                    if (o instanceof Address) addr = ((Address) o).getOffset();
                    else if (o instanceof Scalar) addr = ((Scalar) o).getUnsignedValue();
                    if (addr <= 0) continue;
                    if (!sysexAddrs.contains(addr)) continue;
                    Function f = funcMgr.getFunctionContaining(ins.getAddress());
                    if (f == null) continue;
                    funcToSysexHits
                        .computeIfAbsent(f.getEntryPoint(), k -> new LinkedHashSet<>())
                        .add(sysexByAddr.get(addr));
                }
            }
            // Also Ghidra-resolved references
            for (Reference r : ins.getReferencesFrom()) {
                long toAddr = r.getToAddress().getOffset();
                if (!sysexAddrs.contains(toAddr)) continue;
                Function f = funcMgr.getFunctionContaining(ins.getAddress());
                if (f == null) continue;
                funcToSysexHits
                    .computeIfAbsent(f.getEntryPoint(), k -> new LinkedHashSet<>())
                    .add(sysexByAddr.get(toAddr));
            }
        }
        w("Instructions scanned: " + insScanned);
        w("Functions with SYSEX_* string refs: " + funcToSysexHits.size());
        w("");

        // Now visit each caller and look up its hits + its 1-level callers' hits.
        Map<Long, Set<String>> fnByteCandidates = new TreeMap<>();
        for (long[] row : FN_CALLERS) {
            long callerEntry = row[0];
            long fnByte = row[1];
            Function callerFn = funcMgr.getFunctionAt(addr(callerEntry));
            if (callerFn == null) {
                w("  ? caller " + hex(callerEntry) + " fn=" + hex(fnByte) + " — no function at this address");
                continue;
            }
            Set<String> direct = funcToSysexHits.getOrDefault(callerFn.getEntryPoint(), new LinkedHashSet<>());
            Set<String> parent = new LinkedHashSet<>();

            // 1-level parent: any function that CALLs callerFn.
            Set<Function> parents = new LinkedHashSet<>();
            for (Reference ref : refMgr.getReferencesTo(callerFn.getEntryPoint())) {
                if (!ref.getReferenceType().isCall()) continue;
                Function pf = funcMgr.getFunctionContaining(ref.getFromAddress());
                if (pf != null) parents.add(pf);
            }
            for (Function pf : parents) {
                Set<String> hits = funcToSysexHits.get(pf.getEntryPoint());
                if (hits != null) parent.addAll(hits);
            }

            Set<String> union = new LinkedHashSet<>(direct);
            union.addAll(parent);

            w(String.format("fn=0x%02x  caller=%s  @ %s  parents=%d",
                fnByte, callerFn.getName(), hex(callerEntry), parents.size()));
            w("    direct hits: " + (direct.isEmpty() ? "(none)" : direct));
            w("    parent hits: " + (parent.isEmpty() ? "(none)" : parent));
            w("    UNION:       " + (union.isEmpty() ? "(none)" : union));
            w("");

            // Track candidates for the final mapping.
            fnByteCandidates.computeIfAbsent(fnByte, k -> new LinkedHashSet<>()).addAll(union);
        }

        w("################################################################################");
        w("## fn_byte → candidate SYSEX_* name(s) summary");
        w("################################################################################");
        w("");
        for (var e : fnByteCandidates.entrySet()) {
            w(String.format("  0x%02X  %s", e.getKey(), e.getValue().isEmpty() ? "(no anchor found)" : e.getValue()));
        }
        w("");

        try (PrintWriter pw = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) pw.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }

    private Address addr(long off) {
        return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(off);
    }

    private String hex(long v) { return "0x" + Long.toHexString(v); }
}
