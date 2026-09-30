import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, idPrefix, newId } from './id';

describe('newId', () => {
	it('mints prefix_uuidv7', () => {
		const id = newId('req_');
		expect(id.startsWith('req_')).toBe(true);
		expect(id.slice(4)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});

	it('mints unique, time-ordered ids', () => {
		const ids = Array.from({ length: 50 }, () => newId('req_'));
		expect(new Set(ids).size).toBe(50);
		const sorted = [...ids].sort();
		expect(sorted).toEqual(ids); // uuidv7 is monotonic within a process
	});

	it('rejects prefixes that are not snake-case tokens', () => {
		for (const bad of ['', 'req', 'REQ_', 'req__', 'toolongprefix_', '1x_']) {
			expect(() => newId(bad)).toThrow(/invalid id prefix/);
		}
	});

	it('classifies backfilled legacy ids by first underscore', () => {
		// Spec §1: backfilled ids wrap the legacy value verbatim, and legacy
		// values may themselves contain underscores (usr_u_apkpg2yCQHFi).
		expect(idPrefix('usr_u_apkpg2yCQHFi')).toBe('usr_');
		expect(idPrefix('prv_mingles')).toBe('prv_');
		expect(idPrefix('mingles')).toBe(null);
	});
});

describe('ID_PREFIXES', () => {
	it('uses every prefix the spec lists', () => {
		const expected = [
			'usr_', 'wrk_', 'prj_', 'env_', 'key_', 'req_', 'rta_', 'prv_', 'con_',
			'cred_', 'mdl_', 'pmdl_', 'als_', 'rte_', 'prc_', 'inv_', 'txn_',
			'bac_', 'bdg_', 'lim_', 'alr_', 'ale_', 'whk_', 'whd_', 'job_',
			'evt_', 'aud_', 'inc_', 'icu_', 'flg_', 'rul_', 'cbr_', 'mem_', 'rol_',
			'ses_', 'acc_', 'ver_'
		];
		expect(new Set(Object.values(ID_PREFIXES))).toEqual(new Set(expected));
	});
});
