import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { onMount } from 'svelte';
import { providers, loadProviders, activeProvider } from '../stores/app';

var root = $.from_html(`<p class="text-sm text-gray-400 mb-3"> </p>`);
var root_1 = $.from_html(`<span class="text-xs bg-accent/10 text-glow px-2 py-0.5 rounded-full border border-accent/20"> </span>`);
var root_2 = $.from_html(`<div class="flex flex-wrap gap-1"></div>`);
var root_3 = $.from_html(`<button class="bg-card border border-border rounded-xl p-4 text-left hover:border-accent/50 transition-colors group"><div class="flex items-start justify-between mb-2"><h4 class="font-semibold text-white group-hover:text-glow transition-colors"> </h4> <span class="text-xs bg-surface text-gray-400 px-2 py-0.5 rounded-full"> </span></div> <!> <!></button>`);
var root_4 = $.from_html(`<div class="text-center py-12 text-gray-500"><p>No providers available</p></div>`);
var root_5 = $.from_html(`<div class="space-y-6"><div class="flex items-center justify-between"><div><h3 class="text-xl font-semibold text-white">Providers</h3> <p class="text-sm text-gray-400 mt-1">Available AI providers and their status</p></div> <button class="text-sm bg-surface hover:bg-border text-gray-300 px-4 py-2 rounded-lg transition-colors border border-border">🔄 Refresh</button></div> <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"></div> <!></div>`);

export default function ProviderList($$anchor, $$props) {
	$.push($$props, false);

	const $providers = () => $.store_get(providers, '$providers', $$stores);
	const [$$stores, $$cleanup] = $.setup_stores();

	onMount(() => {
		loadProviders();
	});

	function selectProvider(id) {
		activeProvider.set(id);
	}

	$.init();

	var div = root_5();
	var div_1 = $.child(div);
	var button = $.sibling($.child(div_1), 2);

	$.reset(div_1);

	var div_2 = $.sibling(div_1, 2);

	$.each(div_2, 5, $providers, $.index, ($$anchor, provider) => {
		var button_1 = root_3();
		var div_3 = $.child(button_1);
		var h4 = $.child(div_3);
		var text = $.only_child(h4, true);
		var span = $.sibling(h4, 2);
		var text_1 = $.only_child(span, true);

		$.reset(div_3);

		var node = $.sibling(div_3, 2);

		{
			var consequent = ($$anchor) => {
				var p = root();
				var text_2 = $.only_child(p, true);

				$.template_effect(() => $.set_text(text_2, $.get(provider).description));
				$.append($$anchor, p);
			};

			$.if(node, ($$render) => {
				if ($.get(provider).description) $$render(consequent);
			});
		}

		var node_1 = $.sibling(node, 2);

		{
			var consequent_1 = ($$anchor) => {
				var div_4 = root_2();

				$.each(div_4, 5, () => $.get(provider).authModes, $.index, ($$anchor, mode) => {
					var span_1 = root_1();
					var text_3 = $.only_child(span_1, true);

					$.template_effect(() => $.set_text(text_3, $.get(mode)));
					$.append($$anchor, span_1);
				});

				$.reset(div_4);
				$.append($$anchor, div_4);
			};

			$.if(node_1, ($$render) => {
				if ($.get(provider).authModes) $$render(consequent_1);
			});
		}

		$.reset(button_1);

		$.template_effect(() => {
			$.set_text(text, $.get(provider).name);
			$.set_text(text_1, $.get(provider).id);
		});

		$.event('click', button_1, () => selectProvider($.get(provider).id));
		$.append($$anchor, button_1);
	});

	$.reset(div_2);

	var node_2 = $.sibling(div_2, 2);

	{
		var consequent_2 = ($$anchor) => {
			var div_5 = root_4();

			$.append($$anchor, div_5);
		};

		$.if(node_2, ($$render) => {
			if ($providers().length === 0) $$render(consequent_2);
		});
	}

	$.reset(div);

	$.event('click', button, function (...$$args) {
		loadProviders?.apply(this, $$args);
	});

	$.append($$anchor, div);
	$.pop();
	$$cleanup();
}