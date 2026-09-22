<script lang="ts">
	import { PageHeader } from '$lib/ui';
</script>

<PageHeader
	title="Privacy Policy"
	lede="Placeholder — reviewed and finalised before public launch."
/>

<section class="stack">
	<div>
		<h2>1. What we store</h2>
		<p>
			Your account email and name, API keys (stored only as a hash — the secret is shown once and
			never recoverable), and per-request metadata: model, token counts, cost, latency, and status.
		</p>
	</div>
	<div>
		<h2>2. What we do not store</h2>
		<p>
			We do not store prompt or completion content in the request log. Provider credentials are
			encrypted at rest and never returned by any API.
		</p>
	</div>
	<div>
		<h2>3. Retention</h2>
		<p>
			Usage records are retained for billing and abuse prevention. You may request deletion of your
			account and its data.
		</p>
	</div>
	<div>
		<h2>4. Contact</h2>
		<p>Reach the operator through your account email for any privacy request.</p>
	</div>
</section>

<style>
	section {
		max-width: 44rem;
	}
	h2 {
		margin-top: 0;
	}
</style>
