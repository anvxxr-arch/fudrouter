<script lang="ts">
	// Atom: the scene edge. A hairline that fades out at both ends, drawn where
	// two scenes share one background — a solid border there would read as a
	// table rule. Decorative: a screen reader gains nothing from hearing it.
	let { class: klass = '' }: { class?: string } = $props();
</script>

<div class="fr-visual-divider {klass}" aria-hidden="true"></div>
