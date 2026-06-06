import { readFileSync } from 'node:fs';
type Frame = { dir: string; hex: string };
const f='C:/dev/mcp-midi-tools/samples/captured/decoded/fm9-receive-preset-from-device-harp-2026-06-04.frames.json';
const frames:Frame[]=JSON.parse(readFileSync(f,'utf8'));
// grab a short fn=0x03 frame, manually recompute step by step
const fr=frames.find(x=>{const b=x.hex.trim().split(/\s+/).map(h=>parseInt(h,16));return b[5]===0x03;})!;
const b=fr.hex.trim().split(/\s+/).map(h=>parseInt(h,16));
console.log('frame hex:', fr.hex);
console.log('len bytes:', b.length);
console.log('last byte (must be f7):', b[b.length-1].toString(16));
console.log('checksum byte (b[last-1]):', b[b.length-2]);
let x=0; const range=[];
for(let i=0;i<=b.length-3;i++){x^=b[i];range.push(i);}
console.log('xor f0..lastPayload =', x, 'masked=', x&0x7f);
console.log('match:', (x&0x7f)===b[b.length-2]);
// Also confirm a 0x77 frame
const fr77=frames.find(x=>{const bb=x.hex.trim().split(/\s+/).map(h=>parseInt(h,16));return bb[5]===0x77;})!;
console.log('\n0x77:', fr77.hex);
