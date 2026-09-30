/**
 * Public guides — explanatory copy for the marketing / acquisition surface.
 *
 * Pages render these through `<Guide>`, they do not embed a private essay.
 * Adding a page is a new entry here plus one tag at the call site.
 *
 * Rules for an entry:
 * - Say only what the code actually does. No invented limits, credits, or SLAs.
 * - A fact's term is a label; its detail is a value. Do not shout the value.
 * - Keep it short enough that an operation page still leads with its form.
 *
 * Split out of the single 754-line `guides.ts` by audience so each file can be
 * read and edited on its own; `$lib/guides` composes the three back into one map.
 */
import type { Guide } from '$lib/guides-types';

export const PUBLIC_GUIDES = {
	home: {
		audience: 'public',
		// The landing leads with the product, not with a glossary. This is the
		// ONLY explanatory block on a public page, and `guides.test.ts` fails
		// the build if it grows past one short section. Everything it used to
		// carry — surfaces, the first-call walkthrough, price units — is
		// reference material and lives in the `docs` guide, where someone
		// arrived already looking for it.
		sections: [
			{
				title: 'One key, many models',
				facts: [
					{ term: 'Catalog', detail: 'GET /v1/models is public. No key needed.' },
					{ term: 'Calls', detail: 'POST /v1/chat/completions, metered per token.' }
				]
			}
		]
	},

	docs: {
		audience: 'public',
		sections: [
			{
				title: 'Authenticate',
				lede: 'OpenAI-compatible. The samples below use $FUDROUTER_KEY so you can paste them without editing the header shape.',
				facts: [
					{
						term: 'Header',
						detail: 'Authorization: Bearer, then the key. No other scheme is accepted on chat.'
					},
					{
						term: 'Shown once',
						detail: 'The full secret exists only in the create response. Later you see the prefix.'
					},
					{
						term: '401',
						detail:
							'Missing, malformed, or revoked key. A valid key and an unknown model is not a 401.'
					},
					{
						term: 'Models list',
						detail:
							'GET /v1/models does not require a key. A 200 from it proves nothing about your key.'
					}
				]
			},
			{
				title: 'What the router records',
				facts: [
					{
						term: 'Kept',
						detail:
							'Model, token counts, cost, latency, status, and an error string when the call failed.'
					},
					{
						term: 'Not kept',
						detail: 'Prompt and completion text are not written to the request log.'
					},
					{
						term: 'Stream',
						detail:
							'stream: true returns SSE. The final chunk carries usage; that is what gets metered.'
					},
					{
						term: 'Error body',
						detail: 'Failures use an error.message object and a 4xx or 5xx status.'
					}
				]
			},
			{
				title: 'How to read a price',
				lede: 'The table is the pay-as-you-go surface only. A model that is not on /v1 has no per-token price to quote.',
				facts: [
					{ term: 'Unit', detail: 'USD per 1 million tokens. Input and output are priced apart.' },
					{
						term: 'Storage',
						detail:
							'The database keeps micro-units (millionths). The page formats those, it does not round in the row.'
					},
					{
						term: 'Context',
						detail:
							'The context column is the model window, in thousands of tokens, when we have one.'
					},
					{
						term: 'Tier',
						detail:
							'Placeholder. The model table has no tier column yet, so do not treat the badge as billing.'
					},
					{
						term: 'Coding plan',
						detail:
							'Covered models would be included in a subscription. That program is not live; this page does not invent a seat price.'
					}
				]
			},
			{
				title: 'How to read the catalog',
				lede: 'Grouped by surface, because the surface is the URL your client uses. The tier is a property of the row, not the group.',
				facts: [
					{
						term: 'Slug',
						detail:
							'The string you send as model. When it is the same as the display name — which it is on almost every model — the card prints it once.'
					},
					{
						term: 'Context',
						detail:
							'Window size in tokens, when the row has one. A dash means we have not recorded it.'
					},
					{
						term: 'Tier',
						detail:
							'free or premium, colour and word. Placeholder until the database owns the assignment.'
					},
					{
						term: 'Same model, two surfaces',
						detail:
							'A slug can be free on one prefix and premium on the other. Read the row, not the name alone.'
					},
					{
						term: 'What is missing',
						detail:
							'Provider names and upstream URLs are not on this page. They are an admin concern.'
					}
				]
			},
			{
				title: 'What this check is',
				lede: 'A probe from this page load, not a historical uptime feed.',
				facts: [
					{
						term: 'Health',
						detail:
							'GET /health on the data plane, 4 second timeout. The service name comes from that body.'
					},
					{
						term: 'Models',
						detail:
							'If health is up, GET /v1/models and count the data array. That is "models published".'
					},
					{
						term: 'Latency',
						detail:
							'Time for this page to finish the probe. It is not the latency of your last chat call.'
					},
					{
						term: 'Not included',
						detail: 'Each upstream provider is probed from Admin → Connections, not from here.'
					}
				]
			},
			{
				title: 'What signing in opens',
				facts: [
					{
						term: 'Session',
						detail: 'Email and password, or Discord. The session cookie is what later pages read.'
					},
					{
						term: 'You land on',
						detail: 'Dashboard, unless your role includes admin.view — then the home is Admin.'
					},
					{
						term: 'You can',
						detail: 'Mint keys, read your own usage, and edit your display name and timezone.'
					},
					{
						term: 'You cannot',
						detail: 'See other accounts, provider credentials, or the request log across users.'
					}
				]
			},
			{
				title: 'What an account is',
				facts: [
					{
						term: 'Required',
						detail: 'Name, email, and a password of at least 8 characters. Discord skips the form.'
					},
					{
						term: 'After create',
						detail: 'You are signed in and sent to API Keys. Mint one before the first call.'
					},
					{
						term: 'Role',
						detail:
							'New accounts are members. Staff roles are assigned from Admin → Users, not at signup.'
					},
					{
						term: 'Billing',
						detail:
							'No credit is granted here. Usage is metered once you call the API; top-ups are not on this form.'
					}
				]
			}
		]
	},

	models: {
		audience: 'public',
		sections: [
			{
				title: 'Reading the catalog',
				facts: [
					{ term: 'Prices', detail: 'USD per 1M tokens, from the current pricing rule.' },
					{ term: 'Provider availability', detail: 'How many live provider routes serve the model.' },
					{ term: 'P50 / P95', detail: 'Observed latency from real traffic. Dash means no data yet.' },
					{ term: 'Capabilities', detail: 'A missing capability is unknown, never a claim of "no".' }
				]
			}
		]
	},
	'models-detail': {
		audience: 'public',
		sections: [
			{
				title: 'What this page shows',
				facts: [
					{ term: 'Pricing', detail: 'Normalized per 1M tokens: input, cached input, output.' },
					{ term: 'Per-provider prices', detail: 'Shown only when they differ from the model-wide price.' },
					{ term: 'Identifiers', detail: 'The canonical slug, and each provider’s upstream name.' },
					{ term: 'Availability', detail: 'Success share of observed requests. Dash means no data yet.' }
				]
			}
		]
	},
	'models-compare': {
		audience: 'public',
		sections: [
			{
				title: 'Comparing models',
				facts: [
					{ term: 'Selection', detail: 'One to four models, side by side.' },
					{ term: 'Order', detail: 'Rows are facts, never a ranking.' },
					{ term: 'Observed', detail: 'P50 and P95 come from real traffic through the router.' }
				]
			}
		]
	},
	providers: {
		audience: 'public',
		sections: [
			{
				title: 'The provider network',
				facts: [
					{ term: 'Routing', detail: 'A model can be served by more than one provider.' },
					{ term: 'Failover', detail: 'A failed attempt retries on another route where possible.' },
					{ term: 'Credentials', detail: 'Never shown here. Provider secrets live in the admin console.' }
				]
			}
		]
	},
	provider: {
		audience: 'public',
		sections: [
			{
				title: 'What this page shows',
				facts: [
					{ term: 'Models', detail: 'Canonical models this provider currently serves.' },
					{ term: 'Performance', detail: 'Observed P50/P95 and success share of real requests.' },
					{ term: 'Incidents', detail: 'Filed against this provider or the major-providers component.' }
				]
			}
		]
	},
	playground: {
		audience: 'public',
		sections: [
			{
				title: 'The playground runs real requests',
				facts: [
					{ term: 'Signed out', detail: 'The form is a demo. No request leaves the browser.' },
					{ term: 'Signed in', detail: 'Runs through the same /v1/chat/completions path your key uses.' },
					{ term: 'Metered', detail: 'A run is a real request: it is logged and billed like any other.' },
					{ term: 'Run key', detail: 'Each run uses a short-lived key in your chosen key’s scope.' }
				]
			}
		]
	},
	changelog: {
		audience: 'public',
		sections: [
			{
				title: 'What gets an entry',
				facts: [
					{ term: 'Source', detail: 'One markdown file per release in docs/changelog.' },
					{ term: 'Scope', detail: 'Shipped changes to the platform, newest first.' }
				]
			}
		]
	},
	'changelog-entry': {
		audience: 'public',
		sections: [
			{
				title: 'About these notes',
				facts: [
					{ term: 'Published', detail: 'Entries are written at release time and never edited after.' },
					{ term: 'Questions', detail: 'The status page carries live health; this page carries history.' }
				]
			}
		]
	},
	incident: {
		audience: 'public',
		sections: [
			{
				title: 'Reading an incident',
				facts: [
					{ term: 'Timeline', detail: 'Investigating, Identified, Monitoring, Resolved — each with a note.' },
					{ term: 'Times', detail: 'All timestamps are UTC.' }
				]
			}
		]
	},
	terms: {
		audience: 'public',
		sections: [
			{
				title: 'The service',
				lede: 'Operational summary of what the product does today. Not a finished legal instrument — the header says so until counsel signs it.',
				paragraphs: [
					'fudrouter gives API access to third-party language models through one key. Accepted calls are metered per token and recorded against your account. Upstream availability and the prices in the catalog can change without a separate notice on this page.'
				]
			},
			{
				title: 'Use, availability, changes',
				facts: [
					{
						term: 'Acceptable use',
						detail:
							'Do not use the service to break the law, infringe someone else, or disrupt the platform or its upstreams.'
					},
					{
						term: 'As-is',
						detail:
							'No uptime figure is promised on this page. Status shows a live probe, not an SLA.'
					},
					{
						term: 'Catalog',
						detail:
							'Model list and per-token prices are whatever the active catalog says when you call.'
					},
					{
						term: 'Changes',
						detail:
							'These terms can be updated. Continued use after an update is the acceptance rule until a signed version replaces this summary.'
					}
				]
			}
		]
	},
	privacy: {
		audience: 'public',
		sections: [
			{
				title: 'What is stored',
				lede: 'Operational summary. Not a finished privacy notice — the header says so until it is reviewed.',
				facts: [
					{
						term: 'Account',
						detail: 'Email, name, role, timezone, and the timestamps the auth system keeps.'
					},
					{
						term: 'Keys',
						detail:
							'A hash, plus the prefix and the name you chose. The secret is not recoverable after create.'
					},
					{
						term: 'Requests',
						detail:
							'Model, token counts, cost, latency, status, error string. Not the prompt or the completion.'
					},
					{
						term: 'Provider secrets',
						detail: 'Encrypted at rest. No page load selects the ciphertext, and no API returns it.'
					}
				]
			},
			{
				title: 'Retention and deletion',
				paragraphs: [
					'Usage rows are kept for billing and abuse review. This page does not invent a day count. To ask for account deletion, write from the email on the account — that is the address we can tie to the row.'
				]
			}
		]
	}
} as const satisfies Record<string, Guide>;
