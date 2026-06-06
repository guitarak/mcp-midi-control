import { readFileSync } from 'fs';

type Frame = { dir: 'IN'|'OUT', t:number, fn:number, sub:number, len:number, hex:string };

function load(p:string): Frame[] {
  return JSON.parse(readFileSync(p,'utf8'));
}

function bytes(hex:string): number[] {
  return hex.trim().split(/\s+/).map(h=>parseInt(h,16));
}

function le(lo:number,hi:number){return lo|(hi<<7);}
function checksumOk(b:number[]): boolean {
  // XOR f0..last payload (byte before f7), &0x7f == byte before f7
  if (b[b.length-1]!==0xf7) return false;
  const cksum = b[b.length-2];
  let x=0;
  for (let i=0;i<b.length-2;i++) x^=b[i];
  return (x&0x7f)===cksum;
}

const enumP = 'C:/dev/mcp-midi-tools/samples/captured/decoded/fm9-enum-label-sweep-harp-2026-06-04.frames.json';
const recvP = 'C:/dev/mcp-midi-tools/samples/captured/decoded/fm9-receive-preset-from-device-harp-2026-06-04.frames.json';

const enumF = load(enumP);
const recvF = load(recvP);

console.log('=== enum frames:', enumF.length, ' recv frames:', recvF.length);

// envelope sanity: confirm all hex start with f0 00 01 74 12
function envCheck(frames:Frame[], name:string){
  let bad=0, badck=0;
  for (const f of frames){
    const b=bytes(f.hex);
    if (!(b[0]===0xf0&&b[1]===0x00&&b[2]===0x01&&b[3]===0x74&&b[4]===0x12)) bad++;
    if (!checksumOk(b)) badck++;
  }
  console.log(`[${name}] envelope-mismatch=${bad} checksum-fail=${badck}`);
}
envCheck(enumF,'enum');
envCheck(recvF,'recv');

// fn/sub histogram for enum
function hist(frames:Frame[]){
  const m=new Map<string,{IN:number,OUT:number}>();
  for(const f of frames){
    const k=`fn=0x${f.fn.toString(16)} sub=0x${f.sub.toString(16)}`;
    if(!m.has(k)) m.set(k,{IN:0,OUT:0});
    m.get(k)![f.dir]++;
  }
  return m;
}
console.log('\n=== enum fn/sub histogram ===');
for(const [k,v] of hist(enumF)) console.log(k,'OUT='+v.OUT,'IN='+v.IN);

console.log('\n=== sub=0x1a OUT requests (first 12) ===');
const subA = enumF.filter(f=>f.fn===0x01 && f.sub===0x1a);
const outA = subA.filter(f=>f.dir==='OUT');
const inA = subA.filter(f=>f.dir==='IN');
console.log('sub=0x1a total:',subA.length,'OUT:',outA.length,'IN:',inA.length);
for(const f of outA.slice(0,12)){
  const b=bytes(f.hex);
  const eff=le(b[8],b[9]);
  const pid=le(b[10],b[11]);
  console.log(`OUT len=${f.len} effId(LE b8,b9=${b[8]},${b[9]})=${eff} paramId(LE b10,b11=${b[10]},${b[11]})=${pid}  bytes6-13=[${b.slice(6,14).join(',')}]`);
}

console.log('\n=== first few IN responses for sub=0x1a (len + ascii scan) ===');
function asciiScan(b:number[]):string{
  let s='';
  for(const x of b){ s += (x>=0x20&&x<=0x7e)?String.fromCharCode(x):'.'; }
  return s;
}
for(const f of inA.slice(0,6)){
  const b=bytes(f.hex);
  const eff=le(b[8],b[9]);
  const pid=le(b[10],b[11]);
  // count runs of >=4 printable ascii letters
  const txt=asciiScan(b);
  const wordRuns = txt.match(/[A-Za-z]{4,}/g)||[];
  console.log(`IN len=${f.len} echo effId=${eff} paramId=${pid} ascii="${txt}" words>=4=${JSON.stringify(wordRuns)}`);
}

// Check expected: effectId=58 for AMP with paramIds 10,36,98,43,31
console.log('\n=== AMP (effId=58) paramIds requested ===');
const ampReq = outA.filter(f=>{const b=bytes(f.hex);return le(b[8],b[9])===58;});
console.log('effId=58 OUT count:',ampReq.length);
const ampPids = ampReq.map(f=>{const b=bytes(f.hex);return le(b[10],b[11]);});
console.log('first 20 paramIds for effId=58:',ampPids.slice(0,20).join(','));
for(const want of [10,36,98,43,31]) console.log(`  paramId ${want} present:`, ampPids.includes(want));

