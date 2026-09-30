import { describe, expect, it } from 'vitest';
import { resolve } from '$app/paths';
describe('$app/paths in node tests', () => {
	it('resolves a param route', () => {
		const href = resolve('/(app)/dashboard/projects/[projectId]/keys/[keyId]', {
			projectId: 'prj_1',
			keyId: 'key_1'
		});
		expect(href).toContain('prj_1');
	});
});
