// Concurrency probe for refresh-grok-pool.mjs: does its write MERGE with a
// rotation that landed while it was working, or overwrite the blob with the
// snapshot it read at startup?
//
//   setup    → 30 accounts get a +1min expiry, so the next run has a real
//              workload (the write window must be wide enough to race).
//   mutate   → runs mid-refresh: adds a brand-new account and plants a marker
//              token on an account OUTSIDE the refresh set. An overwriting
//              writer loses both.
//   verify   → the marker account still exists, the marker token survived.
//   cleanup  → removes the marker account, restores the planted account.
import postgres from 'postgres';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const STASH = '/tmp/grok-merge-probe.json';
const MARKER_EMAIL = 'false-positive@probe.dev';
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
const save = () =>
	sql`update provider set credentials_enc = ${encrypt(JSON.stringify(cred))} where id = ${row.id}`;
const mode = process.argv[2];
const future = (ms) => new Date(Date.now() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

if (mode === 'setup') {
	const plant = cred.accounts[500];
	writeFileSync(STASH, JSON.stringify(plant), { mode: 0o600 });
	const n = Number(process.argv[3] || 30);
	for (let i = 0; i < n; i++) cred.accounts[i].expired = future(60_000);
	await save();
	console.log(`${n} accounts set to expire in 1min; planted account = ${plant.email}`);
} else if (mode === 'mutate') {
	cred.accounts[500].access_token = 'MARKER-LAST';
	cred.accounts[500].expired = future(10 * 365 * 24 * 3600_000);
	cred.accounts.push({
		email: MARKER_EMAIL,
		access_token: 'MARKER-NEW',
		refresh_token: 'rt-marker',
		expired: future(10 * 365 * 24 * 3600_000)
	});
	await save();
	console.log(`planted: ${cred.accounts[500].email}=MARKER-LAST + new account ${MARKER_EMAIL}`);
} else if (mode === 'verify') {
	const emails = cred.accounts.map((a) => a.email);
	const planted = cred.accounts.find((a) => a.email === JSON.parse(readFileSync(STASH, 'utf8')).email);
	const okNew = emails.includes(MARKER_EMAIL);
	const okMarker = planted && planted.access_token === 'MARKER-LAST';
	console.log(`pool=${cred.accounts.length}`);
	console.log(`new account kept:      ${okNew ? 'YES' : 'NO  <- an overwriting writer dropped it'}`);
	console.log(`planted token survived: ${okMarker ? 'YES' : 'NO  <- the rotation was clobbered'}`);
	process.exit(okNew && okMarker ? 0 : 1);
} else if (mode === 'cleanup') {
	const plant = JSON.parse(readFileSync(STASH, 'utf8'));
	cred.accounts = cred.accounts.filter((a) => a.email !== MARKER_EMAIL);
	const i = cred.accounts.findIndex((a) => a.email === plant.email);
	cred.accounts[i] = plant;
	await save();
	console.log(`removed ${MARKER_EMAIL}; restored ${plant.email}`);
} else {
	console.error('usage: probe.mjs setup|mutate|verify|cleanup');
	process.exit(2);
}
await sql.end();
