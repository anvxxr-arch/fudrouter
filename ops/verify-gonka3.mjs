import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
const rows = await sql.unsafe("select id, secret_enc from credential where connection_id='con_prv_gonka24-default' and status='healthy' order by updated_at asc limit 2");
const {api_key} = decryptCredentials(rows[0].secret_enc);
// list models
const m = await fetch('https://api.gonka24.com/v1/models',{headers:{Authorization:`Bearer ${api_key}`},signal:AbortSignal.timeout(15000)});
const mb = await m.text().catch(()=>''); 
console.log('MODELS:', mb.slice(0,500).replace(/\s+/g,' '));
// try a completion with a guessed model
for(const model of ['deepseek-v4.1-flash','DeepSeek-V4-Flash-0731','deepseek-ai/DeepSeek-V4-Flash-0731','deepseek-chat','glm-5.3-flash']){
  const r = await fetch('https://api.gonka24.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${api_key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'hi'}],max_tokens:1}),signal:AbortSignal.timeout(15000)});
  const b = await r.text().catch(()=>''); 
  console.log(`  model=${model} -> ${r.status} ${b.slice(0,90).replace(/\s+/g,' ')}`);
}
await sql.end({timeout:1});
