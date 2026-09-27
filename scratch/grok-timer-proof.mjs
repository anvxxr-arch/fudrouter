// Proof that the SCHEDULED loop rotates accounts with nobody at the keyboard.
//
//   plant  → three accounts are set to expire in 2 minutes and their refresh
//            tokens are stashed. The timer's next run has real work.
//   check  → after the run: did those three rotate? (the refresh token changed,
//            which only a refresh can do) and what did the service log?
//
// Exits non-zero unless all three rotated, so the wait-and-check can be a single
// command whose exit code is the answer.
import postgres from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const STASH = '/tmp/grok-timer-proof.json';
const IDX = [5, 6, 7];
const MASTER = process.env.CREDENTIALS_MASTER_KEY;
const k = () => {
	const b = Buffer.from(MASTER, 'base64');
	if (b.length !== 32) throw new Error('key must be base64 of 32 bytes');
	return b;
};
const decrypt = (wire) => {
	const raw = Buffer.from(wire, 'base64');
	const d = createDecipheriv('aes-256-gcm', k(), raw.subarray(0, 12));
	d.setAuthTag(raw.subarray(raw.length - 16));
	return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
};
const encrypt = (plain) => {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', k(), iv);
	const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
	return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
};

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const [row] = await sql`select id, credentials_enc from provider where name = 'xai-grok'`;
const cred = JSON.parse(decrypt(row.credentials_enc));
const mode = process.argv[2];

if (mode === 'plant') {
	const stash = IDX.map((i) => ({ idx: i, email: cred.accounts[i].email, rt: cred.accounts[i].refresh_token }));
	writeFileSync(STASH, JSON.stringify(stash), { mode: 0o600 });
	const soon = new Date(Date.now() + 2 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
	for (const i of IDX) cred.accounts[i].expired = soon;
	await sql`update provider set credentials_enc = ${encrypt(JSON.stringify(cred))} where id = ${row.id}`;
	console.log(`planted ${IDX.length} accounts, expiry ${soon}: ${stash.map((s) => s.email).join(', ')}`);
} else if (mode === 'check') {
	const stash = JSON.parse(readFileSync(STASH, 'utf8'));
	let allRotated = true;
	for (const s of stash) {
		const now = cred.accounts.find((a) => a.email === s.email);
		const rotated = now && now.refresh_token !== s.rt;
		if (!rotated) allRotated = false;
		console.log(`${rotated ? 'ROTATED' : 'UNCHANGED'}  ${s.email} | expired ${now?.expired} | last_refresh ${now?.last_refresh || '(none)'}`);
	}
	let journal = '';
	try {
		journal = execFileSync('journalctl', ['--user', '-u', 'grok-pool-refresh.service', '-n', '4', '--no-pager'], { encoding: 'utf8' });
	} catch (e) {
		journal = `journalctl failed: ${e.message}`;
	}
	const line = journal.split('\n').filter((l) => l.includes('provider')).pop() || '(no run logged)';
	console.log('service log:', line.trim());
	console.log(allRotated ? 'PASS: the scheduled run rotated all three accounts' : 'FAIL: the scheduled run did not touch them');
	process.exit(allRotated ? 0 : 1);
} else {
	console.error('usage: grok-timer-proof.mjs plant|check');
	process.exit(2);
}
await sql.end();
