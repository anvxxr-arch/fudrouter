import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { onMount } from 'svelte';
import { usageStats, usageHistory, loadUsageStats } from '../stores/app';
import { api } from '../lib/api/client';

var root = $.from_html(`<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"><div class="bg-card border border-border rounded-xl p-4"><p class="text-xs text-gray-400 mb-1">Total Requests</p> <p class="text-2xl font-bold text-white"> </p></div> <div class="bg-card border border-border rounded-xl p-4"><p class="text-xs text-gray-400 mb-1">Success Rate</p> <p class="text-2xl font-bold text-mint"> </p></div> <div class="bg-card border border-border rounded-xl p-4"><p class="text-xs text-gray-400 mb-1">Total Cost</p> <p class="text-2xl font-bold text-glow"> </p></div> <div class="bg-card border border-border rounded-xl p-4"><p class="text-xs text-gray-400 mb-1">Errors</p> <p class="text-2xl font-bold text-red-400"> </p></div></div> <div class="grid grid-cols-1 md:grid-cols-2 gap-4"><div class="bg-card border border-border rounded-xl p-4"><p class="text-xs text-gray-400 mb-1">Prompt Tokens</p> <p class="text-xl font-bold text-white"> </p></div> <div class="bg-card border border-border rounded-xl p-4"><p class="text-xs text-gray-400 mb-1">Completion Tokens</p> <p class="text-xl font-bold text-white"> </p></div></div>`, 1);
var root_1 = $.from_html(`<tr class="border-b border-border/50 hover:bg-surface/50"><td class="px-4 py-2 text-gray-300 font-mono text-xs"> </td><td class="px-4 py-2 text-white"> </td><td class="px-4 py-2 text-gray-300"> </td><td class="px-4 py-2 text-gray-300"> </td><td class="px-4 py-2 text-mint"> </td><td class="px-4 py-2"><span> </span></td></tr>`);
var root_2 = $.from_html(`<div class="bg-card border border-border rounded-xl overflow-hidden"><div class="px-4 py-3 border-b border-border"><h4 class="text-sm font-semibold text-white">Recent Requests</h4></div> <div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left text-xs text-gray-400 border-b border-border"><th class="px-4 py-2">Time</th><th class="px-4 py-2">Provider</th><th class="px-4 py-2">Model</th><th class="px-4 py-2">Tokens</th><th class="px-4 py-2">Cost</th><th class="px-4 py-2">Status</th></tr></thead><tbody></tbody></table></div></div>`);
var root_3 = $.from_html(`<div class="space-y-6"><div><h3 class="text-xl font-semibold text-white">Dashboard</h3> <p class="text-sm text-gray-400 mt-1">Usage overview and statistics</p></div> <!> <!></div>`);

