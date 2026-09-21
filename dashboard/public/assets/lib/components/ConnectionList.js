import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { onMount } from 'svelte';

import {
	connections,
	loadConnections,
	createConnection,
	updateConnection,
	deleteConnection,
	testConnection,
	providers
} from '../stores/app';

var root = $.from_html(`<option> </option>`);
var root_1 = $.from_html(`<div class="bg-card border border-border rounded-xl p-4"><h4 class="text-sm font-semibold text-white mb-3"> </h4> <form class="grid grid-cols-1 md:grid-cols-2 gap-3"><div><label class="block text-xs text-gray-400 mb-1">Provider</label> <select class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm"><option>Select provider</option><!></select></div> <div><label class="block text-xs text-gray-400 mb-1">Name</label> <input class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm" placeholder="My Connection"/></div> <div><label class="block text-xs text-gray-400 mb-1">Auth Type</label> <select class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm"><option>API Key</option><option>OAuth</option></select></div> <div><label class="block text-xs text-gray-400 mb-1">Base URL</label> <input class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm" placeholder="https://api.example.com"/></div> <div><label class="block text-xs text-gray-400 mb-1">API Key</label> <input type="password" class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm" placeholder="sk-..."/></div> <div><label class="block text-xs text-gray-400 mb-1">Priority</label> <input type="number" class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm"/></div> <div class="md:col-span-2 flex items-center gap-3"><label class="flex items-center gap-2 text-sm text-gray-300"><input type="checkbox" class="rounded"/> Active</label></div> <div class="md:col-span-2 flex gap-2"><button type="submit" class="bg-accent hover:bg-glow text-white px-4 py-2 rounded-lg text-sm transition-colors"> </button> <button type="button" class="bg-surface hover:bg-border text-gray-300 px-4 py-2 rounded-lg text-sm transition-colors border border-border">Cancel</button></div></form></div>`);
var root_2 = $.from_html(`<div class="bg-card border border-border rounded-xl p-4 flex items-center justify-between"><div class="flex items-center gap-4"><div class="w-10 h-10 rounded-lg bg-surface flex items-center justify-center text-lg"> </div> <div><h4 class="font-medium text-white"> </h4> <p class="text-xs text-gray-400"> </p></div></div> <div class="flex items-center gap-2"><span> </span> <button class="text-xs bg-surface hover:bg-border text-gray-300 px-3 py-1.5 rounded-lg transition-colors border border-border">Test</button> <button class="text-xs bg-surface hover:bg-border text-gray-300 px-3 py-1.5 rounded-lg transition-colors border border-border">Edit</button> <button class="text-xs bg-red-900/20 hover:bg-red-900/40 text-red-300 px-3 py-1.5 rounded-lg transition-colors border border-red-900/30">Delete</button></div></div>`);
var root_3 = $.from_html(`<div class="text-center py-12 text-gray-500"><p>No connections yet. Add your first provider connection.</p></div>`);
var root_4 = $.from_html(`<div class="space-y-6"><div class="flex items-center justify-between"><div><h3 class="text-xl font-semibold text-white">Connections</h3> <p class="text-sm text-gray-400 mt-1">Manage your provider connections</p></div> <button class="text-sm bg-accent hover:bg-glow text-white px-4 py-2 rounded-lg transition-colors">+ Add Connection</button></div> <!> <div class="space-y-2"></div> <!></div>`);

