<script lang="ts">
	import { enhance } from '$app/forms';
	import { Alert, Button, Card, CodeBlock, Field, Input, Select, Textarea } from '$lib/ui';
	import { withPending } from '$lib/forms';
	import {
		PLAYGROUND_STRATEGIES,
		type NormalizedError,
		type RunMetrics
	} from '$lib/playground';

	/**
	 * The playground request editor + metrics panel (PRD §27).
	 *
	 * Shared by the global and project-scoped playground pages — they differ
	 * only in their form action and their model/key lists. Non-streaming runs
	 * post through the page's `?/run` action (with `use:enhance` so the button
	 * tells the user the run is in flight); streaming runs read
	 * `/api/playground/stream` as SSE and take the trailing `event: metrics`
	 * frame as the panel's data.
	 */
	let {
		models,
		aliases,
		keys,
		projectId = null,
		runAction = '?/run',
		streamEndpoint = '/api/playground/stream',
		form
	}: {
		models: { id: string; slug: string; name: string; status: string; developer: string | null }[];
		aliases: { id: string; name: string; description: string | null }[];
		keys: { id: string; name: string }[];
		projectId?: string | null;
		runAction?: string;
		streamEndpoint?: string;
		form?: Record<string, unknown> | null;
	} = $props();

	// The messages editor is a raw JSON textarea and the FORM's source of truth
	// (`name="messages"`): the run must send exactly what is on screen, so the
	// serialized text is the state, not a derived echo of parsed rows.
	let messagesRaw = $state('[{"role": "user", "content": "Say OK."}]');
	let system = $state('');
	let model = $state('');
	let aliasName = $state('');
	let strategy = $state('');
	let temperature = $state('');
	let maxTokens = $state('');
	let tools = $state('');
	let jsonMode = $state(false);
	let stream = $state(false);
	let keyId = $state('');
	let pending = $state(false);
	let streaming = $state(false);
	let streamError = $state<string | null>(null);

	let metrics: RunMetrics | null = $state(null);
	let keyContext: string | null = $state(null);
	let runError: NormalizedError | null = $state(null);
	let rawRequest = $state('');
	let rawResponse = $state('');
	let showRaw = $state(false);

	const track = withPending((v) => (pending = v));
	const actionResult = $derived(
		(form ?? null) as null | {
			metrics?: RunMetrics;
			error?: NormalizedError | null;
			rawRequest?: string;
			rawResponse?: string;
			keyContext?: string;
		}
	);
	$effect(() => {
		if (actionResult) {
			metrics = actionResult.metrics ?? null;
			runError = actionResult.error ?? null;
			rawRequest = actionResult.rawRequest ?? '';
			rawResponse = actionResult.rawResponse ?? '';
			keyContext = actionResult.keyContext ?? null;
		}
	});

	// The request's `model` is the ALIAS when one is picked — the point of an
	// alias is that the application sends {"model": "production-chat"} and the
	// target list can change without a redeploy.
	const formModel = $derived(aliasName || model);

	function runPayload(): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
		let messages: unknown;
		let toolList: unknown = null;
		try {
			messages = JSON.parse(messagesRaw);
			if (!Array.isArray(messages)) throw new Error('not an array');
			// Tools parse inside the same guard: a malformed tool blob must fail
			// the run with a message, not throw out of the submit handler.
			if (tools.trim()) {
				toolList = JSON.parse(tools);
				if (!Array.isArray(toolList)) throw new Error('tools not an array');
			}
		} catch {
			return {
				ok: false,
				error: 'Messages must be a JSON array of role/content objects; tools must be a JSON array.'
			};
		}
		return {
			ok: true,
			body: {
				model: formModel,
				strategy,
				messages,
				system,
				temperature: temperature.trim() === '' ? null : Number(temperature),
				maxTokens: maxTokens.trim() === '' ? null : Number(maxTokens),
				tools: toolList,
				jsonMode,
				stream: true,
				keyId,
				projectId
			}
		};
	}

	async function runStream(): Promise<void> {
		const payload = runPayload();
		if (!payload.ok) {
			streamError = payload.error;
			return;
		}
		streaming = true;
		streamError = null;
		runError = null;
		rawResponse = '';
		try {
			const res = await fetch(streamEndpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload.body)
			});
			if (!res.ok || !res.body) {
				const failed = (await res.json().catch(() => null)) as {
					error?: NormalizedError;
					metrics?: RunMetrics;
				} | null;
				runError = failed?.error ?? {
					code: 'INTERNAL_ERROR',
					message: 'Stream failed to start.',
					requestId: null
				};
				metrics = failed?.metrics ?? null;
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let text = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
				rawResponse = text;
				// The relay's final `event: metrics` frame is the panel's data.
				const marker = 'event: metrics\ndata: ';
				const at = text.lastIndexOf(marker);
				if (at >= 0) {
					const payloadLine = text.slice(at + marker.length).split('\n')[0];
					try {
						metrics = JSON.parse(payloadLine) as RunMetrics;
					} catch {
						// Partial frame: the next chunk completes it.
					}
				}
			}
		} catch (e) {
			streamError = e instanceof Error ? e.message : 'Stream failed.';
		} finally {
			streaming = false;
		}
	}
</script>

