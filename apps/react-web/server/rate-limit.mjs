// In-process fixed-window rate limiter (no dependencies).
// One bucket per key (session user id, else request IP), scoped to ONE limiter
// instance: the map is created per `rateLimit()` call, so two limiters that
// derive the same key for a client (e.g. the strict and loose `/api/auth`
// buckets, both `ip:<x>`) keep independent counters. A module-level map shared
// the counter between every limiter, so a burst on one surface (10 playground
// requests) could 429 a different one (login). Stale buckets are pruned on every
// check so a map cannot grow unbounded.
export function rateLimit({ windowMs, max, key }) {
	const window = Number(windowMs);
	const limit = Number(max);
	const buckets = new Map();
	return async (req, res, next) => {
		const now = Date.now();
		const id = key ? await key(req) : (req.ip || 'unknown');
		const bucket = buckets.get(id);
		if (!bucket || now >= bucket.reset) {
			buckets.set(id, { count: 1, reset: now + window });
		} else if (bucket.count >= limit) {
			const retryAfter = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
			res.set('Retry-After', String(retryAfter));
			return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
		} else {
			bucket.count += 1;
		}
		// Prune expired buckets from other keys to keep the map bounded.
		for (const [k, v] of buckets) if (now >= v.reset) buckets.delete(k);
		next();
	};
}
