// Whether the console accepts email/password sign-in.
//
// fudrouter signs in with Discord and nothing else, so this is `false` in
// every environment a person actually uses — production AND development. The
// one exception is the integration harness, which starts the real server as a
// subprocess with `NODE_ENV=test` and creates fixtures through
// `/api/auth/sign-up/email`, because there is no Discord account a test can
// log in with (see apps/web/tests/integration/harness.mjs).
//
// Two deliberate choices in how that exception is written:
//
// 1. It is the LITERAL string 'test', not `!== 'production'`. The obvious
//    "off in prod, on in dev" reading would leave a password form live on every
//    developer machine, which is how a Discord-only product quietly stops being
//    Discord-only in practice.
//
// 2. It keys off NODE_ENV rather than a dedicated flag such as
//    `FUDROUTER_ALLOW_EMAIL_AUTH`. An env var can be set — or inherited — in
//    production by accident, which is exactly how `ROUTER_ALLOW_DEV_PROVIDERS`
//    opened the dev-provider gate in production (AGENTS.md, "Secrets &
//    environment"). `NODE_ENV` is already load-bearing in this file for the
//    same reason: `trustedOrigins` is `[]` when it is 'production'.
//
// The auth pages (routes/Auth.tsx) never show the email/password form regardless
// of this value — it exists to keep the existing integration fixtures working,
// not to offer another way in.
export function emailAuthEnabled(nodeEnv) {
	return nodeEnv === 'test';
}
