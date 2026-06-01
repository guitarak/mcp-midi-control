// ProbeBlockLayout.java — diagnostic
//
// Lists every memory block (initialized + uninitialized, execute or not)
// and for each block reports its byte size and whether it contains the
// literal bytes "SET_PARAM\0" or "GET_PARAM\0".

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressSpace;
import ghidra.program.model.listing.Program;
import ghidra.program.model.mem.Memory;
import ghidra.program.model.mem.MemoryBlock;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.util.*;

public class ProbeBlockLayout extends GhidraScript {

    @Override
    public void run() throws Exception {
        Program program = currentProgram;
        Memory mem = program.getMemory();

        String progName = program.getName();
        String slug = progName.replaceFirst("(?i)\\.exe$", "").toLowerCase().replace(' ', '-');
        String outPath = "samples\\captured\\decoded\\"
            + "ghidra-" + slug + "-block-layout.txt";

        List<String> lines = new ArrayList<>();
        Runnable empty = () -> {};
        java.util.function.Consumer<String> w = s -> { lines.add(s); println(s); };

        w.accept("================================================================================");
        w.accept("ProbeBlockLayout.java");
        w.accept("  Program: " + progName);
        w.accept("  Output:  " + outPath);
        w.accept("================================================================================");
        w.accept("");

        byte[][] needles = new byte[][] {
            "SET_PARAM\0".getBytes(java.nio.charset.StandardCharsets.US_ASCII),
            "GET_PARAM\0".getBytes(java.nio.charset.StandardCharsets.US_ASCII),
            "SET_ALL1\0".getBytes(java.nio.charset.StandardCharsets.US_ASCII),
            "MIDI_ERROR_BAD_ARGUMENT\0".getBytes(java.nio.charset.StandardCharsets.US_ASCII),
            "SYSEX_INFO\0".getBytes(java.nio.charset.StandardCharsets.US_ASCII),
        };
        String[] needleNames = { "SET_PARAM", "GET_PARAM", "SET_ALL1", "MIDI_ERROR_BAD_ARGUMENT", "SYSEX_INFO" };

        int blockIdx = 0;
        for (MemoryBlock block : mem.getBlocks()) {
            blockIdx++;
            String name = block.getName();
            long start = block.getStart().getOffset();
            long end   = block.getEnd().getOffset();
            long size  = end - start + 1;
            boolean init = block.isInitialized();
            boolean exec = block.isExecute();
            boolean read = block.isRead();
            boolean write = block.isWrite();
            w.accept(String.format("[%2d] %-20s 0x%08x..0x%08x  size=0x%x  init=%s exec=%s r=%s w=%s",
                blockIdx, name, start, end, size,
                init, exec, read, write));

            if (!init) {
                w.accept("        (uninitialized — skipping byte scan)");
                continue;
            }
            int len = (int) Math.min(size, 0x40000000);
            byte[] buf;
            try {
                buf = new byte[len];
                mem.getBytes(block.getStart(), buf, 0, len);
            } catch (Exception e) {
                w.accept("        (mem.getBytes failed: " + e.getMessage() + ")");
                continue;
            }

            // Scan for each needle.
            for (int n = 0; n < needles.length; n++) {
                byte[] needle = needles[n];
                int hit = indexOf(buf, needle);
                if (hit >= 0) {
                    w.accept(String.format("        FOUND %s @ 0x%08x",
                        needleNames[n], start + hit));
                }
            }
        }

        w.accept("");
        w.accept("Total blocks: " + blockIdx);

        try (PrintWriter out = new PrintWriter(new FileWriter(outPath))) {
            for (String l : lines) out.println(l);
        }
        println("Wrote " + lines.size() + " lines to " + outPath);
    }

    private int indexOf(byte[] hay, byte[] needle) {
        outer:
        for (int i = 0; i <= hay.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) continue outer;
            }
            return i;
        }
        return -1;
    }
}
