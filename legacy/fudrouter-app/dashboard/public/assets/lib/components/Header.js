import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { usageStats, activeView, refreshOAuth } from '../stores/app';

var root = $.from_html(`<div class="flex items-center gap-4 text-xs text-gray-400"><span>Requests: <span class="text-white font-mono"> </span></span> <span>Cost: <span class="text-mint font-mono"> </span></span> <span>Errors: <span class="text-red-400 font-mono"> </span></span></div>`);
var root_1 = $.from_html(`<header class="h-14 bg-card border-b border-border flex items-center justify-between px-6 shrink-0"><div class="flex items-center gap-4"><h2 class="text-lg font-semibold text-white capitalize"> </h2></div> <div class="flex items-center gap-3"><!> <button class="text-xs bg-surface hover:bg-border text-gray-300 px-3 py-1.5 rounded-lg transition-colors border border-border">🔄 Refresh OAuth</button></div></header>`);

export default function Header($$anchor, $$props) {
	$.push($$props, false);

	const $activeView = () => $.store_get(activeView, '$activeView', $$stores);
	const $usageStats = () => $.store_get(usageStats, '$usageStats', $$stores);
	const [$$stores, $$cleanup] = $.setup_stores();

	async function handleRefreshOAuth() {
		await refreshOAuth();
	}

	$.init();

	var header = root_1();
	var div = $.child(header);
	var h2 = $.child(div);
	var text = $.only_child(h2, true);

	$.reset(div);

	var div_1 = $.sibling(div, 2);
	var node = $.child(div_1);

	{
		var consequent = ($$anchor) => {
			var div_2 = root();
			var span = $.child(div_2);
			var span_1 = $.sibling($.child(span));
			var text_1 = $.only_child(span_1, true);

			$.reset(span);

			var span_2 = $.sibling(span, 2);
			var span_3 = $.sibling($.child(span_2));
			var text_2 = $.only_child(span_3);

			$.reset(span_2);

			var span_4 = $.sibling(span_2, 2);
			var span_5 = $.sibling($.child(span_4));
			var text_3 = $.only_child(span_5, true);

			$.reset(span_4);
			$.reset(div_2);

			$.template_effect(
				($0) => {
					$.set_text(text_1, $usageStats().totalRequests);
					$.set_text(text_2, `$${$0 ?? ''}`);
					$.set_text(text_3, $usageStats().errors);
				},
				[() => $usageStats().cost.toFixed(4)]
			);

			$.append($$anchor, div_2);
		};

		$.if(node, ($$render) => {
			if ($usageStats()) $$render(consequent);
		});
	}

	var button = $.sibling(node, 2);

	$.reset(div_1);
	$.reset(header);
	$.template_effect(() => $.set_text(text, $activeView()));
	$.event('click', button, handleRefreshOAuth);
	$.append($$anchor, header);
	$.pop();
	$$cleanup();
}