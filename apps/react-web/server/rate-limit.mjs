// In-process fixed-window rate limiter (no dependencies).
// One bucket per key (session user id, else request IP) per limiter instance;
// stale buckets are pruned on every check so the map cannot grow unbounded.
const buckets = new Map();

export function rateLimit({ windowMs, max, key }) {
	const window = Number(windowMs);
	const limit = Number(max);
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
