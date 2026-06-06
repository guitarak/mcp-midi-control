import { readFileSync } from 'node:fs';
type Frame = { dir: string; hex: string };

function bytesOf(hex: string){ return hex.trim().split(/\s+/).map(h=>parseInt(h,16)); }
function check(hex:string){
  const b=bytesOf(hex); const last=b.length-1;
  const stored=b[last-1]; let x=0; for(let i=0;i<=last-2;i++) x^=b[i]; x&=0x7f;
  return {ok:x===stored,computed:x,stored,nbytes:b.length, startsF0:b[0]===0xf0, endsF7:b[last]===0xf7};
}

const f='C:/dev/mcp-midi-tools/samples/captured/decoded/fm9-receive-preset-from-device-harp-2026-06-04.frames.json';
const frames:Frame[]=JSON.parse(readFileSync(f,'utf8'));

// inspect every 0x78 that is NOT 3082, and count embedded f7 occurrences (merge artifact signal)
for(const fr of frames){
  const b=bytesOf(fr.hex); if(b[5]!==0x78) continue;
  if(b.length===3082) continue;
  const internalF7 = b.slice(1,b.length-1).filter(x=>x===0xf7).length;
  const internalF0 = b.slice(1).filter(x=>x===0xf0).length;
  const r=check(fr.hex);
  console.log(`0x78 len=${b.length} ok=${r.ok} stored=${r.stored} computed=${r.computed} internalF0=${internalF0} internalF7=${internalF7}`);
}

// 0x52 frames mentioned in claim
console.log('--- 0x52 ---');
for(const fr of frames){
  const b=bytesOf(fr.hex); if(b[5]!==0x52) continue;
  const r=check(fr.hex);
  const internalF7 = b.slice(1,b.length-1).filter(x=>x===0xf7).length;
  console.log(`0x52 len=${b.length} ok=${r.ok} stored=${r.stored} computed=${r.computed} internalF7=${internalF7}`);
}
