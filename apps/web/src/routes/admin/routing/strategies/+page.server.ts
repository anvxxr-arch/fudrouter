import type { PageServerLoad } from './$types';
import { requireCap } from '$lib/server/roles';
import { db } from '$lib/server/db';
import { routingPolicy } from '$lib/server/db/schema';
import { SIM_STRATEGIES } from '$lib/server/admin-simulate';

/** Which inputs each strategy mixes (copy mirrors the guide; the guide is canonical). */
const STRATEGY_USES: Record<string, string> = {
	balanced: 'price · latency · reliability · capacity (equal-ish mix)',
	lowest_cost: 'estimated cost for the token estimate',
	lowest_latency: 'observed p95 latency',
	highest_reliability: 'observed availability',
	provider_priority: 'provider priority',
	weighted: 'weights jsonb (price / latency / reliability / capacity)',
	round_robin: 'rotation slot (simulated order is deterministic)',
	random: 'shuffle slot (simulated order is deterministic)',
	smart: 'weights jsonb (price / latency / reliability / capacity)'
};

export const load: PageServerLoad = async ({ locals }) => {
	requireCap(locals, 'admin.ops');
	const policies = await db
		.select({ id: routingPolicy.id, name: routingPolicy.name, strategy: routingPolicy.strategy, weights: routingPolicy.weights })
		.from(routingPolicy)
		.orderBy(routingPolicy.name);
	return {
		strategies: SIM_STRATEGIES.map((s) => ({ key: s, uses: STRATEGY_USES[s] ?? '' })),
		policies
	};
};