export default function ConnectionList($$anchor, $$props) {
	$.push($$props, false);

	const $providers = () => $.store_get(providers, '$providers', $$stores);
	const $connections = () => $.store_get(connections, '$connections', $$stores);
	const [$$stores, $$cleanup] = $.setup_stores();

	onMount(() => {
		loadConnections();
	});

	let showForm = $.mutable_source(false);
	let editingId = $.mutable_source(null);

	let form = $.mutable_source({
		provider: '',
		name: '',
		authType: 'apikey',
		base_url: '',
		apiKey: '',
		priority: 0,
		isActive: true
	});

	function resetForm() {
		$.set(form, {
			provider: '',
			name: '',
			authType: 'apikey',
			base_url: '',
			apiKey: '',
			priority: 0,
			isActive: true
		});

		$.set(editingId, null);
		$.set(showForm, false);
	}

	function editConnection(conn) {
		$.set(editingId, conn.id);

		$.set(form, {
			provider: conn.provider,
			name: conn.name,
			authType: conn.authType || 'apikey',
			base_url: conn.base_url || '',
			apiKey: '',
			priority: conn.priority || 0,
			isActive: conn.isActive
		});

		$.set(showForm, true);
	}

	async function handleSubmit() {
		if (!$.get(form).provider || !$.get(form).name) return;

		if ($.get(editingId)) {
			await updateConnection($.get(editingId), $.get(form));
		} else {
			await createConnection($.get(form));
		}

		resetForm();
	}

	async function handleDelete(id) {
		if (confirm('Delete this connection?')) {
			await deleteConnection(id);
		}
	}

	async function handleTest(id) {
		const res = await testConnection(id);

		alert(`Status: ${res.status}\nMessage: ${res.message}`);
	}

	$.init();

	var div = root_4();
	var div_1 = $.child(div);
	var button = $.sibling($.child(div_1), 2);

	$.reset(div_1);

	var node = $.sibling(div_1, 2);

	{
		var consequent = ($$anchor) => {
			var div_2 = root_1();
			var h4 = $.child(div_2);
			var text = $.only_child(h4);
			var form_1 = $.sibling(h4, 2);
			var div_3 = $.child(form_1);
			var select = $.sibling($.child(div_3), 2);
			var option = $.child(select);

			option.value = option.__value = '';

			var node_1 = $.sibling(option);

			$.each(node_1, 1, $providers, $.index, ($$anchor, p) => {
				var option_1 = root();
				var text_1 = $.only_child(option_1, true);
				var option_1_value = {};

				$.template_effect(() => {
					$.set_text(text_1, $.get(p).name);

					if (option_1_value !== (option_1_value = $.get(p).id)) {
						option_1.value = (option_1.__value = option_1_value) ?? '';
					}
				});

				$.append($$anchor, option_1);
			});

			$.reset(select);
			$.init_select(select);
			$.reset(div_3);

			var div_4 = $.sibling(div_3, 2);
			var input = $.sibling($.child(div_4), 2);

			$.remove_input_defaults(input);
			$.reset(div_4);

			var div_5 = $.sibling(div_4, 2);
			var select_1 = $.sibling($.child(div_5), 2);
			var option_2 = $.child(select_1);

			option_2.value = option_2.__value = 'apikey';

			var option_3 = $.sibling(option_2);

			option_3.value = option_3.__value = 'oauth';
			$.reset(select_1);
			$.init_select(select_1);
			$.reset(div_5);

			var div_6 = $.sibling(div_5, 2);
			var input_1 = $.sibling($.child(div_6), 2);

			$.remove_input_defaults(input_1);
			$.reset(div_6);

			var div_7 = $.sibling(div_6, 2);
			var input_2 = $.sibling($.child(div_7), 2);

			$.remove_input_defaults(input_2);
			$.reset(div_7);

			var div_8 = $.sibling(div_7, 2);
			var input_3 = $.sibling($.child(div_8), 2);

			$.remove_input_defaults(input_3);
			$.reset(div_8);

			var div_9 = $.sibling(div_8, 2);
			var label = $.child(div_9);
			var input_4 = $.child(label);

			$.remove_input_defaults(input_4);
			$.next();
			$.reset(label);
			$.reset(div_9);

			var div_10 = $.sibling(div_9, 2);
			var button_1 = $.child(div_10);
			var text_2 = $.only_child(button_1, true);
			var button_2 = $.sibling(button_1, 2);

			$.reset(div_10);
			$.reset(form_1);
			$.reset(div_2);

			$.template_effect(() => {
				$.set_text(text, `${$.get(editingId) ? 'Edit' : 'New'} Connection`);
				$.set_text(text_2, $.get(editingId) ? 'Update' : 'Create');
			});

			$.bind_select_value(select, () => $.get(form).provider, ($$value) => (
				$.mutate(form, $.get(form).provider = $$value),
				$.invalidate_inner_signals(() => {
					$providers();
				})
			));

			$.bind_value(input, () => $.get(form).name, ($$value) => (
				$.mutate(form, $.get(form).name = $$value),
				$.invalidate_inner_signals(() => {
					$providers();
				})
			));

			$.bind_select_value(select_1, () => $.get(form).authType, ($$value) => (
				$.mutate(form, $.get(form).authType = $$value),
				$.invalidate_inner_signals(() => {
					$providers();
				})
			));

			$.bind_value(input_1, () => $.get(form).base_url, ($$value) => (
				$.mutate(form, $.get(form).base_url = $$value),
				$.invalidate_inner_signals(() => {
					$providers();
				})
			));

			$.bind_value(input_2, () => $.get(form).apiKey, ($$value) => (
				$.mutate(form, $.get(form).apiKey = $$value),
				$.invalidate_inner_signals(() => {
					$providers();
				})
			));

			$.bind_value(input_3, () => $.get(form).priority, ($$value) => (
				$.mutate(form, $.get(form).priority = $$value),
				$.invalidate_inner_signals(() => {
					$providers();
				})
			));

			$.bind_checked(input_4, () => $.get(form).isActive, ($$value) => (
				$.mutate(form, $.get(form).isActive = $$value),
				$.invalidate_inner_signals(() => {
					$providers();
				})
			));

			$.event('click', button_2, resetForm);
			$.event('submit', form_1, $.preventDefault(handleSubmit));
			$.append($$anchor, div_2);
		};

		$.if(node, ($$render) => {
			if ($.get(showForm)) $$render(consequent);
		});
	}

	var div_11 = $.sibling(node, 2);

	$.each(div_11, 5, $connections, $.index, ($$anchor, conn) => {
		var div_12 = root_2();
		var div_13 = $.child(div_12);
		var div_14 = $.child(div_13);
		var text_3 = $.only_child(div_14, true);
		var div_15 = $.sibling(div_14, 2);
		var h4_1 = $.child(div_15);
		var text_4 = $.only_child(h4_1, true);
		var p_1 = $.sibling(h4_1, 2);
		var text_5 = $.only_child(p_1);

		$.reset(div_15);
		$.reset(div_13);

		var div_16 = $.sibling(div_13, 2);
		var span = $.child(div_16);
		var text_6 = $.only_child(span, true);
		var button_3 = $.sibling(span, 2);
		var button_4 = $.sibling(button_3, 2);
		var button_5 = $.sibling(button_4, 2);

		$.reset(div_16);
		$.reset(div_12);

		$.template_effect(() => {
			$.set_text(text_3, $.get(conn).authType === 'oauth' ? '🔐' : '🔑');
			$.set_text(text_4, $.get(conn).name);
			$.set_text(text_5, `${$.get(conn).provider ?? ''} · ${$.get(conn).authType ?? ''} · Priority ${$.get(conn).priority ?? ''}`);

			$.set_class(span, 1, `text-xs px-2 py-0.5 rounded-full ${$.get(conn).isActive
				? 'bg-green-900/30 text-green-400'
				: 'bg-gray-800 text-gray-500'}`);

			$.set_text(text_6, $.get(conn).isActive ? 'Active' : 'Inactive');
		});

		$.event('click', button_3, () => handleTest($.get(conn).id));
		$.event('click', button_4, () => editConnection($.get(conn)));
		$.event('click', button_5, () => handleDelete($.get(conn).id));
		$.append($$anchor, div_12);
	});

	$.reset(div_11);

	var node_2 = $.sibling(div_11, 2);

	{
		var consequent_1 = ($$anchor) => {
			var div_17 = root_3();

			$.append($$anchor, div_17);
		};

		$.if(node_2, ($$render) => {
			if ($connections().length === 0) $$render(consequent_1);
		});
	}

	$.reset(div);

	$.event('click', button, () => {
		resetForm();
		$.set(showForm, true);
	});

	$.append($$anchor, div);
	$.pop();
	$$cleanup();
}