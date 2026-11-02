import fs from 'node:fs';
const KEY = fs.readFileSync('/home/dwizzy/.hermes/cache/scratch/zro-key.txt','utf8').trim();
const URL='http://127.0.0.1:8100/v1/chat/completions';
const combos=['ds41','ds0731','glm53'];
const prompt='Count from 1 to 20 in one line.';
async function one(i){
  const model=combos[i%combos.length];
  const t0=Date.now();
  try{
    const res=await fetch(URL,{method:'POST',headers:{Authorization:`Bearer ${KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model,stream:false,messages:[{role:'user',content:prompt}],max_tokens:96}),signal:AbortSignal.timeout(120000)});
    const ms=Date.now()-t0;
    const j=await res.json().catch(()=>null);
    if(!res.ok) return {ok:false,code:res.status,ms,toks:0,model};
    return {ok:true,code:200,ms,toks:j?.usage?.total_tokens||0,model};
  }catch(e){ return {ok:false,code:'ERR',ms:Date.now()-t0,toks:0,model,err:String(e.message).slice(0,40)}; }
}
for(const W of [32,64,96,128]){
  const t0=Date.now();
  const rs=await Promise.all(Array.from({length:W},(_,i)=>one(i)));
  const dur=(Date.now()-t0)/1000;
  const ok=rs.filter(r=>r.ok).length, fail=rs.filter(r=>!r.ok).length;
  const toks=rs.reduce((a,r)=>a+r.toks,0);
  const codes={}; rs.filter(r=>!r.ok).forEach(r=>codes[r.code]=(codes[r.code]||0)+1);
  const lat=rs.map(r=>r.ms).sort((a,b)=>a-b);
  const p50=lat[Math.floor(lat.length*0.5)], p95=lat[Math.floor(lat.length*0.95)]||lat[lat.length-1];
  console.log(`W=${W}: ${dur.toFixed(1)}s ok=${ok} fail=${fail} ${JSON.stringify(codes)} toks=${toks} ${(toks/dur).toFixed(0)} tok/s p50=${p50}ms p95=${p95}ms`);
}
