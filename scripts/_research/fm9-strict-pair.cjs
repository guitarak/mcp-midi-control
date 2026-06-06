const m=require('./fm9-enum-decode.cjs');
const {bulkArrival}=require('./fm9-pair-enum.cjs');
// For each file, for each bulk read, attach for every target pid the
// nearest label poll (eff,pid) within WINDOW indices (before OR after).
const WINDOW=60;
function run(fileName){
  const f=m.load(fileName);
  // collect label polls and bulk reads
  const labels=[]; // {idx,eff,pid,name}
  const bulks=[];  // {idx,eff,itemCount,vals}
  for(let i=0;i<f.length;i++){
    const fr=f[i];
    if(fr.fn===1&&fr.sub===26&&fr.dir==='IN'){const d=m.decodeLabel(fr);labels.push({idx:i,eff:d.eff,pid:d.pid,name:d.name});}
    if(fr.fn===31&&fr.dir==='OUT'){const d=bulkArrival(f,i);if(d)bulks.push({idx:i,eff:d.eff,itemCount:d.itemCount,vals:d.vals});}
  }
  const pairs=[];
  for(const b of bulks){
    // for each label within window of this bulk and same eff
    const cand=labels.filter(l=>l.eff===b.eff && Math.abs(l.idx-b.idx)<=WINDOW);
    // group by pid, pick nearest
    const byPid={};
    for(const l of cand){const dist=Math.abs(l.idx-b.idx);if(!byPid[l.pid]||dist<byPid[l.pid].dist)byPid[l.pid]={name:l.name,dist};}
    for(const pid of Object.keys(byPid)){
      const ord=b.vals[pid];
      if(ord!==undefined) pairs.push({eff:b.eff,pid:+pid,name:byPid[pid].name,ordinal:ord,bulkIdx:b.idx,dist:byPid[pid].dist});
    }
  }
  return pairs;
}
// aggregate across files, dedupe by eff:pid:name -> set of ordinals
const files=['fm9-capture3-enum-sweep-2026-06-03','fm9-enum-label-sweep-harp-2026-06-04','fm9-receive-preset-from-device-harp-2026-06-04'];
const agg={}; // key eff:pid -> {name -> {ord -> count}}
for(const fn of files){
  let pairs; try{pairs=run(fn);}catch(e){console.error(fn,e.message);continue;}
  for(const p of pairs){
    const k=p.eff+':'+p.pid;
    agg[k]=agg[k]||{};
    agg[k][p.name]=agg[k][p.name]||{};
    agg[k][p.name][p.ordinal]=(agg[k][p.name][p.ordinal]||0)+1;
  }
}
// print only TYPE-selector params: pid where names are non-numeric (model names)
const keys=Object.keys(agg).sort((a,b)=>{const[e1,p1]=a.split(':').map(Number);const[e2,p2]=b.split(':').map(Number);return e1-e2||p1-p2;});
for(const k of keys){
  const names=agg[k];
  // is this a type selector? name is non-numeric text
  const allNames=Object.keys(names);
  const isType=allNames.some(n=>n && !/^[-\d. %A-Za-z]*\d/.test(n) && /[A-Za-z]/.test(n) && !/^(OFF|ON|THRU|ENGAGED|BYPASSED|NORMAL|MUTE|h)/.test(n));
  console.log('--- eff='+k.split(':')[0]+' pid='+k.split(':')[1]+(isType?'  [TYPE?]':''));
  for(const n of allNames){
    const ords=Object.entries(names[n]).map(([o,c])=>o+'(x'+c+')').join(',');
    console.log('     "'+n+'" -> ordinal '+ords);
  }
}
