import { describe, expect, it } from 'vitest';
import {
	API_KEY_PLACEHOLDER,
	CLI_TOOLS,
	cliToolById,
	renderCliTools,
	withV1,
	type CliTarget
} from './cli-tools';

const target: CliTarget = {
	baseUrl: 'https://ai.example.test',
	model: 'deepseek-v4.1-flash',
	apiKey: 'sk-ar-abcd1234'
};

const all = () => renderCliTools(target);

describe('withV1', () => {
	it('appends /v1 exactly once', () => {
		expect(withV1('https://ai.example.test')).toBe('https://ai.example.test/v1');
		expect(withV1('https://ai.example.test/')).toBe('https://ai.example.test/v1');
		expect(withV1('https://ai.example.test/v1')).toBe('https://ai.example.test/v1');
		expect(withV1('https://ai.example.test/v1/')).toBe('https://ai.example.test/v1');
	});
});

describe('the CLI tool registry', () => {
	it('has unique ids and names', () => {
		const ids = CLI_TOOLS.map((t) => t.id);
		expect(new Set(ids).size).toBe(ids.length);
		const names = CLI_TOOLS.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it('covers both wire protocols the router serves', () => {
		const protocols = new Set(CLI_TOOLS.map((t) => t.protocol));
		expect(protocols).toEqual(new Set(['openai', 'anthropic']));
	});

	it.each(CLI_TOOLS.map((t) => [t.id, t] as const))(
		'%s renders a snippet with the base URL, model and key',
		(id, tool) => {
			expect(tool.summary.length).toBeGreaterThan(0);
			expect(tool.install.length).toBeGreaterThan(0);
			expect(tool.steps.length).toBeGreaterThan(0);
			const snippets = tool.snippets(target);
			expect(snippets.length).toBeGreaterThan(0);
			for (const s of snippets) {
				expect(s.label.length).toBeGreaterThan(0);
				expect(s.code.length).toBeGreaterThan(0);
			}
			// The tool must actually receive the values it was handed — a snippet
			// that silently drops the model or the key is worse than none.
			const joined = snippets.map((s) => s.code).join('\n');
			expect(joined, `${id} snippet omits the model`).toContain(target.model);
			expect(joined, `${id} snippet omits the key`).toContain(target.apiKey);
		}
	);

	it('points an [OI] tool at the /v1 base and an Anthropic tool at the bare origin', () => {
		for (const { tool, snippets } of all()) {
			const joined = snippets.map((s) => s.code).join('\n');
			if (tool.protocol === 'openai') {
				// A tool that speaks chat completions must be given the /v1 base.
				expect(joined, `${tool.id} should use the /v1 base`).toContain(
					'https://ai.example.test/v1'
				);
			} else {
				// An Anthropic client appends /v1/messages itself, so the BASE it
				// is handed must be the bare origin — handing it the /v1 base
				// yields /v1/v1/messages. (A curl example inside the snippet may
				// legitimately spell out /v1/messages, so assert on the variable
				// the client actually reads.)
				expect(joined, `${tool.id} must hand the client a bare-origin base`).toContain(
					'ANTHROPIC_BASE_URL="https://ai.example.test"'
				);
			}
		}
	});

	it('never invents a real secret — an absent key renders the placeholder', () => {
		const rendered = renderCliTools({ ...target, apiKey: '' });
		for (const { snippets } of rendered) {
			const joined = snippets.map((s) => s.code).join('\n');
			expect(joined).toContain(API_KEY_PLACEHOLDER);
		}
	});

	it('resolves a tool by id and returns undefined for an unknown one', () => {
		expect(cliToolById('opencode')?.name).toBe('opencode');
		expect(cliToolById('nope')).toBeUndefined();
	});

	it('renders valid JSON for the JSON snippet', () => {
		const jsonSnippets = all()
			.flatMap((r) => r.snippets)
			.filter((s) => s.language === 'json');
		expect(jsonSnippets.length).toBeGreaterThan(0);
		for (const s of jsonSnippets) {
			expect(() => JSON.parse(s.code)).not.toThrow();
		}
	});

	it('tolerates a trailing slash on the base URL', () => {
		const withSlash = renderCliTools({ ...target, baseUrl: 'https://ai.example.test/' });
		const joined = withSlash.flatMap((r) => r.snippets).map((s) => s.code).join('\n');
		expect(joined).not.toContain('https://ai.example.test//v1');
		expect(joined).not.toContain('ai.example.test//');
	});
});
