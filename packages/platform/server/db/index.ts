import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

const client = postgres(process.env.DATABASE_URL);

export const db = drizzle(client, { schema });

/**
 * Close the process-wide pool.
 *
 * Why this exists: `postgres()` opens sockets that keep the Node event loop
 * alive, and a module-level singleton has no owner to close it. In production
 * that is correct — the process is the owner and it exits as a whole. In a test
 * process it is a hang: `scheduler-health-cadence.test.mjs` imports
 * `scheduler.ts`, which imports this module, so the pool outlives the test and
 * the runner waits out its full timeout on a test that already passed
 * (measured: body 474 ms, process 45 s).
 *
 * Callers that own the process lifetime (the workers, the scheduler) never need
 * this. Tests that import any module reaching this one call it in a `finally`.
 */
export async function closeDb() {
	await client.end({ timeout: 5 });
}