<Card>
	<form
		method="POST"
		action={runAction}
		use:enhance={track}
		onsubmit={(e) => {
			if (!stream) return;
			e.preventDefault();
			void runStream();
		}}
	>
		{#if projectId}<input type="hidden" name="projectId" value={projectId} />{/if}
		<input type="hidden" name="model" value={formModel} />
		<div class="row">
			<Field label="Model alias" hint="What your app sends: the alias name, not a model slug.">
				<Select bind:value={aliasName}>
					<option value="">(none — use a model slug)</option>
					{#each aliases as a (a.id)}
						<option value={a.name}>{a.name}</option>
					{/each}
				</Select>
			</Field>
			<Field label="Model (canonical slug)" hint="Used when no alias is picked.">
				<Select bind:value={model}>
					<option value="">(select)</option>
					{#each models as m (m.id)}
						<option value={m.slug}>{m.slug}{m.status !== 'active' ? ` (${m.status})` : ''}</option>
					{/each}
				</Select>
			</Field>
		</div>
		<div class="row">
			<Field
				label="Routing strategy override"
				hint="This run only; the bound policy still caps attempts and timeout."
			>
				<Select bind:value={strategy} name="strategy">
					{#each PLAYGROUND_STRATEGIES as s (s.value)}
						<option value={s.value}>{s.label}</option>
					{/each}
				</Select>
			</Field>
			<Field
				label="API key context"
				hint="The run executes as a short-lived key in this key's scope."
			>
				<Select bind:value={keyId} name="keyId">
					<option value="">Platform defaults (no key)</option>
					{#each keys as k (k.id)}
						<option value={k.id}>{k.name}</option>
					{/each}
				</Select>
			</Field>
		</div>
		<Field label="System prompt">
			<Textarea name="system" bind:value={system} rows={2}></Textarea>
		</Field>
		<Field label="Messages (JSON)" hint="An array of role/content objects, e.g. user says …">
			<Textarea name="messages" bind:value={messagesRaw} rows={6}></Textarea>
		</Field>
		<div class="row">
			<Field label="Temperature (0–2)"><Input name="temperature" bind:value={temperature} /></Field>
			<Field label="Max tokens"><Input name="maxTokens" bind:value={maxTokens} /></Field>
		</div>
		<Field label="Tools (JSON array)" hint="Optional tool definitions.">
			<Textarea name="tools" bind:value={tools} rows={3}></Textarea>
		</Field>
		<div class="row toggles">
			<label><input type="checkbox" name="jsonMode" bind:checked={jsonMode} /> JSON mode</label>
			<label><input type="checkbox" name="stream" bind:checked={stream} /> Streaming</label>
			<Button type="submit" variant="primary" pending={pending || streaming}>
				{stream ? 'Run (stream)' : 'Run'}
			</Button>
		</div>
	</form>
</Card>

{#if runError}
	<Alert tone="danger">
		<strong>{runError.code}</strong>
		{runError.message}
		{#if runError.requestId}<span> · request <code>{runError.requestId}</code></span>{/if}
	</Alert>
{/if}
{#if streamError}<Alert tone="danger">{streamError}</Alert>{/if}

{#if metrics}
	<section aria-label="Run metrics">
		<h2>Metrics</h2>
		<dl class="metrics">
			<dt>Provider</dt><dd data-testid="metric-provider">{metrics.provider ?? '—'}</dd>
			<dt>Connection</dt><dd data-testid="metric-connection">{metrics.connection ?? '—'}</dd>
			<dt>Actual model</dt><dd data-testid="metric-model">{metrics.actualModel ?? '—'}</dd>
			<dt>Input tokens</dt><dd data-testid="metric-tokens-in">{metrics.tokensIn ?? '—'}</dd>
			<dt>Output tokens</dt><dd data-testid="metric-tokens-out">{metrics.tokensOut ?? '—'}</dd>
			<dt>Total tokens</dt><dd data-testid="metric-tokens-total">{metrics.tokensTotal ?? '—'}</dd>
			<dt>TTFT</dt>
			<dd data-testid="metric-ttft">{metrics.ttftMs !== null ? `${metrics.ttftMs} ms` : '—'}</dd>
			<dt>Latency</dt>
			<dd data-testid="metric-latency">
				{metrics.latencyMs !== null ? `${metrics.latencyMs} ms` : '—'}
			</dd>
			<dt>Cost</dt>
			<dd data-testid="metric-cost">
				{metrics.costMicro !== null ? `$${Number(metrics.costMicro) / 1e6}` : '—'}
			</dd>
			<dt>Fallback</dt>
			<dd data-testid="metric-fallback">
				{metrics.fallback === null ? '—' : metrics.fallback ? 'yes' : 'no'}
			</dd>
			<dt>Attempts</dt><dd data-testid="metric-attempts">{metrics.attempts ?? '—'}</dd>
			<dt>Request ID</dt>
			<dd data-testid="metric-request-id"><code>{metrics.requestId ?? '—'}</code></dd>
		</dl>
		{#if keyContext}<p class="key-context">Run key context: {keyContext}</p>{/if}
	</section>
{/if}

<Button variant="ghost" onclick={() => (showRaw = !showRaw)}>
	{showRaw ? 'Hide raw request/response' : 'Show raw request/response'}
</Button>
{#if showRaw}
	<div class="row">
		<div class="raw">
			<h3>Raw request</h3>
			<CodeBlock label="POST /v1/chat/completions" code={rawRequest || '(not run yet)'} />
		</div>
		<div class="raw">
			<h3>Raw response</h3>
			<CodeBlock label="response" code={rawResponse || '(not run yet)'} />
		</div>
	</div>
{/if}

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-md);
	}
	.row > :global(*) {
		flex: 1 1 14rem;
		min-width: 0;
	}
	.toggles {
		align-items: center;
	}
	.toggles label {
		display: flex;
		gap: var(--space-xs);
		align-items: center;
	}
	.metrics {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: var(--space-xs) var(--space-md);
	}
	.metrics dt {
		color: var(--color-text-muted);
	}
	.metrics dd {
		margin: 0;
	}
	.key-context {
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}
	.raw {
		flex: 1 1 18rem;
		min-width: 0;
	}
</style>
