import { Link } from 'react-router-dom';
import { FluidOrb } from '../components/FluidOrb';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';

// Discord is the ONLY sign-in method for fudrouter — there is no email or
// password path any more. `emailAndPassword: { enabled: false }` in
// server/index.mjs is what disables it server-side; this page simply stops
// offering it, so a disabled endpoint is never reachable from a form that
// still posts to it. Both pages go straight to the OAuth redirect.
const DISCORD_SIGN_IN = '/api/auth/sign-in/social?provider=discord';

export function LoginPage() {
  return (
    <div className="stack" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h1>Log in</h1>
      <div aria-hidden="true"><FluidOrb size={200} color="#3B82F4" /></div>
      <Card>
        <Button variant="secondary" onClick={() => { window.location.href = DISCORD_SIGN_IN; }}>
          Continue with Discord
        </Button>
        <p className="muted">fudrouter signs you in with Discord. Your server role and access are
        provisioned from that account.</p>
      </Card>
      <p className="muted">Need an account? <Link to="/signup">Sign up</Link></p>
    </div>
  );
}

export function SignupPage() {
  return (
    <div className="stack" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h1>Create your account</h1>
      <div aria-hidden="true"><FluidOrb size={200} color="#3B82F4" /></div>
      <Card>
        <Button variant="secondary" onClick={() => { window.location.href = DISCORD_SIGN_IN; }}>
          Sign up with Discord
        </Button>
        <p className="muted">Signing up is the same Discord flow: we create your account and
        workspace from the Discord profile you approve.</p>
      </Card>
      <p className="muted">Already have an account? <Link to="/login">Log in</Link></p>
    </div>
  );
}
