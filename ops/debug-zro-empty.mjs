import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
const rows = await sql.unsafe("select id, secret_enc from credential where connection_id='con_prv_zro-default' and status='healthy' order by updated_at desc limit 1");
const {api_key}=decryptCredentials(rows[0].secret_enc);
// Full body for the two empty-reply models
for(const model of ['zro/deepseek-v4.1-flash','deepseek-v4.1-flash']){
  const res=await fetch('https://zro.moonmath.ai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${api_key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'Say OK'}],max_tokens:64}),signal:AbortSignal.timeout(30000)});
  const b=await res.text().catch(()=>'');
  console.log(`=== ${model} ===`);
  console.log(b.slice(0,600));
  console.log();
}
await sql.end({timeout:1});
