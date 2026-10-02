import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { onMount } from 'svelte';
import { apiKeys, loadApiKeys, createKey, deleteKey } from '../stores/app';

var root = $.from_html(`<div class="mt-3 bg-green-900/20 border border-green-800 rounded-lg p-3"><p class="text-xs text-green-400 mb-1">Key created (copy it now — it won't be shown again):</p> <code class="text-xs text-green-300 break-all"> </code></div>`);
var root_1 = $.from_html(`<p class="text-xs text-gray-500"> </p>`);
var root_2 = $.from_html(`<div class="bg-card border border-border rounded-xl p-4 flex items-center justify-between"><div><h4 class="font-medium text-white"> </h4> <p class="text-xs text-gray-400 font-mono"> </p> <!></div> <div class="flex items-center gap-2"><span> </span> <button class="text-xs bg-surface hover:bg-border text-gray-300 px-3 py-1.5 rounded-lg transition-colors border border-border">Copy</button> <button class="text-xs bg-red-900/20 hover:bg-red-900/40 text-red-300 px-3 py-1.5 rounded-lg transition-colors border border-red-900/30">Delete</button></div></div>`);
var root_3 = $.from_html(`<div class="text-center py-12 text-gray-500"><p>No API keys yet. Create one to get started.</p></div>`);
var root_4 = $.from_html(`<div class="space-y-6"><div class="flex items-center justify-between"><div><h3 class="text-xl font-semibold text-white">API Keys</h3> <p class="text-sm text-gray-400 mt-1">Manage access keys for the Go API</p></div></div> <div class="bg-card border border-border rounded-xl p-4"><h4 class="text-sm font-semibold text-white mb-3">Create New Key</h4> <div class="flex gap-2"><input class="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm" placeholder="Key name (e.g., My App)"/> <button class="bg-accent hover:bg-glow disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm transition-colors">Create</button></div> <!></div> <div class="space-y-2"></div> <!></div>`);

export default function ApiKeys($$anchor, $$props) {
	$.push($$props, false);

	const $apiKeys = () => $.store_get(apiKeys, '$apiKeys', $$stores);
	const [$$stores, $$cleanup] = $.setup_stores();

	onMount(() => {
		loadApiKeys();
	});

	let newKeyName = $.mutable_source('');
	let createdKey = $.mutable_source(null);

	async function handleCreate() {
		if (!$.get(newKeyName)) return;

		const res = await createKey($.get(newKeyName));

		$.set(createdKey, res.key);
		$.set(newKeyName, '');
		await loadApiKeys();
	}

	async function handleDelete(id) {
		if (confirm('Delete this API key?')) {
			await deleteKey(id);
		}
	}

	function copyKey(key) {
		navigator.clipboard.writeText(key);
	}

	$.init();

	var div = root_4();
	var div_1 = $.sibling($.child(div), 2);
	var div_2 = $.sibling($.child(div_1), 2);
	var input = $.child(div_2);

	$.remove_input_defaults(input);

	var button = $.sibling(input, 2);

	$.reset(div_2);

	var node = $.sibling(div_2, 2);

	{
		var consequent = ($$anchor) => {
			var div_3 = root();
			var code = $.sibling($.child(div_3), 2);
			var text = $.only_child(code, true);

			$.reset(div_3);
			$.template_effect(() => $.set_text(text, $.get(createdKey)));
			$.append($$anchor, div_3);
		};

		$.if(node, ($$render) => {
			if ($.get(createdKey)) $$render(consequent);
		});
	}

	$.reset(div_1);

	var div_4 = $.sibling(div_1, 2);

	$.each(div_4, 5, $apiKeys, $.index, ($$anchor, key) => {
		var div_5 = root_2();
		var div_6 = $.child(div_5);
		var h4 = $.child(div_6);
		var text_1 = $.only_child(h4, true);
		var p = $.sibling(h4, 2);
		var text_2 = $.only_child(p, true);
		var node_1 = $.sibling(p, 2);

		{
			var consequent_1 = ($$anchor) => {
				var p_1 = root_1();
				var text_3 = $.only_child(p_1);

				$.template_effect(() => $.set_text(text_3, `Machine: ${$.get(key).machineId ?? ''}`));
				$.append($$anchor, p_1);
			};

			$.if(node_1, ($$render) => {
				if ($.get(key).machineId) $$render(consequent_1);
			});
		}

		$.reset(div_6);

		var div_7 = $.sibling(div_6, 2);
		var span = $.child(div_7);
		var text_4 = $.only_child(span, true);
		var button_1 = $.sibling(span, 2);
		var button_2 = $.sibling(button_1, 2);

		$.reset(div_7);
		$.reset(div_5);

		$.template_effect(() => {
			$.set_text(text_1, $.get(key).name);
			$.set_text(text_2, $.get(key).key);

			$.set_class(span, 1, `text-xs px-2 py-0.5 rounded-full ${$.get(key).isActive
				? 'bg-green-900/30 text-green-400'
				: 'bg-gray-800 text-gray-500'}`);

			$.set_text(text_4, $.get(key).isActive ? 'Active' : 'Inactive');
		});

		$.event('click', button_1, () => copyKey($.get(key).key));
		$.event('click', button_2, () => handleDelete($.get(key).id));
		$.append($$anchor, div_5);
	});

	$.reset(div_4);

	var node_2 = $.sibling(div_4, 2);

	{
		var consequent_2 = ($$anchor) => {
			var div_8 = root_3();

			$.append($$anchor, div_8);
		};

		$.if(node_2, ($$render) => {
			if ($apiKeys().length === 0) $$render(consequent_2);
		});
	}

	$.reset(div);
	$.template_effect(() => button.disabled = !$.get(newKeyName));
	$.bind_value(input, () => $.get(newKeyName), ($$value) => $.set(newKeyName, $$value));
	$.event('click', button, handleCreate);
	$.append($$anchor, div);
	$.pop();
	$$cleanup();
}