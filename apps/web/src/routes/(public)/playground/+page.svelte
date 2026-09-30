<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import {
		Alert,
		Button,
		ButtonLink,
		CodeBlock,
		Field,
		Guide,
		Input,
		PageHeader,
		Section,
		Select,
		Textarea,
		UxState
	} from '$lib/ui';
	import { withPending } from '$lib/forms';
	import { formatCost, formatTokens } from '$lib/format';
	import { formatMs } from '$lib/public-format';
	import { PLAYGROUND_STRATEGIES, type NormalizedError, type RunMetrics } from '$lib/playground';
	/**
	 * The public playground (PRD §18): four panels — Configuration, Prompt,
	 * Response, Metrics. Signed out it is a full demo and no request leaves the
	 * server; signed in a run goes through the real /v1/chat/completions path
	 * under a short-lived run key. Checked runs stream from /playground/run
	 * (SSE relay); unchecked runs post the form action.
	 */
	let { data, form } = $props();
	// Seeded ONCE from props on purpose: later refreshes of `data` must not
	// clobber a selection the user is typing. `untrack` states that intent —
	// this is not a missed reactivity.
	let model = $state(untrack(() => data.models[0]?.slug ?? ''));
	let strategy = $state('');
	let keyId = $state('');
	let temperature = $state('');
	let maxTokens = $state('');
	let system = $state('');
	let userPrompt = $state('Say OK.');
	let stream = $state(false);
	let pending = $state(false);
	let streaming = $state(false);
	let streamText = $state('');
	let streamRaw = $state('');
	let streamMetrics: RunMetrics | null = $state(null);
	let streamError: NormalizedError | null = $state(null);
	/** One shape for the action result and the stream outcome (PRD §18 panels). */
	interface RunView {
		response: string | null;
		metrics: RunMetrics | null;
		error: NormalizedError | null;
		keyContext: string | null;
	}
	const track = withPending((v) => (pending = v));
	// The form's `messages` field is the wire shape parsePlaygroundForm expects:
	// the PRD §18 minimum is one user message plus the optional system prompt.
	const messages = $derived(JSON.stringify([{ role: 'user', content: userPrompt }]));
	// The action's return value has this page's own RunView shape (declared
	// below); `form` is typed loosely by $props, so the cast is the boundary
	// and every read afterwards goes through the typed derived, never the cast.
	const actionResult = $derived<RunView | null>(form as RunView | null);
	const shownError = $derived(actionResult?.error ?? streamError);
	// While a stream is landing, its text IS the response — a loading skeleton
	// over already-arrived tokens would be a lie.
	const responseState = $derived(
		pending || (streaming && streamText === '' && streamRaw === '')
			? 'loading'
			: shownError
				? 'error'
				: actionResult === null && !streaming
					? 'empty'
					: 'success'
	);
	const displayText = $derived(
		streamText || streamRaw || actionResult?.response || ''
	);
	const shownMetrics = $derived(actionResult?.metrics ?? streamMetrics);
	async function runStream(): Promise<void> {
		const payload = {
			model,
			strategy,
			messages: JSON.parse(messages) as { role: string; content: string }[],
			system,
			temperature: temperature.trim() === '' ? null : Number(temperature),
			maxTokens: maxTokens.trim() === '' ? null : Number(maxTokens),
			tools: null,
			jsonMode: false,
			stream: true,
			keyId
		};
		streaming = true;
		streamText = '';
		streamRaw = '';
		streamMetrics = null;
		streamError = null;
		try {
			const res = await fetch('/playground/run', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok || !res.body) {
				const failed = (await res.json().catch(() => null)) as {
					error?: NormalizedError;
					metrics?: RunMetrics;
				} | null;
				streamError = failed?.error ?? {
					code: 'UPSTREAM_ERROR',
					message: 'The run failed to start.',
					requestId: null
				};
				streamMetrics = failed?.metrics ?? null;
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let raw = '';
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				raw += decoder.decode(value, { stream: true });
				streamRaw = raw;
				// The completion text is the delta accumulation; the raw SSE is the
				// fallback when the stream carried no content deltas at all.
				streamText = contentOf(raw);
				// The relay's final `event: metrics` frame is the panel's data.
				const marker = 'event: metrics\ndata: ';
				const at = raw.lastIndexOf(marker);
				if (at >= 0) {
					const payloadLine = raw.slice(at + marker.length).split('\n')[0];
					try {
						streamMetrics = JSON.parse(payloadLine) as RunMetrics;
					} catch {
						// Partial frame: the next chunk completes it.
					}
				}
			}
		} catch (e) {
			streamError = {
				code: 'UPSTREAM_ERROR',
				message: e instanceof Error ? e.message.slice(0, 500) : 'The stream failed.',
				requestId: null
			};
		} finally {
			streaming = false;
		}
	}
	/** Accumulate choices[].delta.content out of the relayed SSE text. */
	function contentOf(raw: string): string {
		let text = '';
		for (const line of raw.split('\n')) {
			if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
			try {
				const chunk = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: unknown } }[] };
				const delta = chunk.choices?.[0]?.delta?.content;
				if (typeof delta === 'string') text += delta;
			} catch {
				// Not a JSON chunk (or the metrics frame) — nothing to accumulate.
			}
		}
		return text;
	}
</script>

<PageHeader
	title="Playground"
	lede="Run a real request through the router — same auth, limits, routing and billing as production."
