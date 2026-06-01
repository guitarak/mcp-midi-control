// probe-am4-find-power-tube-type.ts — locate the AM4 register driving the
// "Power Tube Type" dropdown by its distinctive parked value. The operator set
// Power Tube Type to TRANSISTOR (the last option, index 25), so the register
// behind it reads raw 25. amp.tubes (0x0095) was ruled out (read 0). Scan the
// amp pidHigh range (pidLow 0x003a) reading the RAW uint32 and flag any == 25.
//
// Read-only. Usage: npx tsx scripts/_research/probe-am4-find-power-tube-type.ts

import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { sendReadAndParseRaw } from '@mcp-midi-control/am4/shared/readOps.js';

const PID_LOW = 0x003a;        // amp block
const FROM = 0x40;
const TO = 0xb0;
const TARGET = 25;             // TRANSISTOR index (parked)

async function main(): Promise<void> {
  const conn = connectAM4();
  console.log(`Scanning amp registers pidLow=0x3a, pidHigh 0x${FROM.toString(16)}..0x${TO.toString(16)} for raw==${TARGET} (TRANSISTOR):\n`);
  const hits: number[] = [];
  for (let ph = FROM; ph <= TO; ph++) {
    try {
      const { parsed } = await sendReadAndParseRaw(conn, PID_LOW, ph);
      const u32 = parsed.asUInt32LE();
      if (u32 === TARGET) {
        hits.push(ph);
        console.log(`  pidHigh 0x${ph.toString(16).padStart(2, '0')}: raw=${u32}   *** == ${TARGET} (likely Power Tube Type) ***`);
      } else if (u32 > 0 && u32 < 64) {
        // print small non-zero values too (enum-index-shaped) for context
        console.log(`  pidHigh 0x${ph.toString(16).padStart(2, '0')}: raw=${u32}`);
      }
    } catch {
      // unresponsive pidHigh — skip
    }
  }
  conn.close();
  console.log(`\nHits at raw==${TARGET}: ${hits.length ? hits.map((h) => '0x' + h.toString(16)).join(', ') : 'NONE (widen range or Power Tube Type may not be set to TRANSISTOR)'}`);
}

void main();
