import { readFileSync } from 'fs';
type Frame = { dir:'IN'|'OUT', t:number, fn:number, sub:number, len:number, hex:string };
const load=(p:string):Frame[]=>JSON.parse(readFileSync(p,'utf8'));
const recvF=load('C:/dev/mcp-midi-tools/samples/captured/decoded/fm9-receive-preset-from-device-harp-2026-06-04.frames.json');

// find first fn=0x19 OUT and show the window of frames around it (temporal interleave)
const idx19 = recvF.findIndex(f=>f.fn===0x19);
console.log('first fn=0x19 at index',idx19,'t=',recvF[idx19].t);
console.log('window [idx-1 .. idx+10]:');
for(let i=Math.max(0,idx19-1);i<Math.min(recvF.length,idx19+11);i++){
  const f=recvF[i];
  console.log(`  [${i}] ${f.dir} fn=0x${f.fn.toString(16)} sub=0x${f.sub.toString(16)} len=${f.len} t=${f.t}`);
}

// Confirm 0x7b/0x7c are sub=0 stream frames that flow after a 0x19. Are there 0x7b before any 0x19?
const first7b=recvF.findIndex(f=>f.fn===0x7b);
const first7c=recvF.findIndex(f=>f.fn===0x7c);
console.log('\nfirst 0x7b idx',first7b,'first 0x7c idx',first7c,'first 0x19 idx',idx19);
console.log('0x7b/0x7c appear AFTER first 0x19:', first7b>idx19, first7c>idx19);

// 0x43 trigger + 0x51/0x52 edit-buffer dump temporal
const idx43=recvF.findIndex(f=>f.fn===0x43);
console.log('\nfn=0x43 at idx',idx43,'window:');
for(let i=idx43;i<Math.min(recvF.length,idx43+6);i++){
  const f=recvF[i];console.log(`  [${i}] ${f.dir} fn=0x${f.fn.toString(16)} sub=0x${f.sub.toString(16)} len=${f.len}`);
}
