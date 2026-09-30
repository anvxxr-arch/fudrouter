/**
 * A tiny, safe markdown renderer for the changelog and docs content.
 *
 * There is no markdown dependency in apps/web and adding one is not worth it for
 * the subset these pages use: headings, paragraphs, lists, links, inline code and
 * fenced code blocks. Everything is HTML-ESCAPED first and only the recognised
 * syntax is re-introduced as tags, so a content file can never inject markup.
 *
 * Deliberately not a general renderer: if a file needs something outside the
 * subset, extend this module (and its test) — do not reach for `{@html}` on raw
 * file contents.
 */

// Entities are assembled at runtime (amp = String.fromCharCode(38) + 'amp;')
// rather than written literally: a literal '&' + 'amp;' in tool content gets
// decoded back to a bare '&' on the way to disk, which silently turned the
// earlier version of this map into an identity function.
const AMP = String.fromCharCode(38);
const ENTITIES: Record<string, string> = {
	'&': AMP + 'amp;',
	'<': AMP + 'lt;',
	'>': AMP + 'gt;',
	'"': AMP + 'quot;'
};

function escapeHtml(src: string): string {
	return src.replace(/[&<>"]/g, (c) => ENTITIES[c] ?? c);
}

/** Inline spans: `code`, **bold**, [text](https://…). Input is pre-escaped. */
function inline(pre: string): string {
	let out = pre;
	out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
	out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	// Links: only http(s) and site-relative targets, so `javascript:` cannot slip
	// through even if a content file tried.
	out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, text: string, href: string) => {
		if (!/^(https?:\/\/|\/)/.test(href)) return whole;
		return `<a href="${href}">${text}</a>`;
	});
	return out;
}

export function renderMarkdown(src: string): string {
	const lines = escapeHtml(src).split('\n');
	const out: string[] = [];
	let para: string[] = [];
	let list: string[] = [];
	let code: string[] | null = null;

	const flushPara = () => {
		if (para.length) {
			out.push(`<p>${inline(para.join(' '))}</p>`);
			para = [];
		}
	};
	const flushList = () => {
		if (list.length) {
			out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
			list = [];
		}
	};

	for (const line of lines) {
		if (code !== null) {
			if (line.startsWith('```')) {
				out.push(`<pre><code>${code.join('\n')}</code></pre>`);
				code = null;
			} else {
				code.push(line);
			}
			continue;
		}
		if (line.startsWith('```')) {
			flushPara();
			flushList();
			code = [];
			continue;
		}
		const heading = /^(#{2,3})\s+(.*)$/.exec(line);
		if (heading) {
			flushPara();
			flushList();
			const level = heading[1].length; // 2 or 3
			out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			continue;
		}
		const item = /^[-*]\s+(.*)$/.exec(line);
		if (item) {
			flushPara();
			list.push(item[1]);
			continue;
		}
		if (line.trim() === '') {
			flushPara();
			flushList();
			continue;
		}
		para.push(line.trim());
	}
	// Unterminated constructs degrade to what was collected, never drop content.
	if (code !== null) out.push(`<pre><code>${code.join('\n')}</code></pre>`);
	flushPara();
	flushList();
	return out.join('\n');
}
