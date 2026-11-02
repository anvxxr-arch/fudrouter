import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
const rows = await sql.unsafe("select id, secret_enc from credential where connection_id='con_prv_zro-default' and status='healthy' order by updated_at desc limit 2");
const {api_key}=decryptCredentials(rows[0].secret_enc);
// ALL 6 models from /v1/models
const models = ['deepseek-v4-flash-0731','zro/deepseek-v4-flash-0731','zro/deepseek-v4.1-flash','zro/glm-5.3-flash','glm-5.3-flash','deepseek-v4.1-flash'];
console.log('=== probing ALL 6 ZRO catalog models ===');
for(const model of models){
  try{
    const t0=Date.now();
    const res=await fetch('https://zro.moonmath.ai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${api_key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'user',content:'Reply with just the word OK'}],max_tokens:8}),signal:AbortSignal.timeout(30000)});
    const b=await res.text().catch(()=>''); const ms=Date.now()-t0;
    let reply=''; try { reply=JSON.parse(b).choices?.[0]?.message?.content||''; } catch{}
    console.log(`  ${model.padEnd(32)} -> ${res.status} ${ms}ms reply="${reply.slice(0,40)}"`);
  }catch(e){ console.log(`  ${model.padEnd(32)} -> ERR ${String(e.message).slice(0,50)}`); }
}
await sql.end({timeout:1});
