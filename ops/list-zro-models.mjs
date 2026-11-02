import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
const rows = await sql.unsafe("select id, secret_enc from credential where connection_id='con_prv_zro-default' and status='healthy' order by updated_at desc limit 1");
const {api_key}=decryptCredentials(rows[0].secret_enc);
const res=await fetch('https://zro.moonmath.ai/v1/models',{headers:{Authorization:`Bearer ${api_key}`},signal:AbortSignal.timeout(30000)});
const j=await res.json().catch(()=>null);
console.log('HTTP', res.status);
if(j && j.data){
  console.log('COUNT', j.data.length);
  for(const m of j.data){
    console.log(`  - id=${m.id}  owned_by=${m.owned_by||'-'}${m.context_window?('  ctx='+m.context_window):''}${m.max_output_tokens?('  maxout='+m.max_output_tokens):''}`);
  }
}else{
  console.log(JSON.stringify(j).slice(0,500));
}
await sql.end({timeout:1});
