import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { activeView, logout, isAuthenticated } from '../stores/app';

var root = $.from_html(`<button><span class="text-base"> </span> <span> </span></button>`);
var root_1 = $.from_html(`<aside class="w-64 bg-card border-r border-border flex flex-col shrink-0"><div class="p-4 border-b border-border"><h1 class="text-xl font-bold text-glow">Fudrouter</h1> <p class="text-xs text-gray-500 mt-0.5">One API for every provider</p></div> <nav class="flex-1 p-2 space-y-1 overflow-auto"></nav> <div class="p-3 border-t border-border"><button class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-400 hover:bg-red-900/20 hover:text-red-300 transition-colors"><span>🚪</span> <span>Logout</span></button></div></aside>`);

export default function Sidebar($$anchor, $$props) {
	$.push($$props, false);

	const $activeView = () => $.store_get(activeView, '$activeView', $$stores);
	const [$$stores, $$cleanup] = $.setup_stores();

	const navItems = [
		{ id: 'dashboard', label: 'Dashboard', icon: '📊' },
		{ id: 'connections', label: 'Connections', icon: '🔗' },
		{ id: 'providers', label: 'Providers', icon: '🏢' },
		{ id: 'models', label: 'Models', icon: '🤖' },
		{ id: 'keys', label: 'API Keys', icon: '🔑' },
		{ id: 'combos', label: 'Combos', icon: '🎯' },
		{ id: 'logs', label: 'Logs', icon: '📋' },
		{ id: 'settings', label: 'Settings', icon: '⚙️' }
	];

	$.init();

	var aside = root_1();
	var nav = $.sibling($.child(aside), 2);

	$.each(nav, 5, () => navItems, $.index, ($$anchor, item) => {
		var button = root();
		var span = $.child(button);
		var text = $.only_child(span, true);
		var span_1 = $.sibling(span, 2);
		var text_1 = $.only_child(span_1, true);

		$.reset(button);

		$.template_effect(() => {
			$.set_class(button, 1, `w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors text-left
          ${$activeView() === $.get(item).id
				? 'bg-accent/20 text-glow border border-accent/30'
				: 'text-gray-400 hover:bg-surface hover:text-white border border-transparent'}`);

			$.set_text(text, $.get(item).icon);
			$.set_text(text_1, $.get(item).label);
		});

		$.event('click', button, () => activeView.set($.get(item).id));
		$.append($$anchor, button);
	});

	$.reset(nav);

	var div = $.sibling(nav, 2);
	var button_1 = $.only_child(div);

	$.reset(aside);

	$.event('click', button_1, function (...$$args) {
		logout?.apply(this, $$args);
	});

	$.append($$anchor, aside);
	$.pop();
	$$cleanup();
}