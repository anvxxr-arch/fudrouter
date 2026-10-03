/**
 * CLI / IDE onboarding: ready-to-paste configuration for the coding agents and
 * editors that can be pointed at the router.
 *
 * This is the "connect a client" surface. The router already speaks the [OI]
 * chat-completions API natively and the Anthropic Messages API as a native
 * inbound surface (`POST /v1/messages`), so a client needs no translator in
 * front — only a base URL, a key and a model slug. This module turns those three
 * values into the exact snippet each tool wants, so onboarding is copy-paste
 * instead of reading five different docs.
 *
 * Rules:
 * - Pure: no I/O, no env reads. The caller passes the resolved base URL, model
 *   and key. That keeps every snippet unit-testable and lets the page render a
 *   model-specific config without re-deriving anything.
 * - Honest: a tool is listed only when the router's wire protocol actually
 *   serves it. `protocol` says which surface the tool must hit; an `openai`
 *   tool needs `/v1/chat/completions`, an `anthropic` tool needs `/v1/messages`.
 * - Secrets are never rendered: the key argument is a placeholder the user
 *   replaces (key secrets are stored hash-only and cannot be replayed).
 */

export type CliProtocol = 'openai' | 'anthropic';
export type SnippetLanguage = 'toml' | 'json' | 'jsonc' | 'yaml' | 'bash' | 'text';

export interface CliSnippet {
	/** Filename or "shell" — where this block goes. */
	label: string;
	language: SnippetLanguage;
	code: string;
}

export interface CliTarget {
	/** Public router origin, no trailing slash and no `/v1` (e.g. https://ai.example). */
	baseUrl: string;
	/** A model slug the router publishes. */
	model: string;
	/** Placeholder shown for the credential; never a real secret. */
	apiKey: string;
}

export interface CliTool {
	id: string;
	name: string;
	/** Which inbound surface the tool must be pointed at. */
	protocol: CliProtocol;
	/** One line: what this client is. */
	summary: string;
	/** How to obtain the tool. */
	install: string;
	/** Where the snippet goes, in order. */
	steps: string[];
	docsUrl: string;
	snippets: (t: CliTarget) => CliSnippet[];
}

/** Default credential placeholder. A real key is shown once at creation. */
export const API_KEY_PLACEHOLDER = 'sk-ar-REPLACE_WITH_YOUR_KEY';

/** `https://host` → `https://host/v1` (idempotent). */
export function withV1(baseUrl: string): string {
	const b = baseUrl.replace(/\/+$/, '');
	return b.endsWith('/v1') ? b : `${b}/v1`;
}

