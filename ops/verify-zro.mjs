import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
const rows = await sql.unsafe("select id, secret_enc from credential where connection_id='con_prv_zro-default' and status='healthy' order by updated_at desc limit 3");
console.log(`zro: probing ${rows.length} healthy creds across 3 models`);
const models = ['deepseek-v4.1-flash','deepseek-v4-flash-0731','glm-5.3-flash'];
const results=[];
for(const r of rows){
  const p=decryptCredentials(r.secret_enc); const key=p.api_key||p.access_token||'';
  for(const model of models){
    try{
      const t0=Date.now();
      const res=await fetch('https://zro.moonmath.ai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'Say OK'}],max_tokens:8}),signal:AbortSignal.timeout(30000)});
      const b=await res.text().catch(()=>''); const ms=Date.now()-t0;
      let toks=''; try { toks=JSON.parse(b).usage?.total_tokens+'tok'; } catch{}
      results.push(`${r.id.slice(10,18)} ${model} -> ${res.status} ${ms}ms ${toks} ${b.slice(0,60).replace(/\s+/g,' ')}`);
    }catch(e){ results.push(`${r.id.slice(10,18)} ${model} -> ERR ${String(e.message).slice(0,40)}`); }
  }
}
for(const r of results) console.log('  '+r);
await sql.end({timeout:1});
