import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
const rows = await sql.unsafe("select id, secret_enc from credential where connection_id='con_prv_dahl-default' and status='healthy' order by updated_at asc limit 6");
console.log(`dahl: probing ${rows.length} 'healthy' creds`);
let i=0; const results=[];
await Promise.all(Array.from({length:Math.min(6,rows.length)}, async()=>{ while(true){ const k=i++; if(k>=rows.length) return;
  const {api_key}=decryptCredentials(rows[k].secret_enc);
  for(const model of ['minimax-m2.7','deepseek-v4-flash-0731','glm-5.3-flash']){
    try{
      const res=await fetch('https://inference.dahl.global/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${api_key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'hi'}],max_tokens:1}),signal:AbortSignal.timeout(12000)});
      const b=await res.text().catch(()=>''); 
      results.push({id:rows[k].id.slice(0,10),model,code:res.status,body:b.slice(0,60).replace(/\s+/g,' ')});
      if(res.status===200||res.status===401||res.status===403) return;
    }catch(e){ results.push({id:rows[k].id.slice(0,10),model:'ERR',code:'ERR',body:String(e.message).slice(0,50)}); return; }
  }
}}));
for(const r of results) console.log(`  ${r.id} ${r.model} ${r.code} ${r.body}`);
await sql.end({timeout:1});
