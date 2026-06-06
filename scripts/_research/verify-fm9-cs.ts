import { readFileSync } from 'node:fs';
const path = 'C:/dev/mcp-midi-tools/samples/captured/decoded/fm9-enum-label-sweep-harp-2026-06-04.frames.json';
const frames = JSON.parse(readFileSync(path,'utf8')) as Array<{dir:string;fn:number;sub:number;hex:string}>;
function hb(h:string){return h.trim().split(/\s+/).map(x=>parseInt(x,16));}
let n=0;
frames.forEach((f,i)=>{
  const b=hb(f.hex); let x=0; for(let k=0;k<b.length-2;k++)x^=b[k]; x&=0x7f;
  if(x!==b[b.length-2]){ n++; console.log(`CS FAIL frame#${i} fn=${f.fn} sub=${f.sub} dir=${f.dir} got=${b[b.length-2].toString(16)} calc=${x.toString(16)}`); }
});
console.log('total cs fails', n);
// verify frame#11 checksum passes (the Clean-bearing frame)
const b=hb(frames[11].hex); let x=0; for(let k=0;k<b.length-2;k++)x^=b[k]; x&=0x7f;
console.log('frame#11 cs ok:', x===b[b.length-2], 'first5:', b.slice(0,5).map(v=>v.toString(16)).join(' '));