/>
<Guide id="playground" />
{#if !data.user}
	<!-- PRD §108 "permission denied", public shape: the full form is a demo,
	     nothing is sent, and the way out is one click. -->
	<div class="fr-feedback">
		<Alert tone="warning">
			<strong>What happened?</strong> This playground is in demo mode.<br />
			<strong>Why?</strong> You are not signed in, and a run executes as a real request in your key
			context.<br />
			<strong>What can I do?</strong> Nothing is sent while you are signed out. Create an account to
			run real requests, or log in.
			<div class="cta-row">
				<ButtonLink href="/signup" variant="primary">Get API Key</ButtonLink>
				<ButtonLink href="/login">Log in</ButtonLink>
			</div>
		</Alert>
	</div>
{/if}
<form
	class="panels"
	method="POST"
	use:enhance={track}
	onsubmit={(e) => {
		if (!stream) return;
		e.preventDefault();
		void runStream();
	}}
>
	<Section title="Configuration">
		<Field label="Model" hint="Canonical slug — what your app sends as model.">
			<Select name="model" bind:value={model}>
				{#each data.models as m (m.slug)}
					<option value={m.slug}>{m.slug === m.name ? m.name : `${m.name} — ${m.slug}`}</option>
				{/each}
			</Select>
		</Field>
		<Field label="Routing strategy" hint="This run only; the bound policy still caps attempts and timeout.">
			<Select name="strategy" bind:value={strategy}>
				{#each PLAYGROUND_STRATEGIES as s (s.value)}
					<option value={s.value}>{s.label}</option>
				{/each}
			</Select>
		</Field>
		<Field label="API key context" hint="The run executes as a short-lived key in this key's scope.">
			<Select name="keyId" bind:value={keyId}>
				<option value="">Platform defaults (no key)</option>
				{#each data.keys as k (k.id)}
					<option value={k.id}>{k.name}</option>
				{/each}
			</Select>
		</Field>
		<div class="row2">
			<Field label="Temperature (0–2)">
				<Input name="temperature" type="number" min="0" max="2" step="any" bind:value={temperature} />
			</Field>
			<Field label="Max tokens">
				<Input name="maxTokens" type="number" min="1" step="1" bind:value={maxTokens} />
			</Field>
		</div>
		<label class="toggle">
			<input type="checkbox" name="stream" bind:checked={stream} />
			Streaming (SSE)
		</label>
	</Section>
	<Section title="Prompt">
		<Field label="System prompt" hint="Optional — sent as the system message.">
			<Textarea name="system" bind:value={system} rows={3}></Textarea>
		</Field>
		<Field label="User prompt">
			<Textarea name="userPrompt" bind:value={userPrompt} rows={6}></Textarea>
		</Field>
		<input type="hidden" name="messages" value={messages} />
		<div class="run-row">
			<Button type="submit" variant="primary" disabled={!data.user} pending={pending || streaming}>
				{stream ? 'Run (stream)' : 'Run'}
			</Button>
			{#if !data.user}
				<span class="muted">Disabled in demo mode — no request is sent.</span>
			{/if}
		</div>
	</Section>
	<Section title="Response">
		<UxState
			state={responseState}
			emptyTitle="No run yet"
			emptyHint="Run a request to see its completion here."
			errorWhat={shownError ? `${shownError.code} — ${shownError.message}` : undefined}
			errorWhy="The run failed on the platform or the provider side. The code above is the taxonomy class."
			errorAction="Adjust the prompt or configuration and run again. The request ID below ties this run to the logs."
			errorRequestId={shownError?.requestId ?? undefined}
		>
			{#if displayText}
				<CodeBlock label="completion" code={displayText} />
			{:else}
				<CodeBlock label="completion" code="(empty completion)" />
			{/if}
		</UxState>
	</Section>
	<Section title="Metrics">
		{#if shownMetrics}
			{@const m = shownMetrics}
			<dl class="metrics">
				<dt class="fr-label">Provider</dt>
				<dd class="num">{m.provider ?? '—'}</dd>
				<dt class="fr-label">Model</dt>
				<dd class="num">{m.actualModel ?? '—'}</dd>
				<dt class="fr-label">Tokens in</dt>
				<dd class="num">{m.tokensIn === null ? '—' : formatTokens(m.tokensIn)}</dd>
				<dt class="fr-label">Tokens out</dt>
				<dd class="num">{m.tokensOut === null ? '—' : formatTokens(m.tokensOut)}</dd>
				<dt class="fr-label">Latency</dt>
				<dd class="num">{formatMs(m.latencyMs)}</dd>
				<dt class="fr-label">TTFT</dt>
				<dd class="num">{formatMs(m.ttftMs)}</dd>
				<dt class="fr-label">Cost</dt>
				<dd class="num">{m.costMicro === null ? '—' : formatCost(BigInt(m.costMicro))}</dd>
				<dt class="fr-label">Request ID</dt>
				<dd class="num">{m.requestId ? m.requestId : '—'}</dd>
			</dl>
			{#if actionResult?.keyContext}
				<p class="muted">Run key context: {actionResult.keyContext}</p>
			{/if}
		{:else}
			<UxState state="empty" emptyTitle="No metrics yet" emptyHint="A run's ledger numbers land here." />
		{/if}
	</Section>
</form>

<style>
	.panels {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--space-lg);
		padding-bottom: var(--space-2xl);
	}
	.row2 {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--space-md);
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: var(--space-xs);
		margin-top: var(--space-sm);
		font-size: var(--text-sm);
	}
	.run-row {
		display: flex;
		align-items: center;
		gap: var(--space-md);
		margin-top: var(--space-md);
	}
	.cta-row {
		display: flex;
		gap: var(--space-sm);
		margin-top: var(--space-sm);
	}
	.metrics {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		gap: var(--space-xs) var(--space-md);
	}
	.metrics dt {
		color: var(--color-text-muted);
	}
	.metrics dd {
		margin: 0;
		word-break: break-all;
	}
	@media (max-width: 900px) {
		.panels {
			grid-template-columns: 1fr;
		}
	}
</style>
