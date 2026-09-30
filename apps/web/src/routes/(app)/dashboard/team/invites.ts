import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNull, like, or } from 'drizzle-orm';
import type { DbTx } from '$lib/server/audit';
import { user, verification, workspaceRole } from '$lib/server/db/schema';
import { ID_PREFIXES, newId } from '$lib/server/id';

/**
 * Workspace invitations (PRD §12/§45).
 *
 * PINNED token design — the token IS the credential and only its hash is
 * stored: the `verification` row Better Auth already owns carries
 *   identifier = 'invite:' + sha256Hex(token)
 *   value      = JSON payload { email, workspaceId, roleId, invitedBy, name }
 *   expiresAt  = now + 7 days
 * Lookup is an exact identifier match, so a leaked row cannot be replayed as a
 * token and there is no scan-the-table timing oracle to exploit.
 *
 * Everything in here is a pure helper plus typed access to those rows — the
 * route handlers own their gates, mutations and audits.
 */
export const INVITE_PREFIX = 'invite:';
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InvitePayload {
	email: string;
	workspaceId: string;
	roleId: string;
	invitedBy: string;
	name: string;
}

export function newInviteToken(): string {
	return randomBytes(32).toString('base64url');
}

/**
 * The pinned identifier scheme: 'invite:' + sha256Hex(token). Exported as one
 * name because every read path resolves tokens through exactly this formula.
 */
export function inviteIdentifier(token: string): string {
	return INVITE_PREFIX + createHash('sha256').update(token).digest('hex');
}

export function parseInvite(value: string): InvitePayload | null {
	try {
		const parsed = JSON.parse(value) as Partial<InvitePayload>;
		if (!parsed || typeof parsed !== 'object') return null;
		const { email, workspaceId, roleId, invitedBy, name } = parsed;
		if (
			typeof email !== 'string' ||
			typeof workspaceId !== 'string' ||
			typeof roleId !== 'string' ||
			typeof invitedBy !== 'string' ||
			typeof name !== 'string'
		) {
			return null;
		}
		return { email, workspaceId, roleId, invitedBy, name };
	} catch {
		return null;
	}
}

export interface InviteRow {
	id: string;
	expiresAt: Date;
	payload: InvitePayload;
}

/** The live (unexpired) invite a raw token points at, or null. */
export async function findInviteByToken(
	dbtx: DbTx,
	token: string,
	now = new Date()
): Promise<InviteRow | null> {
	return findInviteByIdentifier(dbtx, inviteIdentifier(token), now);
}

export async function findInviteByIdentifier(
	dbtx: DbTx,
	identifier: string,
	now = new Date()
): Promise<InviteRow | null> {
	const [row] = await dbtx
		.select({ id: verification.id, value: verification.value, expiresAt: verification.expiresAt })
		.from(verification)
		.where(and(eq(verification.identifier, identifier), gt(verification.expiresAt, now)))
		.limit(1);
	if (!row) return null;
	const payload = parseInvite(row.value);
	if (!payload) return null;
	return { id: row.id, expiresAt: row.expiresAt, payload };
}

/**
 * The pending invite for an email in a workspace: its identifier stores only
 * the token hash, so "find the invite for this email" reads the parsed JSON
 * payload and takes the live (unexpired) row.
 */
export async function findPendingInvite(
	dbtx: DbTx,
	email: string,
	workspaceId: string,
	now = new Date()
): Promise<InviteRow | null> {
	const rows = await dbtx
		.select({
			id: verification.id,
			value: verification.value,
			expiresAt: verification.expiresAt,
			identifier: verification.identifier
		})
		.from(verification)
		.where(and(like(verification.identifier, `${INVITE_PREFIX}%`), gt(verification.expiresAt, now)));
	for (const row of rows) {
		const payload = parseInvite(row.value);
		if (payload && payload.email === email && payload.workspaceId === workspaceId) {
			return { id: row.id, expiresAt: row.expiresAt, payload };
		}
	}
	return null;
}

