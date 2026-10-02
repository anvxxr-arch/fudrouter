import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { onMount } from 'svelte';
import { checkAuth, isAuthenticated, isLoading, error, loadAll } from './lib/stores/app';
import Login from './lib/components/Login.js';
import Dashboard from './lib/components/Dashboard.js';

var root = $.from_html(`<div class="flex items-center justify-center min-h-screen bg-ink"><div class="text-glow animate-pulse">Loading...</div></div>`);
var root_1 = $.from_html(`<div class="fixed bottom-4 right-4 bg-red-900/80 text-red-200 px-4 py-2 rounded-lg text-sm max-w-md"> </div>`);
var root_2 = $.from_html(`<!> <!>`, 1);

export default function App($$anchor, $$props) {
	$.push($$props, false);

	const $isAuthenticated = () => $.store_get(isAuthenticated, '$isAuthenticated', $$stores);
	const $error = () => $.store_get(error, '$error', $$stores);
	const [$$stores, $$cleanup] = $.setup_stores();
	let ready = $.mutable_source(false);

	onMount(async () => {
		const authed = await checkAuth();

		if (authed) {
			await loadAll();
		}

		$.set(ready, true);
	});

	$.init();

	var fragment = root_2();
	var node = $.first_child(fragment);

	{
		var consequent = ($$anchor) => {
			var div = root();

			$.append($$anchor, div);
		};

		var consequent_1 = ($$anchor) => {
			Dashboard($$anchor, {});
		};

		var alternate = ($$anchor) => {
			Login($$anchor, {});
		};

		$.if(node, ($$render) => {
			if (!$.get(ready)) $$render(consequent); else if ($isAuthenticated()) $$render(consequent_1, 1); else $$render(alternate, -1);
		});
	}

	var node_1 = $.sibling(node, 2);

	{
		var consequent_2 = ($$anchor) => {
			var div_1 = root_1();
			var text = $.only_child(div_1, true);

			$.template_effect(() => $.set_text(text, $error()));
			$.append($$anchor, div_1);
		};

		$.if(node_1, ($$render) => {
			if ($error()) $$render(consequent_2);
		});
	}

	$.append($$anchor, fragment);
	$.pop();
	$$cleanup();
}