import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { login, isLoading, error } from '../stores/app';

var root = $.from_html(`<div class="bg-red-900/30 border border-red-800 text-red-300 px-3 py-2 rounded-lg text-sm"> </div>`);
var root_1 = $.from_html(`<div class="min-h-screen bg-ink flex items-center justify-center p-4"><div class="w-full max-w-md"><div class="text-center mb-8"><h1 class="text-4xl font-bold text-glow mb-2">Fudrouter</h1> <p class="text-gray-400">One API for every provider</p></div> <div class="bg-card border border-border rounded-xl p-6"><h2 class="text-xl font-semibold text-white mb-4">Login</h2> <form class="space-y-4"><div><label class="block text-sm text-gray-400 mb-1">Password</label> <div class="relative"><input class="w-full bg-surface border border-border rounded-lg px-4 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:border-accent transition-colors" placeholder="Enter password"/> <button type="button" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"> </button></div></div> <!> <button type="submit" class="w-full bg-accent hover:bg-glow disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg transition-colors"> </button></form></div> <p class="text-center text-gray-600 text-xs mt-4">Fudrouter v1.0.0 — Go API + Svelte Dashboard</p></div></div>`);

export default function Login($$anchor, $$props) {
	$.push($$props, false);

	const $error = () => $.store_get(error, '$error', $$stores);
	const $isLoading = () => $.store_get(isLoading, '$isLoading', $$stores);
	const [$$stores, $$cleanup] = $.setup_stores();
	let password = $.mutable_source('');
	let showPassword = $.mutable_source(false);

	async function handleLogin() {
		if (!$.get(password)) return;

		await login($.get(password));
		$.set(password, '');
	}

	$.init();

	var div = root_1();
	var div_1 = $.child(div);
	var div_2 = $.sibling($.child(div_1), 2);
	var form = $.sibling($.child(div_2), 2);
	var div_3 = $.child(form);
	var div_4 = $.sibling($.child(div_3), 2);
	var input = $.child(div_4);

	$.remove_input_defaults(input);
	$.autofocus(input, true);

	var button = $.sibling(input, 2);
	var text = $.only_child(button, true);

	$.reset(div_4);
	$.reset(div_3);

	var node = $.sibling(div_3, 2);

	{
		var consequent = ($$anchor) => {
			var div_5 = root();
			var text_1 = $.only_child(div_5, true);

			$.template_effect(() => $.set_text(text_1, $error()));
			$.append($$anchor, div_5);
		};

		$.if(node, ($$render) => {
			if ($error()) $$render(consequent);
		});
	}

	var button_1 = $.sibling(node, 2);
	var text_2 = $.only_child(button_1, true);

	$.reset(form);
	$.reset(div_2);
	$.next(2);
	$.reset(div_1);
	$.reset(div);

	$.template_effect(() => {
		$.set_attribute(input, 'type', $.get(showPassword) ? 'text' : 'password');
		$.set_text(text, $.get(showPassword) ? '🙈' : '👁️');
		button_1.disabled = $isLoading() || !$.get(password);
		$.set_text(text_2, $isLoading() ? 'Logging in...' : 'Login');
	});

	$.bind_value(input, () => $.get(password), ($$value) => $.set(password, $$value));
	$.event('click', button, () => $.set(showPassword, !$.get(showPassword)));
	$.event('submit', form, $.preventDefault(handleLogin));
	$.append($$anchor, div);
	$.pop();
	$$cleanup();
}