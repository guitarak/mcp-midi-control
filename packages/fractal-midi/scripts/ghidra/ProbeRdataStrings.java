// ProbeRdataStrings.java — diagnostic
//
// Find the .rdata block, then walk it byte by byte looking for ASCII
// strings (sequences of [A-Za-z0-9_] terminated by NUL, length >= 4)
// that start with S or G. Print every such string and its address.
//
// Goal: confirm raw-scan works on this binary's memory image, and
// figure out where my Pass B in DumpFractalEditorOpcodeTable64 is
// going wrong.

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;

import java.util.*;

public class ProbeRdataStrings extends GhidraScript {

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        Memory mem = program.getMemory();

        MemoryBlock rdata = null;
        for (MemoryBlock block : mem.getBlocks()) {
            if (block.getName().equals(".rdata")) { rdata = block; break; }
        }
        if (rdata == null) {
            println("no .rdata block found");
            return;
        }
        long blockStart = rdata.getStart().getOffset();
        long blockEnd   = rdata.getEnd().getOffset();
        long size       = blockEnd - blockStart + 1;
        println(".rdata: 0x" + Long.toHexString(blockStart) + " size 0x" + Long.toHexString(size));

        int len = (int) Math.min(size, 0x40000000);
        byte[] buf = new byte[len];
        mem.getBytes(rdata.getStart(), buf, 0, len);
        println("read " + len + " bytes");

        int hits = 0;
        int i = 0;
        Map<String, Integer> prefixCounts = new TreeMap<>();
        while (i < len) {
            int c = buf[i] & 0xFF;
            if (c != 'S' && c != 'G' && c != 'M' && c != 'O' && c != 'F') { i++; continue; }
            int j = i;
            while (j < len) {
                int cj = buf[j] & 0xFF;
                if (cj == 0) break;
                if (!isStrChar(cj)) { j = -2; break; }
                j++;
            }
            if (j < 0 || j >= len) { i++; continue; }
            int slen = j - i;
            if (slen < 4) { i = j + 1; continue; }
            String text = new String(buf, i, slen, java.nio.charset.StandardCharsets.US_ASCII);
            // Match a few specific prefixes for counting.
            for (String p : new String[]{"SYSEX_", "GET_", "SET_", "OP_", "MIDI_", "FN_"}) {
                if (text.startsWith(p)) {
                    prefixCounts.merge(p, 1, Integer::sum);
                    if (hits < 40) {
                        println(String.format("  0x%08x  %s", blockStart + i, text));
                    }
                    hits++;
                    break;
                }
            }
            i = j + 1;
        }
        println("Total strings matching any prefix: " + hits);
        for (Map.Entry<String, Integer> e : prefixCounts.entrySet()) {
            println("  " + e.getKey() + "* " + e.getValue());
        }
    }

    private boolean isStrChar(int c) {
        if (c >= 'A' && c <= 'Z') return true;
        if (c >= 'a' && c <= 'z') return true;
        if (c >= '0' && c <= '9') return true;
        if (c == '_') return true;
        return false;
    }
}
