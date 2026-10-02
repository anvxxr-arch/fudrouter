import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { onMount } from 'svelte';
import { settings, loadSettings, patchSettings } from '../stores/app';

var root = $.from_html(`<div class="space-y-6"><div><h3 class="text-xl font-semibold text-white">Settings</h3> <p class="text-sm text-gray-400 mt-1">Configure your Fudrouter instance</p></div> <div class="bg-card border border-border rounded-xl p-4 space-y-4"><h4 class="text-sm font-semibold text-white">Security</h4> <div class="flex items-center justify-between"><div><p class="text-sm text-white">Require Login</p> <p class="text-xs text-gray-400">Force authentication for dashboard access</p></div> <button><span></span></button></div> <div><label class="block text-xs text-gray-400 mb-1">Change Password</label> <div class="flex gap-2"><input class="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm" placeholder="New password"/> <button class="bg-accent hover:bg-glow text-white px-4 py-2 rounded-lg text-sm transition-colors">Set</button></div></div></div> <div class="bg-card border border-border rounded-xl p-4 space-y-4"><h4 class="text-sm font-semibold text-white">Routing</h4> <div><label class="block text-xs text-gray-400 mb-1">Fallback Strategy</label> <select class="w-full bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm"><option>Fill First (priority order)</option><option>Race (fastest wins)</option></select></div></div> <div class="bg-card border border-border rounded-xl p-4 space-y-4"><h4 class="text-sm font-semibold text-white">API</h4> <div><p class="text-xs text-gray-400 mb-2">API Base URL</p> <code class="text-xs bg-surface text-glow px-3 py-1.5 rounded-lg block">http://127.0.0.1:8011</code></div></div></div>`);

export default function Settings($$anchor, $$props) {
	$.push($$props, false);

	const $settings = () => $.store_get(settings, '$settings', $$stores);
	const [$$stores, $$cleanup] = $.setup_stores();

	onMount(() => {
		loadSettings();
	});

	let newPassword = $.mutable_source('');
	let showPassword = false;

	async function handleSetPassword() {
		if (!$.get(newPassword)) return;

		await patchSettings({ password: $.get(newPassword) });
		$.set(newPassword, '');
		alert('Password updated!');
	}

	async function handleToggleLogin() {
		await patchSettings({ requireLogin: !$settings().requireLogin });
	}

	async function handleChangeStrategy(e) {
		const value = e.target.value;

		await patchSettings({ fallbackStrategy: value });
	}

	$.init();

	var div = root();
	var div_1 = $.sibling($.child(div), 2);
	var div_2 = $.sibling($.child(div_1), 2);
	var button = $.sibling($.child(div_2), 2);
	var span = $.only_child(button);

	$.reset(div_2);

	var div_3 = $.sibling(div_2, 2);
	var div_4 = $.sibling($.child(div_3), 2);
	var input = $.child(div_4);

	$.remove_input_defaults(input);
	$.set_attribute(input, 'type', showPassword ? 'text' : 'password');

	var button_1 = $.sibling(input, 2);

	$.reset(div_4);
	$.reset(div_3);
	$.reset(div_1);

	var div_5 = $.sibling(div_1, 2);
	var div_6 = $.sibling($.child(div_5), 2);
	var select = $.sibling($.child(div_6), 2);
	var option = $.child(select);

	option.value = option.__value = 'fill-first';

	var option_1 = $.sibling(option);

	option_1.value = option_1.__value = 'race';
	$.reset(select);

	var select_value;

	$.init_select(select);
	$.reset(div_6);
	$.reset(div_5);
	$.next(2);
	$.reset(div);

	$.template_effect(() => {
		$.set_class(button, 1, `relative w-12 h-6 rounded-full transition-colors ${$settings().requireLogin ? 'bg-accent' : 'bg-gray-700'}`);
		$.set_class(span, 1, `absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${$settings().requireLogin ? 'translate-x-6' : ''}`);

		if (select_value !== (select_value = $settings().fallbackStrategy || 'fill-first')) {
			(
				select.value = (select.__value = select_value) ?? '',
				$.select_option(select, select_value)
			);
		}
	});

	$.event('click', button, handleToggleLogin);
	$.bind_value(input, () => $.get(newPassword), ($$value) => $.set(newPassword, $$value));
	$.event('click', button_1, handleSetPassword);
	$.event('change', select, handleChangeStrategy);
	$.append($$anchor, div);
	$.pop();
	$$cleanup();
}