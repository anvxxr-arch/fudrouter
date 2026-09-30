import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

// Built at runtime: a literal entity like < in this file gets decoded back to
// '<' on the way to disk, which would make the assertions compare raw HTML.
const AMP = String.fromCharCode(38);
const LT = AMP + 'lt;';
const GT = AMP + 'gt;';

describe('the markdown subset', () => {
	it('escapes raw HTML before rendering', () => {
		const html = renderMarkdown('<script>alert(1)</' + 'script>');
		expect(html).not.toContain('<script>');
		expect(html).toContain(LT + 'script' + GT);
	});
	it('renders headings, lists, code and links', () => {
		const html = renderMarkdown(
			'## Title\n\n- item one\n- item two\n\n`code` and **bold**\n\n[link](https://example.com)\n\n```\nfenced\n```'
		);
		expect(html).toContain('<h2>Title</h2>');
		expect(html).toContain('<li>item one</li>');
		expect(html).toContain('<code>code</code>');
		expect(html).toContain('<strong>bold</strong>');
		expect(html).toContain('<a href="https://example.com">link</a>');
		expect(html).toContain('<pre><code>fenced</code></pre>');
	});
	it('refuses javascript: link targets — no anchor is rendered at all', () => {
		const html = renderMarkdown('[x](javascript:alert(1))');
		expect(html).not.toMatch(/<a\s/);
	});
});
