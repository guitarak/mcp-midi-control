/** Quick AM4 liveness check via direct node-midi (read-only). */
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { buildGetAllParams } from 'fractal-midi/am4';

async function main(): Promise<void> {
  const conn = connectAM4();
  await new Promise((r) => setTimeout(r, 150));
  let got = false;
  conn.onMessage((b: number[]) => {
    got = true;
    console.log('AM4 inbound:', b.slice(0, 14).map((x) => x.toString(16).padStart(2, '0')).join(' '), `(len ${b.length})`);
  });
  for (const effId of [1, 2, 5]) {
    try { conn.send(buildGetAllParams(effId)); } catch (e) { console.log(`buildGetAllParams(${effId}) err: ${(e as Error).message}`); }
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 400));
  console.log(got ? 'AM4 RESPONDED (real hardware reachable)' : 'AM4 SILENT (no response)');
  process.exit(0);
}
main();
