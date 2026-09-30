/**
 * Homepage content (PRD §13) — the hero copy, the OpenAI-compatible code
 * sample and the seven feature sections live here as data, so the landing page
 * is markup and this file is the words. Each feature section is one of the
 * PRD §13 list items: available models, provider network, smart routing,
 * fallback, observability, cost optimization, OpenAI compatibility. "Available
 * models" renders from live DB rows on the page itself, so it is not repeated
 * here.
 */
export const HERO = {
	tagline: 'Commercial AI router',
	headline: 'Unified API for AI models. Connect once. Route anywhere.',
	lede: 'One OpenAI-compatible key reaches every model and provider in the network — routed, metered and logged per request.'
} as const;

export const HERO_ACTIONS = {
	primary: 'Get API Key',
	secondary: 'Explore Models',
	tertiary: 'Read Docs'
} as const;

/** The OpenAI JS sample, visible immediately above the fold (PRD §13). */
export const CODE_SAMPLE = {
	label: 'OpenAI SDK',
	code: `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.FUDROUTER_KEY,
  baseURL: "https://ai.karepmuwes.my.id/v1",
});

const res = await client.chat.completions.create({
  model: "grok-4.6",
  messages: [{ role: "user", content: "hello" }],
});`
} as const;

export interface FeatureSection {
	title: string;
	body: string;
	href?: string;
	linkLabel?: string;
}

export const FEATURE_SECTIONS: FeatureSection[] = [
	{
		title: 'Provider network',
		body: 'One key reaches providers across the network. Model availability is published from live catalog data, and a model served by more than one provider keeps every route open.',
		href: '/providers',
		linkLabel: 'Browse providers'
	},
	{
		title: 'Smart routing',
		body: 'Each request is scored across candidate routes — price, latency, reliability and capacity — under your routing policy. The winner is recorded on the request, not hidden.',
		href: '/docs/routing/routing',
		linkLabel: 'How routing works'
	},
	{
		title: 'Fallback',
		body: 'A rate limit, timeout or outage on one route retries on the next candidate instead of failing your call. Attempts are metered per request and visible in your logs.',
		href: '/docs/routing/fallback',
		linkLabel: 'Fallback and retries'
	},
	{
		title: 'Observability',
		body: 'Every call writes one ledger row: model, provider, tokens, cost, latency and an error code when it failed. Request logs are yours to read, to the token.',
		href: '/docs/observability/observability',
		linkLabel: 'What gets recorded'
	},
	{
		title: 'Cost optimization',
		body: 'Normalized per-1M prices let the router prefer the cheaper route at equal quality, and per-request cost lands in your usage the moment the call ends.',
		href: '/pricing',
		linkLabel: 'See pricing'
	},
	{
		title: 'OpenAI compatibility',
		body: 'Point any OpenAI-compatible client at one base URL. Chat Completions, Models, Responses and Embeddings speak the wire format your SDK already knows.',
		href: '/docs/compatibility/openai-compatibility',
		linkLabel: 'Compatibility notes'
	}
];
