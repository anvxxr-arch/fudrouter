import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
// sample 6 gonka24 healthy creds
const rows = await sql.unsafe("select id, secret_enc from credential where connection_id='con_prv_gonka24-default' and status='healthy' order by updated_at asc limit 6");
console.log(`gonka24: probing ${rows.length} healthy creds`);
let i=0;
const results=[];
await Promise.all(Array.from({length:Math.min(6,rows.length)}, async()=>{ while(true){ const k=i++; if(k>=rows.length) return;
  const plain=decryptCredentials(rows[k].secret_enc); const key=plain.api_key||plain.access_token||'';
  try {
    const res=await fetch('https://api.gonka24.com/v1/chat/completions',{method:'POST',headers:{Authorization:`*** ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'deepseek-v4.1-flash',messages:[{role:'user',content:'hi'}],max_tokens:1}),signal:AbortSignal.timeout(15000)});
    const b=await res.text().catch(()=>''); results.push({id:rows[k].id.slice(0,8),code:res.status,body:b.slice(0,80).replace(/\s+/g,' ')});
  } catch(e){ results.push({id:rows[k].id.slice(0,8),code:'ERR',body:String(e.message).slice(0,60)}); }
}}));
for(const r of results) console.log(`  ${r.id} ${r.code} ${r.body}`);
console.log('--- verdict: insufficient_balance = mati permanen (bukan 401) ---');
await sql.end({timeout:1});
