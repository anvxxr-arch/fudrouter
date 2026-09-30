import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { createRawSnippet } from 'svelte';
import Badge from '$lib/ui/Badge.svelte';
describe('ssr render in node', () => {
	it('renders a component to html', () => {
		const html = render(Badge, {
			props: {
				tone: 'success',
				children: createRawSnippet(() => ({ render: () => '<span>hello-badge</span>' }))
			} as never
		}).html;
		expect(html).toContain('hello-badge');
	});
});