export const CLI_TOOLS: CliTool[] = [
	{
		id: 'claude-code',
		name: '[CC]',
		protocol: 'anthropic',
		summary:
			'Anthropic’s terminal coding agent. It talks the Anthropic Messages API, which the router serves natively at POST /v1/messages.',
		install: 'npm install -g @anthropic-ai/[CC]',
		steps: [
			'Export the three variables below in your shell (or add them to your shell rc / a .env the tool loads).',
			'ANTHROPIC_BASE_URL is the router ORIGIN — the client appends /v1/messages itself, so do NOT add /v1.',
			'ANTHROPIC_MODEL picks the slug; ANTHROPIC_SMALL_FAST_MODEL is the cheap model used for background tasks.'
		],
		docsUrl: 'https://docs.[CC].com/en/docs/claude-code/llm-gateway',
		snippets: (target) => {
			const baseUrl = target.baseUrl.replace(/\/+$/, '');
			const { model } = target;
			const apiKey = target.apiKey || API_KEY_PLACEHOLDER;
			return [
				{
					label: 'shell',
					language: 'bash',
					code: [
						`export ANTHROPIC_BASE_URL="${baseUrl}"`,
						`export ANTHROPIC_AUTH_TOKEN="${apiKey}"`,
						`export ANTHROPIC_MODEL="${model}"`,
						`export ANTHROPIC_SMALL_FAST_MODEL="${model}"`,
						'',
						'# verify the credential resolves before launching',
						`curl -sS "${baseUrl}/v1/messages" \\`,
						'  -H "x-api-key: $ANTHROPIC_AUTH_TOKEN" \\',
						'  -H "anthropic-version: 2023-06-01" \\',
						'  -H "content-type: application/json" \\',
						`  -d '{"model":"${model}","max_tokens":16,"messages":[{"role":"user","content":"ping"}]}'`
					].join('\n')
				}
			];
		}
	},
	{
		id: 'cline',
		name: 'Cline (VS Code / JetBrains)',
		protocol: 'openai',
		summary:
			'Autonomous coding agent for VS Code and JetBrains. Configure it with the "[OI] Compatible" provider.',
		install: 'Install the Cline extension from your editor’s marketplace, then open Settings → Providers.',
		steps: [
			'Open Cline settings and set API Provider to “[OI] Compatible”.',
			'Base URL: the router base ending in /v1 (below).',
			'API Key: paste your key. Model ID: the slug below.',
			'Hit Verify — Cline issues a real completion, so a green check means routing, auth and billing all work.'
		],
		docsUrl: 'https://docs.cline.bot/provider-config/[OI]-compatible',
		snippets: (target) => [
			{
				label: 'Cline → Settings → Providers',
				language: 'text',
				code: [
					'API Provider   [OI] Compatible',
					`Base URL       ${withV1(target.baseUrl)}`,
					`API Key        ${target.apiKey || API_KEY_PLACEHOLDER}`,
					`Model ID       ${target.model}`
				].join('\n')
			}
		]
	},
	{
		id: 'opencode',
		name: 'opencode',
		protocol: 'openai',
		summary:
			'Open-source terminal coding agent. A custom provider is one block in opencode.json using the [OI]-compatible runtime.',
		install: 'curl -fsSL https://opencode.ai/install | bash',
		steps: [
			'Create opencode.json in your project root (or ~/.config/opencode/opencode.json for a global provider).',
			'The `npm` field selects the [OI]-compatible runtime — the router speaks /v1/chat/completions.',
			'Run `opencode` and pick the provider/model from the list.'
		],
		docsUrl: 'https://opencode.ai/docs/providers/',
		snippets: (target) => [
			{
				label: 'opencode.json',
				language: 'json',
				code: JSON.stringify(
					{
						$schema: 'https://opencode.ai/config.json',
						provider: {
							fudrouter: {
								npm: '@ai-sdk/openai-compatible',
								name: 'fudrouter',
								options: {
									baseURL: withV1(target.baseUrl),
									apiKey: target.apiKey || API_KEY_PLACEHOLDER
								},
								models: {
									[target.model]: { name: target.model }
								}
							}
						}
					},
					null,
					2
				)
			}
		]
	},
	{
		id: 'continue',
		name: 'Continue',
		protocol: 'openai',
		summary:
			'Open-source IDE assistant (VS Code / JetBrains). Uses the `openai` provider with an `apiBase` override.',
		install: 'Install the Continue extension, then edit ~/.continue/config.yaml.',
		steps: [
			'Add the block below under `models:` in ~/.continue/config.yaml.',
			'`apiBase` must include the /v1 suffix.',
			'Reload the extension; the model appears in the Continue model picker.'
		],
		docsUrl: 'https://docs.continue.dev/customize/model-providers/top-level/[OI]',
		snippets: (target) => [
			{
				label: '~/.continue/config.yaml',
				language: 'yaml',
				code: [
					'name: fudrouter',
					'version: 1.0.0',
					'schema: v1',
					'models:',
					`  - name: ${target.model}`,
					'    provider: openai',
					`    model: ${target.model}`,
					`    apiBase: ${withV1(target.baseUrl)}`,
					`    apiKey: ${target.apiKey || API_KEY_PLACEHOLDER}`,
					'    roles:',
					'      - chat',
					'      - edit',
					'      - apply'
				].join('\n')
			}
		]
	},
	{
		id: 'cursor',
		name: 'Cursor',
		protocol: 'openai',
		summary:
			'AI editor. Enable the [OI] base-URL override and add the model under Settings → Models.',
		install: 'Cursor → Settings → Models.',
		steps: [
			'Turn on “Override [OI] Base URL” and paste the /v1 base below.',
			'Paste your key into the [OI] API Key field.',
			'Add the model slug as a custom model, then enable it.',
			'Note: the override applies to every [OI] model — toggle it off to use Cursor’s own models.'
		],
		docsUrl: 'https://docs.cursor.com/settings/models',
		snippets: (target) => [
			{
				label: 'Cursor → Settings → Models',
				language: 'text',
				code: [
					'Override [OI] Base URL   ON',
					`Base URL                 ${withV1(target.baseUrl)}`,
					`API Key                  ${target.apiKey || API_KEY_PLACEHOLDER}`,
					`Custom model             ${target.model}`
				].join('\n')
			}
		]
	},
	{
		id: 'codex',
		name: 'Codex CLI',
		protocol: 'openai',
		summary:
			'[OI]’s terminal coding agent. A custom provider lives in ~/.codex/config.toml.',
		install: 'npm install -g @openai/codex',
		steps: [
			'Add the provider block and set model_provider in ~/.codex/config.toml.',
			'Export the key under the name you set in env_key.',
			'wire_api = "chat" selects the /v1/chat/completions surface the router serves.'
		],
		docsUrl: 'https://github.com/openai/codex/blob/main/docs/config.md',
		snippets: (target) => [
			{
				label: '~/.codex/config.toml',
				language: 'toml',
				code: [
					'model = "' + target.model + '"',
					'model_provider = "fudrouter"',
					'',
					'[model_providers.fudrouter]',
					'name = "fudrouter"',
					`base_url = "${withV1(target.baseUrl)}"`,
					'env_key = "FUDROUTER_API_KEY"',
					'wire_api = "chat"'
				].join('\n')
			},
			{
				label: 'shell',
				language: 'bash',
				code: `export FUDROUTER_API_KEY="${target.apiKey || API_KEY_PLACEHOLDER}"`
			}
		]
	},
	{
		id: 'openai-sdk',
		name: 'Any [OI]-compatible SDK',
		protocol: 'openai',
		summary:
			'Every [OI] client — the official SDKs, LangChain, LlamaIndex, Aider, raw curl — only needs a base URL and a key.',
		install: 'pip install [OI]   # or: npm install [OI]',
		steps: [
			'Point the client’s base URL at the router and use your key as the API key.',
			'Use any slug from GET /v1/models as the model name.',
			'The same key works for /v1/messages (Anthropic shape) if a tool needs it.'
		],
		docsUrl: '',
		snippets: (target) => [
			{
				label: 'shell',
				language: 'bash',
				code: [
					`export OPENAI_BASE_URL="${withV1(target.baseUrl)}"`,
					`export OPENAI_API_KEY="${target.apiKey || API_KEY_PLACEHOLDER}"`,
					'',
					`curl -sS "$OPENAI_BASE_URL/chat/completions" \\`,
					'  -H "authorization: Bearer $OPENAI_API_KEY" \\',
					'  -H "content-type: application/json" \\',
					`  -d '{"model":"${target.model}","messages":[{"role":"user","content":"ping"}]}'`
				].join('\n')
			},
			{
				label: 'python',
				language: 'bash',
				code: [
					'from [OI] import [OI]',
					'',
					`client = [OI](base_url="${withV1(target.baseUrl)}", api_key="sk-ar-...")`,
					'print(client.chat.completions.create(',
					`    model="${target.model}",`,
					'    messages=[{"role": "user", "content": "ping"}],',
					').choices[0].message.content)'
				].join('\n')
			}
		]
	}
];

export function cliToolById(id: string): CliTool | undefined {
	return CLI_TOOLS.find((tool) => tool.id === id);
}

/** Render every tool's snippets for one target (the page's data shape). */
export function renderCliTools(target: CliTarget): { tool: CliTool; snippets: CliSnippet[] }[] {
	return CLI_TOOLS.map((tool) => ({ tool, snippets: tool.snippets(target) }));
}
