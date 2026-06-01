// DumpFooterHashCallContext.java — Ghidra GhidraScript
//
// BK-070: figure out which buffer + length FUN_00544cc0 hashes.
//
// The hash function is a trivial XOR-fold over a ushort buffer; the
// question is WHICH buffer + WHAT count. Args go via __fastcall:
//   ECX = buffer ptr
//   EDX = count
//
// We need the raw disasm of the call site in FUN_00512f30 to see how
// ECX/EDX are loaded. Also raw disasm of FUN_00620810 (the chunk
// reassembly routine) so we can correlate which struct field the
// growing buffer lives at.
//
// Output: samples/captured/decoded/ghidra-axeedit2-hash-call-ctx.txt
//
// @category AxeFxII

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionManager;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.symbol.Reference;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class DumpFooterHashCallContext extends GhidraScript {

    private static final String OUTPUT_PATH =
        "samples\\captured\\decoded\\ghidra-axeedit2-hash-call-ctx.txt";

    private static final long FN_DISPATCH = 0x00512f30L;
    private static final long FN_HASH     = 0x00544cc0L;
    private static final long FN_FOOTER   = 0x0054d1d0L;
    private static final long FN_CHUNK    = 0x0054d0c0L;
    private static final long FN_HEADER   = 0x0054d3d0L;
    private static final long FN_APPEND   = 0x00620810L; // reassembly append
    private static final long FN_SEPTET   = 0x0055d750L; // septet reader

    private final List<String> lines = new ArrayList<>();

    private void w(String s) { lines.add(s); println(s); }

    @Override
    public void run() throws Exception {
        FunctionManager funcMgr = currentProgram.getFunctionManager();
        Listing listing = currentProgram.getListing();
        AddressSpace as = currentProgram.getAddressFactory().getDefaultAddressSpace();

        w("================================================================================");
        w("DumpFooterHashCallContext.java");
        w("================================================================================");
        w("");

        // Find the call site to FN_HASH inside FN_DISPATCH and dump the
        // 15 instructions BEFORE and 5 instructions AFTER.
        Function disp = funcMgr.getFunctionAt(as.getAddress(FN_DISPATCH));
        if (disp == null) { w("dispatcher not found"); return; }

        w("Looking for CALL to FN_HASH (0x" + Long.toHexString(FN_HASH) + ") in dispatcher...");
        Address hashCallAt = null;
        List<Instruction> dispBody = new ArrayList<>();
        InstructionIterator it = listing.getInstructions(disp.getBody(), true);
        while (it.hasNext()) {
            Instruction ins = it.next();
            dispBody.add(ins);
            String mnem = ins.getMnemonicString();
            if (mnem.startsWith("CALL")) {
                for (Reference r : ins.getReferencesFrom()) {
                    if (r.getToAddress() != null && r.getToAddress().getOffset() == FN_HASH) {
                        hashCallAt = ins.getAddress();
                    }
                }
            }
        }
        w("hash call at: " + hashCallAt);
        w("");

        if (hashCallAt != null) {
            int callIdx = -1;
            for (int i = 0; i < dispBody.size(); i++) {
                if (dispBody.get(i).getAddress().equals(hashCallAt)) { callIdx = i; break; }
            }
            int start = Math.max(0, callIdx - 30);
            int end = Math.min(dispBody.size(), callIdx + 8);
            w("################################################################################");
            w("## DISPATCHER context around hash call");
            w("################################################################################");
            for (int i = start; i < end; i++) {
                Instruction ins = dispBody.get(i);
                String marker = i == callIdx ? "  >>>" : "     ";
                w(String.format("%s  %s  %s", marker, ins.getAddress(), ins.toString()));
            }
        }
        w("");

        // Also dump ALL CALL sites in the dispatcher with their target name
        // for orientation.
        w("################################################################################");
        w("## All CALL targets in FN_DISPATCH (orientation)");
        w("################################################################################");
        for (Instruction ins : dispBody) {
            if (ins.getMnemonicString().startsWith("CALL")) {
                StringBuilder tgts = new StringBuilder();
                for (Reference r : ins.getReferencesFrom()) {
                    if (r.getToAddress() != null) {
                        Function tgt = funcMgr.getFunctionAt(r.getToAddress());
                        tgts.append(r.getToAddress());
                        if (tgt != null) tgts.append(" (").append(tgt.getName()).append(")");
                        tgts.append("  ");
                    }
                }
                w(String.format("  %s  %-30s  %s", ins.getAddress(), ins.toString(), tgts));
            }
        }
        w("");

        // Find what writes to param_1+0x1c, +0x20, +0x44, +0x48, +0x54
        // to understand the buffer layout.
        w("################################################################################");
        w("## Memory accesses in FN_DISPATCH touching struct offsets +0x10..+0x60");
        w("################################################################################");
        for (Instruction ins : dispBody) {
            String s = ins.toString();
            // Look for memory accesses with displacement
            if (s.contains("+0x") || s.contains("dword ptr [E") || s.contains("word ptr [E")) {
                if (s.contains("0x1c") || s.contains("0x20") || s.contains("0x34") ||
                    s.contains("0x44") || s.contains("0x48") || s.contains("0x4a") ||
                    s.contains("0x4c") || s.contains("0x54") || s.contains("0x58") ||
                    s.contains("0x5c")) {
                    w(String.format("  %s  %s", ins.getAddress(), s));
                }
            }
        }
        w("");

        // Dump RAW disasm of the chunk parser FN_CHUNK (0x54d0c0).
        // We need to see what struct the decoded ushorts get appended into.
        w("################################################################################");
        w("## RAW DISASM of FN_CHUNK (0x78 parser) — to see where decoded ushorts land");
        w("################################################################################");
        Function chunk = funcMgr.getFunctionAt(as.getAddress(FN_CHUNK));
        if (chunk != null) {
            InstructionIterator it2 = listing.getInstructions(chunk.getBody(), true);
            int n = 0;
            while (it2.hasNext() && n < 200) {
                Instruction ins = it2.next();
                StringBuilder targets = new StringBuilder();
                for (Reference r : ins.getReferencesFrom()) {
                    if (r.getToAddress() != null) {
                        Function tgt = funcMgr.getFunctionAt(r.getToAddress());
                        if (tgt != null) targets.append(" → ").append(tgt.getName());
                    }
                }
                w(String.format("  %s  %-30s%s", ins.getAddress(), ins.toString(), targets));
                n++;
            }
        }
        w("");

        // Dump RAW disasm of FN_APPEND (the reassembly routine).
        w("################################################################################");
        w("## RAW DISASM of FN_APPEND (chunk reassembly buffer append)");
        w("################################################################################");
        Function app = funcMgr.getFunctionAt(as.getAddress(FN_APPEND));
        if (app != null) {
            InstructionIterator it3 = listing.getInstructions(app.getBody(), true);
            int n = 0;
            while (it3.hasNext() && n < 150) {
                Instruction ins = it3.next();
                StringBuilder targets = new StringBuilder();
                for (Reference r : ins.getReferencesFrom()) {
                    if (r.getToAddress() != null) {
                        Function tgt = funcMgr.getFunctionAt(r.getToAddress());
                        if (tgt != null) targets.append(" → ").append(tgt.getName());
                    }
                }
                w(String.format("  %s  %-30s%s", ins.getAddress(), ins.toString(), targets));
                n++;
            }
        }

        try (PrintWriter out = new PrintWriter(new FileWriter(OUTPUT_PATH))) {
            for (String l : lines) out.println(l);
        }
        w("Wrote " + lines.size() + " lines to " + OUTPUT_PATH);
    }
}