export default function UsageStats($$anchor, $$props) {
	$.push($$props, false);

	const $usageStats = () => $.store_get(usageStats, '$usageStats', $$stores);
	const $usageHistory = () => $.store_get(usageHistory, '$usageHistory', $$stores);
	const [$$stores, $$cleanup] = $.setup_stores();
	const stats = $.mutable_source();
	const history = $.mutable_source();

	onMount(() => {
		loadUsageStats();
		loadHistory();
	});

	async function loadHistory() {
		try {
			const res = await api.usageHistory(50);

			usageHistory.set(res.history);
		} catch(e) {
			// ignore
		}
	}

	$.legacy_pre_effect(() => ($usageStats()), () => {
		$.set(stats, $usageStats());
	});

	$.legacy_pre_effect(() => ($usageHistory()), () => {
		$.set(history, $usageHistory());
	});

	$.legacy_pre_effect_reset();
	$.init();

	var div = root_3();
	var node = $.sibling($.child(div), 2);

	{
		var consequent = ($$anchor) => {
			var fragment = root();
			var div_1 = $.first_child(fragment);
			var div_2 = $.child(div_1);
			var p = $.sibling($.child(div_2), 2);
			var text = $.only_child(p, true);

			$.reset(div_2);

			var div_3 = $.sibling(div_2, 2);
			var p_1 = $.sibling($.child(div_3), 2);
			var text_1 = $.only_child(p_1);

			$.reset(div_3);

			var div_4 = $.sibling(div_3, 2);
			var p_2 = $.sibling($.child(div_4), 2);
			var text_2 = $.only_child(p_2);

			$.reset(div_4);

			var div_5 = $.sibling(div_4, 2);
			var p_3 = $.sibling($.child(div_5), 2);
			var text_3 = $.only_child(p_3, true);

			$.reset(div_5);
			$.reset(div_1);

			var div_6 = $.sibling(div_1, 2);
			var div_7 = $.child(div_6);
			var p_4 = $.sibling($.child(div_7), 2);
			var text_4 = $.only_child(p_4, true);

			$.reset(div_7);

			var div_8 = $.sibling(div_7, 2);
			var p_5 = $.sibling($.child(div_8), 2);
			var text_5 = $.only_child(p_5, true);

			$.reset(div_8);
			$.reset(div_6);

			$.template_effect(
				($0, $1, $2, $3, $4, $5) => {
					$.set_text(text, $0);
					$.set_text(text_1, `${$1 ?? ''}%`);
					$.set_text(text_2, `$${$2 ?? ''}`);
					$.set_text(text_3, $3);
					$.set_text(text_4, $4);
					$.set_text(text_5, $5);
				},
				[
					() => (
						$.get(stats),
						$.untrack(() => $.get(stats).totalRequests.toLocaleString())
					),

					() => (
						$.get(stats),
						$.untrack(() => $.get(stats).totalRequests > 0
							? ($.get(stats).ok / $.get(stats).totalRequests * 100).toFixed(1)
							: 0)
					),
					() => ($.get(stats), $.untrack(() => $.get(stats).cost.toFixed(4))),
					() => (
						$.get(stats),
						$.untrack(() => $.get(stats).errors.toLocaleString())
					),

					() => (
						$.get(stats),
						$.untrack(() => $.get(stats).promptTokens.toLocaleString())
					),

					() => (
						$.get(stats),
						$.untrack(() => $.get(stats).completionTokens.toLocaleString())
					)
				]
			);

			$.append($$anchor, fragment);
		};

		$.if(node, ($$render) => {
			if ($.get(stats)) $$render(consequent);
		});
	}

	var node_1 = $.sibling(node, 2);

	{
		var consequent_1 = ($$anchor) => {
			var div_9 = root_2();
			var div_10 = $.sibling($.child(div_9), 2);
			var table = $.child(div_10);
			var tbody = $.sibling($.child(table));

			$.each(tbody, 5, () => ($.get(history), $.untrack(() => $.get(history).slice(0, 20))), $.index, ($$anchor, row) => {
				var tr = root_1();
				var td = $.child(tr);
				var text_6 = $.only_child(td, true);
				var td_1 = $.sibling(td);
				var text_7 = $.only_child(td_1, true);
				var td_2 = $.sibling(td_1);
				var text_8 = $.only_child(td_2, true);
				var td_3 = $.sibling(td_2);
				var text_9 = $.only_child(td_3, true);
				var td_4 = $.sibling(td_3);
				var text_10 = $.only_child(td_4);
				var td_5 = $.sibling(td_4);
				var span = $.child(td_5);
				var text_11 = $.only_child(span, true);

				$.reset(td_5);
				$.reset(tr);

				$.template_effect(
					($0, $1) => {
						$.set_text(text_6, $0);
						$.set_text(text_7, ($.get(row), $.untrack(() => $.get(row).provider)));
						$.set_text(text_8, ($.get(row), $.untrack(() => $.get(row).model)));

						$.set_text(text_9, (
							$.get(row),
							$.untrack(() => $.get(row).promptTokens + $.get(row).completionTokens)
						));

						$.set_text(text_10, `$${$1 ?? ''}`);

						$.set_class(span, 1, `text-xs px-2 py-0.5 rounded-full ${(
							$.get(row),
							$.untrack(() => $.get(row).status === 'ok'
								? 'bg-green-900/30 text-green-400'
								: 'bg-red-900/30 text-red-400')
						) ?? ''}`);

						$.set_text(text_11, ($.get(row), $.untrack(() => $.get(row).status)));
					},
					[
						() => (
							$.get(row),
							$.untrack(() => new Date($.get(row).timestamp).toLocaleTimeString())
						),
						() => ($.get(row), $.untrack(() => $.get(row).cost.toFixed(4)))
					]
				);

				$.append($$anchor, tr);
			});

			$.reset(tbody);
			$.reset(table);
			$.reset(div_10);
			$.reset(div_9);
			$.append($$anchor, div_9);
		};

		$.if(node_1, ($$render) => {
			if ((
				$.get(history),
				$.untrack(() => $.get(history) && $.get(history).length > 0)
			)) $$render(consequent_1);
		});
	}

	$.reset(div);
	$.append($$anchor, div);
	$.pop();
	$$cleanup();
}