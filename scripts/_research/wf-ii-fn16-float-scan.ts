/**
 * wf-ii-fn16-float-scan.ts (READ-ONLY)
 * Brute-force: decode a sept5-LE float32 starting at every offset 0..20
 * in both payloads, to find where the "nice" floats actually align and
 * whether they bracket sensibly (min <= default <= max).
 */
const P0 = [0x10,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x12,0x1c,0x04,0x00,0x00,0x00,0x7c,0x03,0x00,0x00,0x00,0x00,0x00];
const P10= [0x41,0x10,0x00,0x00,0x00,0x2c,0x0b,0x1f,0x39,0x03,0x0a,0x2e,0x0f,0x61,0x03,0x00,0x48,0x50,0x4b,0x04,0x00,0x00,0x00,0x00,0x00];

function sept5u32(w:number[],o:number):number{
  return (((w[o]&0x7f)|((w[o+1]&0x7f)<<7)|((w[o+2]&0x7f)<<14)|((w[o+3]&0x7f)<<21))+(w[o+4]&0x7f)*0x10000000)>>>0;
}
function f32(u:number):number{const b=new ArrayBuffer(4);new DataView(b).setUint32(0,u>>>0,true);return new DataView(b).getFloat32(0,true);}
function sept5i(w:number[],o:number):number{ // signed-ish int read
  return ((w[o]&0x7f)|((w[o+1]&0x7f)<<7)|((w[o+2]&0x7f)<<14)|((w[o+3]&0x7f)<<21))+(w[o+4]&0x7f)*0x10000000;
}

for (const [name,p] of [['P0',P0],['P10',P10]] as Array<[string,number[]]>){
  console.log(`\n=== ${name} float32 at every 5-septet aligned offset ===`);
  for (let o=0;o+4<25;o+=5){
    const u=sept5u32(p,o); const f=f32(u); const iv=sept5i(p,o);
    console.log(`off ${String(o).padStart(2)}: u32=0x${u.toString(16).padStart(8,'0')}  int=${iv}  f32=${f}`);
  }
}
console.log('\nSanity: min<=default<=max must hold. Map fields accordingly.');
