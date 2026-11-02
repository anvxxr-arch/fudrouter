import postgres from 'postgres';
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch {}
const sql = postgres(process.env.DATABASE_URL, { max: 1, idle_timeout: 5 });
const { decryptCredentials } = await import('@fudrouter/platform/server/credentials.ts');
const rows = await sql.unsafe("select id, secret_enc from credential where connection_id='con_prv_gonka24-default' order by updated_at asc limit 3");
for(const r of rows){
  const plain = decryptCredentials(r.secret_enc);
  const keys = Object.keys(plain);
  const shape = {};
  for(const k of keys){
    const v = plain[k];
    shape[k] = typeof v === 'string' ? (v.length + 'ch:' + v.slice(0,6) + '…') : (Array.isArray(v) ? 'array['+v.length+']' : typeof v);
  }
  console.log(r.id.slice(0,12), JSON.stringify(shape));
}
await sql.end({timeout:1});
