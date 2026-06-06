import { readFileSync } from 'fs';
type Frame = { dir:'IN'|'OUT', t:number, fn:number, sub:number, len:number, hex:string };
const load=(p:string):Frame[]=>JSON.parse(readFileSync(p,'utf8'));
const bytes=(h:string)=>h.trim().split(/\s+/).map(x=>parseInt(x,16));
const le=(lo:number,hi:number)=>lo|(hi<<7);

const enumF=load('C:/dev/mcp-midi-tools/samples/captured/decoded/fm9-enum-label-sweep-harp-2026-06-04.frames.json');
const recvF=load('C:/dev/mcp-midi-tools/samples/captured/decoded/fm9-receive-preset-from-device-harp-2026-06-04.frames.json');

// Where do IN sub=0x1a responses echo eff/pid? print raw byte indices for a known pair
const inA=enumF.filter(f=>f.fn===0x01&&f.sub===0x1a&&f.dir==='IN');
console.log('=== sub=0x1a IN raw bytes (effId=58, pid varies) ===');
for(const f of inA.slice(0,3)){
  const b=bytes(f.hex);
  console.log(`len=${f.len} bytes6-15=[${b.slice(6,16).join(',')}] eff@8,9=${le(b[8],b[9])} pid@10,11=${le(b[10],b[11])}`);
}

// adversarial: do ANY sub=0x1a IN responses contain >=4 letter ascii runs?
let labelHits=0;
for(const f of inA){
  const b=bytes(f.hex);
  let s='';for(const x of b)s+=(x>=0x20&&x<=0x7e)?String.fromCharCode(x):'.';
  const w=s.match(/[A-Za-z]{4,}/g);
  if(w&&w.length){labelHits++; if(labelHits<=5)console.log('LABEL-LIKE:',JSON.stringify(w),'in',s);}
}
console.log('sub=0x1a IN responses with >=4-letter ascii runs:',labelHits,'/',inA.length);

// Contrast: which sub DOES carry label strings? scan all enum IN frames for letter runs
console.log('\n=== which fn/sub IN frames carry readable text (>=4 letters) ===');
const cnt=new Map<string,number>();
for(const f of enumF){
  if(f.dir!=='IN')continue;
  const b=bytes(f.hex);
  let s='';for(const x of b)s+=(x>=0x20&&x<=0x7e)?String.fromCharCode(x):'.';
  const w=s.match(/[A-Za-z]{4,}/g);
  if(w&&w.length){const k=`fn=0x${f.fn.toString(16)} sub=0x${f.sub.toString(16)}`;cnt.set(k,(cnt.get(k)||0)+1);}
}
for(const [k,v] of cnt)console.log(k,'text-frames='+v);

// === RECV capture opcodes ===
console.log('\n=== recv fn/sub histogram ===');
const rh=new Map<string,{IN:number,OUT:number}>();
for(const f of recvF){const k=`fn=0x${f.fn.toString(16)} sub=0x${f.sub.toString(16)}`;if(!rh.has(k))rh.set(k,{IN:0,OUT:0});rh.get(k)![f.dir]++;}
const want=[0x43,0x51,0x52,0x19,0x7a,0x7b,0x7c];
for(const [k,v] of rh)console.log(k,'OUT='+v.OUT,'IN='+v.IN);

console.log('\n=== claimed recv opcodes present? (by fn) ===');
for(const fn of want){
  const has=recvF.some(f=>f.fn===fn);
  const dirs=recvF.filter(f=>f.fn===fn).map(f=>f.dir);
  console.log(`fn=0x${fn.toString(16)} present=${has} count=${dirs.length} dirs=${[...new Set(dirs)]}`);
}
