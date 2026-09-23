<script lang="ts">
	import { CodeBlock, Guide, PageHeader } from '$lib/ui';

	// Code samples live in JS strings so their `{` / `}` are never parsed as
	// Svelte expressions.
	const chatCurl = `curl https://ai.karepmuwes.my.id/v1/chat/completions \\
  -H "Authorization: Bearer $FUDROUTER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "grok-4.6",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'`;

	const modelsCurl = `curl https://ai.karepmuwes.my.id/v1/models \\
  -H "Authorization: Bearer $FUDROUTER_KEY"`;

	const healthCurl = `curl https://ai.karepmuwes.my.id/health`;
	const errShape = `{"error":{"message":"…"}}`;
</script>

<PageHeader
	title="API reference"
	lede="[OI]-compatible. Authenticate with Authorization: Bearer sk-ar-…"
/>

<Guide id="docs" />

<section class="stack">
	<div>
		<h2>POST /v1/chat/completions</h2>
		<CodeBlock label="curl" code={chatCurl} />
		<p class="muted">
			Set <code>"stream": true</code> for SSE. The final chunk carries a <code>usage</code> object.
		</p>
	</div>

	<div>
		<h2>GET /v1/models</h2>
		<CodeBlock label="curl" code={modelsCurl} />
	</div>

	<div>
		<h2>GET /health</h2>
		<CodeBlock label="curl" code={healthCurl} />
	</div>

	<div>
		<h2>Errors</h2>
		<p class="muted">
			Failures return <code>{errShape}</code> with a 4xx/5xx status. A missing, malformed, or
			revoked key returns <code>401</code>.
		</p>
	</div>
</section>
