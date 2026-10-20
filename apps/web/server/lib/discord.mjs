// Discord guild membership for fudrouter (spec: after a user signs in they
// are put into the FUDCourt server, guild 1358116767217614898).
//
// The endpoint is `PUT /guilds/{guild}/members/{user}` — the only way to place
// someone in a server without them clicking an invite link, and it is
// IDEMPOTENT: 201 when the member is created, 204 when they are already in. That
// is why this is safe to call on every sign-in instead of tracking "have we
// added them yet" — the API already answers the question for us, and a member
// who was kicked and rejoins gets re-added on their next login rather than
// being silently skipped forever.
//
// It needs TWO things the caller must have arranged, and fails informatively
// when either is missing:
//   1. `FLEXYROUTE_BOT_TOKEN` — the bot must already be a member of the guild.
//   2. The user authorized the app with the `guilds.join` scope. Discord refuses
//      (403 "Missing Access") for a user who only granted `identify`, which is
//      why server/index.mjs asks for `identify email guilds.join` explicitly
//      rather than relying on better-auth's narrower default.
//
// A failure here is NEVER allowed to fail a login: the caller fires this and
// swallows the error. Being added to the Discord server is a convenience on
// top of an authentication that already succeeded — turning it into a 500 would
// mean a Discord-side hiccup locks every user out of their own account.

const API_BASE = 'https://discord.com/api/v10';

/** The FUDCourt server. One guild, so a constant rather than an env knob. */
export const FUDCOURT_GUILD_ID = '1358116767217614898';

/**
 * Put a Discord user into the FUDCourt guild.
 *
 * Returns the HTTP status Discord answered with (201/204 = in the guild), or
 * `null` when this deployment cannot attempt it at all — no bot token
 * configured. `null` is distinct from an error so a caller can tell "not
 * configured, skip quietly" from "configured and refused", which is the
 * actionable case worth logging.
 */
export async function joinFudcourt(discordUserId, token = process.env.FLEXYROUTE_BOT_TOKEN) {
	if (!token) return null;
	if (!/^\d{17,20}$/.test(String(discordUserId ?? ''))) return null;
	const res = await fetch(
		`${API_BASE}/guilds/${FUDCOURT_GUILD_ID}/members/${discordUserId}`,
		{
			method: 'PUT',
			headers: { authorization: `Bot ${token}`, 'content-type': 'application/json' },
			body: '{}',
			// 3e: a hung Discord response held the caller's request open with no
			// deadline, accumulating a fire-and-forget socket per call; the 5s
			// abort bounds that like every other outbound fetch in this codebase.
			signal: AbortSignal.timeout(5000)
		}
	);
	return res.status;
}
