import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { onMount } from 'svelte';
import { isAuthenticated, activeView, logout, loadAll } from '../stores/app';
import Sidebar from './Sidebar.js';
import Header from './Header.js';
import ProviderList from './ProviderList.js';
import ConnectionList from './ConnectionList.js';
import ModelBrowser from './ModelBrowser.js';
import UsageStats from './UsageStats.js';
import Settings from './Settings.js';
import LogsStream from './LogsStream.js';
import ApiKeys from './ApiKeys.js';
import Combos from './Combos.js';

var root = $.from_html(`<div class="min-h-screen bg-ink flex"><!> <div class="flex-1 flex flex-col min-w-0"><!> <main class="flex-1 p-6 overflow-auto"><!></main></div></div>`);

export default function Dashboard($$anchor, $$props) {
	$.push($$props, false);

	const $activeView = () => $.store_get(activeView, '$activeView', $$stores);
	const [$$stores, $$cleanup] = $.setup_stores();
	const ActiveComponent = $.mutable_source();

	onMount(() => {
		loadAll();
	});

	const views = {
		dashboard: UsageStats,
		connections: ConnectionList,
		providers: ProviderList,
		models: ModelBrowser,
		settings: Settings,
		logs: LogsStream,
		keys: ApiKeys,
		combos: Combos
	};

	$.legacy_pre_effect(() => ($activeView(), UsageStats), () => {
		$.set(ActiveComponent, views[$activeView()] || UsageStats);
	});

	$.legacy_pre_effect_reset();
	$.init();

	var div = root();
	var node = $.child(div);

	Sidebar(node, {});

	var div_1 = $.sibling(node, 2);
	var node_1 = $.child(div_1);

	Header(node_1, {});

	var main = $.sibling(node_1, 2);
	var node_2 = $.child(main);

	$.get(ActiveComponent)(node_2, {});
	$.reset(main);
	$.reset(div_1);
	$.reset(div);
	$.append($$anchor, div);
	$.pop();
	$$cleanup();
}