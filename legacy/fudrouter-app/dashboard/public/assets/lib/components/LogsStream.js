import 'svelte/internal/disclose-version';
import 'svelte/internal/flags/legacy';
import * as $ from 'svelte/internal/client';
import { onMount, onDestroy } from 'svelte';
import { api } from '../lib/api/client';

var root = $.from_html(`<div class="bg-yellow-900/30 border border-yellow-800 text-yellow-300 px-4 py-3 rounded-lg text-sm"> </div>`);
var root_1 = $.from_html(`<div class="px-4 py-2 border-b border-border/50 font-mono text-xs hover:bg-surface/50"><span class="text-gray-500"> </span> <span> </span> <span class="ml-2 text-gray-300"> </span></div>`);
var root_2 = $.from_html(`<div class="px-4 py-8 text-center text-gray-500 text-sm">No logs yet</div>`);
var root_3 = $.from_html(`<div class="space-y-6"><div class="flex items-center justify-between"><div><h3 class="text-xl font-semibold text-white">Logs</h3> <p class="text-sm text-gray-400 mt-1">Real-time request logs</p></div> <div class="flex items-center gap-2"><span></span> <span class="text-xs text-gray-400"> </span></div></div> <!> <div class="bg-card border border-border rounded-xl overflow-hidden"><div class="px-4 py-2 border-b border-border flex items-center justify-between"><span class="text-xs text-gray-400"> </span> <button class="text-xs text-gray-400 hover:text-white transition-colors">Clear</button></div> <div class="max-h-[600px] overflow-auto"><!> <!></div></div></div>`);

export default function LogsStream($$anchor, $$props) {
	$.push($$props, false);

	let logs = $.mutable_source([]);
	let connected = $.mutable_source(false);
	let error = $.mutable_source('');
	let eventSource = null;

	onMount(() => {
		connect();
	});

	onDestroy(() => {
		if (eventSource) {
			eventSource.close();
		}
	});

	function connect() {
		eventSource = new EventSource(`${api.baseUrl}/api/logs/stream`);

		eventSource.onopen = () => {
			$.set(connected, true);
			$.set(error, '');
		};

		eventSource.onmessage = (event) => {
			try {
				const entry = JSON.parse(event.data);

				$.set(logs, [entry, ...$.get(logs)].slice(0, 100));
			} catch(e) {
				// ignore parse errors
			}
		};

		eventSource.onerror = () => {
			$.set(connected, false);
			$.set(error, 'Connection lost. Retrying...');
			eventSource?.close();
			setTimeout(connect, 3000);
		};
	}

	$.init();

	var div = root_3();
	var div_1 = $.child(div);
	var div_2 = $.sibling($.child(div_1), 2);
	var span = $.child(div_2);
	var span_1 = $.sibling(span, 2);
	var text = $.only_child(span_1, true);

	$.reset(div_2);
	$.reset(div_1);

	var node = $.sibling(div_1, 2);

	{
		var consequent = ($$anchor) => {
			var div_3 = root();
			var text_1 = $.only_child(div_3, true);

			$.template_effect(() => $.set_text(text_1, $.get(error)));
			$.append($$anchor, div_3);
		};

		$.if(node, ($$render) => {
			if ($.get(error)) $$render(consequent);
		});
	}

	var div_4 = $.sibling(node, 2);
	var div_5 = $.child(div_4);
	var span_2 = $.child(div_5);
	var text_2 = $.only_child(span_2);
	var button = $.sibling(span_2, 2);

	$.reset(div_5);

	var div_6 = $.sibling(div_5, 2);
	var node_1 = $.child(div_6);

	$.each(node_1, 1, () => $.get(logs), $.index, ($$anchor, log) => {
		var div_7 = root_1();
		var span_3 = $.child(div_7);
		var text_3 = $.only_child(span_3, true);
		var span_4 = $.sibling(span_3, 2);
		var text_4 = $.only_child(span_4);
		var span_5 = $.sibling(span_4, 2);
		var text_5 = $.only_child(span_5, true);

		$.reset(div_7);

		$.template_effect(
			($0, $1) => {
				$.set_text(text_3, $0);

				$.set_class(span_4, 1, `ml-2 ${$.get(log).level === 'error'
					? 'text-red-400'
					: $.get(log).level === 'warn' ? 'text-yellow-400' : 'text-green-400'}`);

				$.set_text(text_4, `[${$1 ?? ''}]`);
				$.set_text(text_5, $.get(log).message);
			},
			[
				() => new Date($.get(log).timestamp).toLocaleTimeString(),
				() => $.get(log).level.toUpperCase()
			]
		);

		$.append($$anchor, div_7);
	});

	var node_2 = $.sibling(node_1, 2);

	{
		var consequent_1 = ($$anchor) => {
			var div_8 = root_2();

			$.append($$anchor, div_8);
		};

		$.if(node_2, ($$render) => {
			if ($.get(logs).length === 0) $$render(consequent_1);
		});
	}

	$.reset(div_6);
	$.reset(div_4);
	$.reset(div);

	$.template_effect(() => {
		$.set_class(span, 1, `w-2 h-2 rounded-full ${$.get(connected) ? 'bg-green-400' : 'bg-red-400'}`);
		$.set_text(text, $.get(connected) ? 'Connected' : 'Disconnected');
		$.set_text(text_2, `${$.get(logs).length ?? ''} entries`);
	});

	$.event('click', button, () => $.set(logs, []));
	$.append($$anchor, div);
	$.pop();
}