import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
const rows = await sql.unsafe("select id, secret_enc from credential where connection_id='con_prv_unikey-default' and status='healthy' order by updated_at asc limit 3");
console.log(`unikey: probing ${rows.length} healthy creds`);
let i=0; const results=[];
await Promise.all(Array.from({length:Math.min(3,rows.length)}, async()=>{ while(true){ const k=i++; if(k>=rows.length) return;
  const p=decryptCredentials(rows[k].secret_enc); const key=p.api_key||p.access_token||'';
  try{
    const res=await fetch('https://www.getunikey.ai/v1/models',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(12000)});
    const b=await res.text().catch(()=>''); results.push({id:rows[k].id.slice(0,10),code:res.status,body:b.slice(0,80).replace(/\s+/g,' ')});
  }catch(e){ results.push({id:rows[k].id.slice(0,10),code:'ERR',body:String(e.message).slice(0,50)}); }
}}));
for(const r of results) console.log(`  ${r.id} ${r.code} ${r.body}`);
await sql.end({timeout:1});
