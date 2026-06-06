const m=require('./fm9-enum-decode.cjs');

function bulkArrival(f,startIdx){
  let i=startIdx+1; while(i<f.length&&f[i].fn!==116)i++;
  if(i>=f.length)return null;
  const hdr=m.parseHex(f[i].hex); const eff=hdr[6]|(hdr[7]<<7);
  const itemCount=hdr[8]|(hdr[9]<<7); i++;
  const vals=[];
  while(i<f.length&&f[i].fn===117){
    const b=m.parseHex(f[i].hex); const end=f[i].len-2;
    for(let j=8;j+3<=end;j+=3) vals.push(b[j]|(b[j+1]<<7)|(b[j+2]<<14));
    i++;
  }
  return {eff,itemCount,vals,endIdx:i};
}

// Walk a file in order. Maintain "current value name" per (eff,pid) from label polls.
// When a bulk read for eff appears, snapshot val[pid] paired with the most-recent
// name seen for (eff,pid). Emit pairs.
function pairFile(fileName, targets){
  const f=m.load(fileName);
  const lastName={}; // eff:pid -> name
  const pairs=[]; // {eff,pid,name,ordinal,labelIdx,bulkIdx}
  // Pre-index bulk read positions
  for(let i=0;i<f.length;i++){
    const fr=f[i];
    if(fr.fn===1 && fr.sub===26 && fr.dir==='IN'){
      const d=m.decodeLabel(fr);
      lastName[d.eff+':'+d.pid]={name:d.name,idx:i};
    }
    if(fr.fn===31 && fr.dir==='OUT'){
      const d=bulkArrival(f,i);
      if(!d)continue;
      for(const pid of targets){
        const key=d.eff+':'+pid;
        const ln=lastName[key];
        if(ln && d.vals[pid]!==undefined){
          pairs.push({eff:d.eff,pid,name:ln.name,ordinal:d.vals[pid],labelIdx:ln.idx,bulkIdx:i,fwd:false});
        }
      }
    }
  }
  // Also do a FORWARD pass: for bulk reads, find the NEXT label poll (in case label is polled after the bulk)
  const nextName={};
  for(let i=f.length-1;i>=0;i--){
    const fr=f[i];
    if(fr.fn===1 && fr.sub===26 && fr.dir==='IN'){
      const d=m.decodeLabel(fr);
      nextName[d.eff+':'+d.pid]={name:d.name,idx:i};
    }
    if(fr.fn===31 && fr.dir==='OUT'){
      const d=bulkArrival(f,i);
      if(!d)continue;
      for(const pid of targets){
        const key=d.eff+':'+pid;
        const nn=nextName[key];
        if(nn && d.vals[pid]!==undefined){
          pairs.push({eff:d.eff,pid,name:nn.name,ordinal:d.vals[pid],labelIdx:nn.idx,bulkIdx:i,fwd:true});
        }
      }
    }
  }
  return pairs;
}
module.exports={bulkArrival,pairFile};
