// Throwaway probe: drizzle/postgres-js result shapes for execute() and update().
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

const client = postgres('postgres://fudrouter:fudrouter@127.0.0.1:5432/fudrouter_test');
const db = drizzle(client);

const ex = await db.execute(sql`update "job" set "status" = "status" where false returning "id", "type"`);
console.log('execute keys:', Object.keys(ex), 'isArray:', Array.isArray(ex), 'length:', ex.length, 'rowCount:', ex.rowCount, 'count:', ex.count);

const up = await db.update({ id: 'x' }).set?.({}).where?.(sql`false`);
console.log('skip');

const res = await db.execute(sql`update "job" set "attempts" = "attempts" where false returning "id"`);
console.log('rows sample:', Array.isArray(res) ? res.slice(0, 1) : res);

await client.end({ timeout: 1 });
