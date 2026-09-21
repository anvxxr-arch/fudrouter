import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { onMount } from 'svelte';
import { api } from '../lib/api/client';

var root = $.from_html(`<div class="space-y-6"><div><h3 class="text-xl font-semibold text-white">Combos</h3> <p class="text-sm text-gray-400 mt-1">Model combinations and routing rules</p></div> <div class="bg-card border border-border rounded-xl p-6 text-center"><p class="text-gray-400">Combos feature coming soon.</p> <p class="text-xs text-gray-500 mt-2">This will allow defining model fallback chains and routing rules.</p></div></div>`);

export default function Combos($$anchor, $$props) {
	$.push($$props, false);

	let combos = [];
	let loading = false;

	onMount(() => {
		loadCombos();
	});

	async function loadCombos() {
		loading = true;

		try {
			const res = await api.listConnections(); // placeholder

			combos = [];
		} catch(e) {
			// ignore
		} finally {
			loading = false;
		}
	}

	$.init();

	var div = root();

	$.append($$anchor, div);
	$.pop();
}