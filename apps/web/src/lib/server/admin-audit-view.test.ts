import { describe, expect, it } from 'vitest';
import { auditRowForDisplay, auditRowsForDisplay, type AuditRowView } from './admin-audit-view';

const base: AuditRowView = {
	id: 'aud_1',
	actorUserId: 'usr_1',
	actorKind: 'user',
	action: 'credential.create',
	resource: 'credential',
	resourceId: 'cred_1',
	workspaceId: null,
	ip: '203.0.113.5',
	before: null,
	after: null,
	metadata: {},
	createdAt: new Date('2026-09-30T12:00:00Z')
};

describe('auditRowForDisplay', () => {
	it('drops a `secret` key from the after diff entirely', () => {
		const row = auditRowForDisplay({
			...base,
			after: { name: 'prod-key', secret: 'sk-live-abc123' }
		});
		expect(row.after).not.toHaveProperty('secret');
		expect(row.after).toHaveProperty('name', 'prod-key');
	});
	it('drops nested secret keys and keeps the rest of the diff', () => {
		const row = auditRowForDisplay({
			...base,
			before: { config: { api_key: 'k', region: 'eu' }, enabled: true },
			after: { config: { token: 't', region: 'us' }, enabled: false }
		});
		expect(row.before).not.toHaveProperty('config.api_key');
		expect(row.before).toHaveProperty('config.region', 'eu');
		expect(row.after).not.toHaveProperty('config.token');
		expect(row.after).toHaveProperty('enabled', false);
	});
	it('keeps reference keys like api_key_id — which key acted is audit content', () => {
		const row = auditRowForDisplay({
			...base,
			after: { api_key_id: 'key_123', authorization_url: 'https://example.com/auth', ok: 1 }
		});
		expect(row.after).toHaveProperty('api_key_id', 'key_123');
		expect(row.after).toHaveProperty('authorization_url', 'https://example.com/auth');
	});
	it('redacts then drops any secret that slipped past the write-time redaction', () => {
		const row = auditRowForDisplay({
			...base,
			after: { credentials: 'raw-blob', password_hash: 'h', ok: 1 }
		});
		expect(row.after).not.toHaveProperty('credentials');
		expect(row.after).not.toHaveProperty('password_hash');
		expect(row.after).toHaveProperty('ok', 1);
	});
	it('maps a page of rows through the same projection', () => {
		const rows = auditRowsForDisplay([
			{ ...base, after: { secret: 's', keep: true } },
			{ ...base, id: 'aud_2', before: { secret: 's2' }, after: null }
		]);
		expect(rows[0].after).not.toHaveProperty('secret');
		expect(rows[1].before).not.toHaveProperty('secret');
	});
});
