/**
 * The db handle the observe queries accept.
 *
 * It is the real drizzle type, imported TYPE-ONLY: `$lib/server/db` throws at
 * import time without `DATABASE_URL` (by design — the server must fail fast),
 * and these modules are imported by tests that bring their own connection.
 * The loaders pass the app's `db`; the tests pass a drizzle client built on a
 * scratch Postgres. Same type, same SQL, no shims.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from '$lib/server/db/schema';

export type ObserveDb = PostgresJsDatabase<typeof schema>;
