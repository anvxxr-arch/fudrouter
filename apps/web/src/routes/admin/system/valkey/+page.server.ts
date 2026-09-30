import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { vk } from '$lib/server/vk';

type RawRow = Record<string, unknown>;

/** Spec §12 key namespaces, in display order. */
const NAMESPACES = [
	'rl',
	'conc',
	'spend',
	'usage',
	'health',
	'credential',
	'circuit',
	'model',
	'catalog',
	'session',
	'idem',
	'lock',
	'metric',
	'ver'
] as const;

/** A number from INFO, or null when the field is missing or the call failed. */
function infoNumber(parsed: RawRow, key: string): number | null {
	const raw = parsed[key];
	if (raw === undefined || raw === null || raw === '') return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

const SCAN_SAMPLE_CAP = 5_000;

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const client = vk();
	if (!client) {
		// Honest state (PRD §74): VALKEY_URL unset is a supported deployment,
		// not an error — every section shows its own 'unavailable'.
		return {
			configured: false,
			latencyMs: null,
			dbsize: null,
			info: {
				usedMemory: null,
				maxMemory: null,
				connectedClients: null,
				opsPerSec: null,
				hitRate: null,
				evictedKeys: null
			},
			namespaces: [] as { prefix: string; count: number }[],
			sampled: 0
		};
	}

	// Every call is isolated: one dead command renders 'unavailable' for its own
	// metric and nothing else, never a 500 (PRD §150 — Valkey dies open).
	let latencyMs: number | null = null;
	try {
		const t0 = performance.now();
		await client.ping();
		latencyMs = performance.now() - t0;
	} catch {
		latencyMs = null;
	}

	let dbsize: number | null = null;
	try {
		dbsize = await client.dbsize();
	} catch {
		dbsize = null;
	}

	let info: RawRow = {};
	try {
		const text = await client.info();
		info = {};
		for (const line of text.split('\n')) {
			const i = line.indexOf(':');
			if (i > 0 && !line.startsWith('#')) info[line.slice(0, i).trim()] = line.slice(i + 1).trim();
		}
	} catch {
		info = {};
	}

	const hits = infoNumber(info, 'keyspace_hits');
	const misses = infoNumber(info, 'keyspace_misses');
	const hitRate =
		hits !== null && misses !== null && hits + misses > 0 ? (100 * hits) / (hits + misses) : null;

	// Logical usage by namespace: sample keys with SCAN (never KEYS) and count
	// the first segment of each key. The loop is capped so a huge keyspace
	// costs a bounded number of round trips.
	const counts = new Map<string, number>();
	let sampled = 0;
	try {
		let cursor = '0';
		do {
			const [next, keys] = await client.scan(cursor, 'COUNT', 500);
			cursor = next;
			for (const key of keys) {
				sampled += 1;
				const prefix = key.split(':', 1)[0];
				if (NAMESPACES.includes(prefix as (typeof NAMESPACES)[number])) {
					counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
				}
			}
		} while (cursor !== '0' && sampled < SCAN_SAMPLE_CAP);
	} catch {
		// Sampling is best-effort; whatever was counted before the failure is
		// still shown alongside the sampled count.
	}

	return {
		configured: true,
		latencyMs,
		dbsize,
		info: {
			usedMemory: infoNumber(info, 'used_memory'),
			maxMemory: infoNumber(info, 'maxmemory'),
			connectedClients: infoNumber(info, 'connected_clients'),
			opsPerSec: infoNumber(info, 'instantaneous_ops_per_sec'),
			hitRate,
			evictedKeys: infoNumber(info, 'evicted_keys')
		},
		namespaces: NAMESPACES.map((prefix) => ({ prefix, count: counts.get(prefix) ?? 0 })),
		sampled
	};
};