/** Insert a fresh invite row; returns the raw token exactly once. */
export async function insertInvite(
	dbtx: DbTx,
	payload: InvitePayload,
	now = new Date()
): Promise<{ id: string; token: string }> {
	const token = newInviteToken();
	const id = newId(ID_PREFIXES.verification);
	await dbtx.insert(verification).values({
		id,
		identifier: inviteIdentifier(token),
		value: JSON.stringify(payload),
		expiresAt: new Date(now.getTime() + INVITE_TTL_MS)
	});
	return { id, token };
}

/** Delete one invite row by id (revoke, resend invalidation, accept/decline). */
export async function deleteInvite(dbtx: DbTx, id: string): Promise<void> {
	await dbtx.delete(verification).where(eq(verification.id, id));
}

/**
 * Drop every live invite for one (email, workspace) pair. The lookup helpers
 * assume ONE live invite per pair (resend finds "the" row), and an existing
 * account is added directly — so a stale token left over from before their
 * signup must never survive as a second, forgotten credential.
 */
export async function deletePendingInvites(
	dbtx: DbTx,
	email: string,
	workspaceId: string,
	now = new Date()
): Promise<number> {
	const rows = await dbtx
		.select({ id: verification.id, value: verification.value })
		.from(verification)
		.where(and(like(verification.identifier, `${INVITE_PREFIX}%`), gt(verification.expiresAt, now)));
	const ids = rows
		.filter((row) => {
			const payload = parseInvite(row.value);
			return payload && payload.email === email && payload.workspaceId === workspaceId;
		})
		.map((row) => row.id);
	if (ids.length) await dbtx.delete(verification).where(inArray(verification.id, ids));
	return ids.length;
}

/**
 * The pending invites of one workspace, resolved against the users that
 * already exist (inviter name, and the invitee — an existing user is added to
 * the workspace directly instead of keeping an invite row).
 */
export async function listWorkspaceInvites(
	dbtx: DbTx,
	workspaceId: string,
	now = new Date()
): Promise<
	{
		id: string;
		identifier: string;
		email: string;
		name: string;
		roleId: string;
		expiresAt: Date;
		invitedBy: string;
	}[]
> {
	const rows = await dbtx
		.select({
			id: verification.id,
			value: verification.value,
			expiresAt: verification.expiresAt,
			identifier: verification.identifier
		})
		.from(verification)
		.where(and(like(verification.identifier, `${INVITE_PREFIX}%`), gt(verification.expiresAt, now)));
	const out = rows
		.map((row) => {
			const payload = parseInvite(row.value);
			return payload && payload.workspaceId === workspaceId
				? { id: row.id, identifier: row.identifier, expiresAt: row.expiresAt, ...payload }
				: null;
		})
		.filter((r): r is NonNullable<typeof r> => r !== null);
	const userIds = [...new Set(out.flatMap((r) => [r.invitedBy]))];
	const names = userIds.length
		? await dbtx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds))
		: [];
	const nameById = new Map(names.map((n) => [n.id, n.name]));
	return out
		.map((r) => ({
			id: r.id,
			identifier: r.identifier,
			email: r.email,
			name: r.name,
			roleId: r.roleId,
			expiresAt: r.expiresAt,
			invitedBy: nameById.get(r.invitedBy) ?? r.invitedBy
		}))
		.sort((a, b) => b.expiresAt.getTime() - a.expiresAt.getTime());
}

/**
 * Roles selectable for membership: builtin templates (`workspace_id NULL`)
 * plus the workspace's own custom roles — spec §2's role model.
 */
export async function listAssignableRoles(dbtx: DbTx, workspaceId: string) {
	const rows = await dbtx
		.select({
			id: workspaceRole.id,
			name: workspaceRole.name,
			workspaceId: workspaceRole.workspaceId
		})
		.from(workspaceRole)
		.where(or(isNull(workspaceRole.workspaceId), eq(workspaceRole.workspaceId, workspaceId)))
		.orderBy(workspaceRole.name);
	return rows;
}
