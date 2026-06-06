const fs=require('fs');
const DIR='samples/captured/decoded/';
function parseHex(h){return h.trim().split(/\s+/).map(x=>parseInt(x,16));}
function septetUnpack(bytes){let acc=0,bits=0;const out=[];for(const b of bytes){acc=(acc<<7)|(b&0x7f);bits+=7;if(bits>=8){bits-=8;out.push((acc>>bits)&0xff);}}return out;}
function extractName(dec){let best='',cur='';for(let i=0;i<dec.length;i++){const c=dec[i];if(c>=32&&c<127)cur+=String.fromCharCode(c);else{if(cur.length>best.length)best=cur;cur='';}}if(cur.length>best.length)best=cur;return best.trim();}
function load(name){return JSON.parse(fs.readFileSync(DIR+name+'.frames.json','utf8'));}
// Decode the 0x75 bulk chain that follows a fn=31 OUT at startIdx.
function decodeBulkAt(f,startIdx){
  let i=startIdx+1;
  while(i<f.length && f[i].fn!==116) i++;
  if(i>=f.length) return null;
  const hdr=parseHex(f[i].hex); const eff=hdr[6]|(hdr[7]<<7); i++;
  const rec={};
  while(i<f.length && f[i].fn===117){
    const b=parseHex(f[i].hex);
    const off=b[6]; // low byte param index
    const payload=b.slice(8,f[i].len-2);
    for(let j=0;j+2<payload.length;j+=3){
      const v=payload[j]|(payload[j+1]<<7)|(payload[j+2]<<14);
      rec[off + j/3]=v;
    }
    i++;
  }
  return {eff,rec};
}
// Decode label poll IN response (fn=1 sub=26)
function decodeLabel(fr){
  const b=parseHex(fr.hex);
  const eff=b[8], pid=b[10];
  const dec=septetUnpack(b.slice(5,fr.len-2));
  return {eff,pid,name:extractName(dec),hdr:dec.slice(0,16)};
}
module.exports={parseHex,septetUnpack,extractName,load,decodeBulkAt,decodeLabel};
