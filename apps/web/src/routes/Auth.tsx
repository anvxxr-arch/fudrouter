import { useState } from 'react';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';

// Discord is the ONLY sign-in method for fudrouter — there is no email or
// password path and no separate signup page. `emailAndPassword: { enabled: false }`
// in server/index.mjs is what disables the password path server-side; this page
// simply stops offering it, so a disabled endpoint is never reachable from a form
// that still posts to it. Signup is the same call: better-auth creates the user
// on first OAuth round trip, so a second page with a second button would have
// been two doors into one flow (and /signup 301s here for old links).
//
// `/api/auth/sign-in/social` is POST-only in better-auth. Navigating the browser
// to it with GET (the previous `window.location.href = '...social?provider=discord'`)
// answered 404 for every visitor: the button rendered fine and did nothing.
// It has to be a POST for a second reason — the response body carries the
// provider `url` while the `state` cookie that pairs with it is set on that same
// response, so reading the url and then following it keeps both halves of the
// handshake on one round trip.
const SIGN_IN_ENDPOINT = '/api/auth/sign-in/social';

async function startDiscordSignIn(): Promise<string> {
  const res = await fetch(SIGN_IN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // callbackURL is where better-auth lands the session after the provider
    // round trip; '/' is the console, which re-checks the session itself.
    body: JSON.stringify({ provider: 'discord', callbackURL: '/' }),
  });
  const data = (await res.json().catch(() => null)) as { url?: string; message?: string } | null;
  if (!res.ok || !data?.url) {
    throw new Error(data?.message || `Sign-in failed (HTTP ${res.status})`);
  }
  return data.url;
}

function DiscordButton({ label }: { label: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <>
      {error && <p role="alert"><strong>{error}</strong></p>}
      <Button
        variant="secondary"
        disabled={pending}
        onClick={async () => {
          setError(null);
          setPending(true);
          try {
            window.location.href = await startDiscordSignIn();
          } catch (err) {
            setPending(false);
            setError(err instanceof Error ? err.message : 'Sign-in failed');
          }
        }}
      >
        {pending ? 'Redirecting…' : label}
      </Button>
    </>
  );
}

export function LoginPage() {
  return (
    <div className="stack" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h1>Log in</h1>
      <Card>
        <DiscordButton label="Continue with Discord" />
        {/* One line, because the button already says what it does. The previous
            version ran three sentences explaining provisioning, roles and
            signup — every one of them restated the button. */}
        <p className="muted">No account needed — Discord makes one.</p>
      </Card>
    </div>
  );
}
