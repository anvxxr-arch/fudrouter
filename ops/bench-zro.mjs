import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
const rows = await sql.unsafe("select id, secret_enc from credential where connection_id='con_prv_zro-default' and status='healthy' order by updated_at desc limit 16");
const creds = rows.map(r=>decryptCredentials(r.secret_enc).api_key).filter(Boolean);
console.log(`zro: ${creds.length} creds loaded for benchmark`);
const models = ['zro/deepseek-v4.1-flash','zro/deepseek-v4-flash-0731','zro/glm-5.3-flash'];
const prompt = 'Count from 1 to 20 in one line.';
async function oneCall(key, model){
  const t0=Date.now();
  try{
    const res=await fetch('https://zro.moonmath.ai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:prompt}],max_tokens:128}),signal:AbortSignal.timeout(60000)});
    const b=await res.text().catch(()=>null); const ms=Date.now()-t0;
    if(!res.ok) return {ok:false,code:res.status,ms,toks:0};
    const j=JSON.parse(b); const toks=j.usage?.total_tokens||0; const reply=j.choices?.[0]?.message?.content||'';
    return {ok:true,code:200,ms,toks,reply};
  }catch(e){ return {ok:false,code:'ERR',ms:Date.now()-t0,toks:0,err:String(e.message).slice(0,40)}; }
}
for(const W of [8,16,32]){
  const t0=Date.now(); let total=0, ok=0, fail=0, codes={};
  const tasks=[];
  for(let i=0;i<W;i++){
    const key=creds[i%creds.length];
    const model=models[i%models.length];
    tasks.push(oneCall(key,model));
  }
  const results=await Promise.all(tasks);
  const dur=(Date.now()-t0)/1000;
  for(const r of results){
    if(r.ok){ total+=r.toks; ok++; } else { fail++; codes[r.code]=(codes[r.code]||0)+1; }
  }
  console.log(`  W=${W}: ${dur.toFixed(1)}s  ok=${ok} fail=${fail} ${JSON.stringify(codes)}  ${total}tok = ${(total/dur).toFixed(0)} tok/s aggregate`);
}
await sql.end({timeout:1});
