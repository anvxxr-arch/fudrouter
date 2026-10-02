import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { onMount } from 'svelte';
import { api } from '../lib/api/client';
import { providers, activeProvider } from '../stores/app';

var root = $.from_html(`<option> </option>`);
var root_1 = $.from_html(`<div class="text-center py-12 text-gray-500">Loading models...</div>`);
var root_2 = $.from_html(`<div class="bg-red-900/30 border border-red-800 text-red-300 px-4 py-3 rounded-lg"> </div>`);
var root_3 = $.from_html(`<span class="text-xs text-gray-500"> </span>`);
var root_4 = $.from_html(`<p class="text-xs text-gray-400"> </p>`);
var root_5 = $.from_html(`<div class="bg-card border border-border rounded-lg p-3"><div class="flex items-center justify-between mb-1"><span class="text-sm font-medium text-white"> </span> <!></div> <!></div>`);
var root_6 = $.from_html(`<div class="text-center py-12 text-gray-500">No models found for this provider</div>`);
var root_7 = $.from_html(`<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"></div> <!>`, 1);
var root_8 = $.from_html(`<div class="text-center py-12 text-gray-500">Select a provider to browse models</div>`);
var root_9 = $.from_html(`<div class="space-y-6"><div class="flex items-center justify-between"><div><h3 class="text-xl font-semibold text-white">Model Browser</h3> <p class="text-sm text-gray-400 mt-1">Browse available models per provider</p></div> <select class="bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm"><option>Select provider</option><!></select></div> <!></div>`);

export default function ModelBrowser($$anchor, $$props) {
	$.push($$props, false);

	const $activeProvider = () => $.store_get(activeProvider, '$activeProvider', $$stores);
	const $providers = () => $.store_get(providers, '$providers', $$stores);
	const [$$stores, $$cleanup] = $.setup_stores();
	let models = $.mutable_source([]);
	let loading = $.mutable_source(false);
	let error = $.mutable_source('');

	onMount(() => {
		if ($activeProvider()) {
			loadModels($activeProvider());
		}
	});

	async function loadModels(providerId) {
		$.set(loading, true);
		$.set(error, '');

		try {
			const res = await api.listProviderModels(providerId);

			$.set(models, res.models);
		} catch(e) {
			$.set(error, String(e));
		} finally {
			$.set(loading, false);
		}
	}

	$.legacy_pre_effect(() => ($activeProvider()), () => {
		if ($activeProvider()) {
			loadModels($activeProvider());
		}
	});

	$.legacy_pre_effect_reset();
	$.init();

	var div = root_9();
	var div_1 = $.child(div);
	var select = $.sibling($.child(div_1), 2);
	var option = $.child(select);

	option.value = option.__value = '';

	var node = $.sibling(option);

	$.each(node, 1, $providers, $.index, ($$anchor, p) => {
		var option_1 = root();
		var text = $.only_child(option_1, true);
		var option_1_value = {};

		$.template_effect(() => {
			$.set_text(text, ($.get(p), $.untrack(() => $.get(p).name)));

			if (option_1_value !== (option_1_value = ($.get(p), $.untrack(() => $.get(p).id)))) {
				option_1.value = (option_1.__value = option_1_value) ?? '';
			}
		});

		$.append($$anchor, option_1);
	});

	$.reset(select);
	$.init_select(select);
	$.reset(div_1);

	var node_1 = $.sibling(div_1, 2);

	{
		var consequent = ($$anchor) => {
			var div_2 = root_1();

			$.append($$anchor, div_2);
		};

		var consequent_1 = ($$anchor) => {
			var div_3 = root_2();
			var text_1 = $.only_child(div_3, true);

			$.template_effect(() => $.set_text(text_1, $.get(error)));
			$.append($$anchor, div_3);
		};

		var consequent_5 = ($$anchor) => {
			var fragment = root_7();
			var div_4 = $.first_child(fragment);

			$.each(div_4, 5, () => $.get(models), $.index, ($$anchor, model) => {
				var div_5 = root_5();
				var div_6 = $.child(div_5);
				var span = $.child(div_6);
				var text_2 = $.only_child(span, true);
				var node_2 = $.sibling(span, 2);

				{
					var consequent_2 = ($$anchor) => {
						var span_1 = root_3();
						var text_3 = $.only_child(span_1, true);

						$.template_effect(() => $.set_text(text_3, ($.get(model), $.untrack(() => $.get(model).owned_by))));
						$.append($$anchor, span_1);
					};

					$.if(node_2, ($$render) => {
						if (($.get(model), $.untrack(() => $.get(model).owned_by))) $$render(consequent_2);
					});
				}

				$.reset(div_6);

				var node_3 = $.sibling(div_6, 2);

				{
					var consequent_3 = ($$anchor) => {
						var p_1 = root_4();
						var text_4 = $.only_child(p_1, true);

						$.template_effect(() => $.set_text(text_4, ($.get(model), $.untrack(() => $.get(model).description))));
						$.append($$anchor, p_1);
					};

					$.if(node_3, ($$render) => {
						if (($.get(model), $.untrack(() => $.get(model).description))) $$render(consequent_3);
					});
				}

				$.reset(div_5);

				$.template_effect(() => $.set_text(text_2, (
					$.get(model),
					$.untrack(() => $.get(model).id || $.get(model).name || 'Unknown')
				)));

				$.append($$anchor, div_5);
			});

			$.reset(div_4);

			var node_4 = $.sibling(div_4, 2);

			{
				var consequent_4 = ($$anchor) => {
					var div_7 = root_6();

					$.append($$anchor, div_7);
				};

				$.if(node_4, ($$render) => {
					if (($.get(models), $.untrack(() => $.get(models).length === 0))) $$render(consequent_4);
				});
			}

			$.append($$anchor, fragment);
		};

		var alternate = ($$anchor) => {
			var div_8 = root_8();

			$.append($$anchor, div_8);
		};

		$.if(node_1, ($$render) => {
			if ($.get(loading)) $$render(consequent); else if ($.get(error)) $$render(consequent_1, 1); else if ($activeProvider()) $$render(consequent_5, 2); else $$render(alternate, -1);
		});
	}

	$.reset(div);
	$.bind_select_value(select, $activeProvider, ($$value) => $.store_set(activeProvider, $$value));
	$.append($$anchor, div);
	$.pop();
	$$cleanup();
}