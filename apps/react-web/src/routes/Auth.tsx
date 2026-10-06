import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FluidOrb } from '../components/FluidOrb';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Input } from '../components/ui/input';

async function postJson(path: string, body: Record<string, string>) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return { ok: res.ok, error: data && 'error' in data && typeof data.error === 'string' ? data.error : null };
}

export function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="stack" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h1>Log in</h1>
      <div aria-hidden="true"><FluidOrb size={200} color="#3B82F4" /></div>
      <Card>
        {error && <p><strong>{error}</strong></p>}
        <Button variant="secondary" onClick={() => { window.location.href = '/api/auth/sign-in/social?provider=discord'; }}>
          Continue with Discord
        </Button>
        <div className="fr-divider"><span>or</span></div>
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const email = String(form.get('email') ?? '');
          const password = String(form.get('password') ?? '');
          if (!email || !password) {
            setError('Email and password are required');
            return;
          }
          setPending(true);
          void postJson('/api/auth/sign-in/email', { email, password }).then((r) => {
            setPending(false);
            if (r.ok) window.location.href = '/dashboard/keys';
            else setError(r.error ?? 'Invalid email or password');
          });
        }}>
          <label>Email<Input name="email" type="email" autoComplete="email" required /></label>
          <label>Password<Input name="password" type="password" autoComplete="current-password" required /></label>
          <Button type="submit" disabled={pending}>{pending ? 'Logging in…' : 'Log in'}</Button>
        </form>
      </Card>
      <p className="muted">Need an account? <Link to="/signup">Sign up</Link></p>
    </div>
  );
}

export function SignupPage() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="stack" style={{ maxWidth: 420, margin: '0 auto' }}>
      <h1>Create your account</h1>
      <div aria-hidden="true"><FluidOrb size={200} color="#3B82F4" /></div>
      <Card>
        {error && <p><strong>{error}</strong></p>}
        <Button variant="secondary" onClick={() => { window.location.href = '/api/auth/sign-in/social?provider=discord'; }}>
          Sign up with Discord
        </Button>
        <div className="fr-divider"><span>or</span></div>
        <form className="stack" onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const name = String(form.get('name') ?? '');
          const email = String(form.get('email') ?? '');
          const password = String(form.get('password') ?? '');
          if (!email || !password || !name) {
            setError('Name, email and password are all required');
            return;
          }
          setPending(true);
          void postJson('/api/auth/sign-up/email', { name, email, password }).then((r) => {
            setPending(false);
            if (r.ok) window.location.href = '/dashboard/keys';
            else setError(r.error ?? 'Signup failed');
          });
        }}>
          <label>Name<Input name="name" autoComplete="name" required /></label>
          <label>Email<Input name="email" type="email" autoComplete="email" required /></label>
          <label>Password<Input name="password" type="password" autoComplete="new-password" minLength={8} required /></label>
          <Button type="submit" disabled={pending}>{pending ? 'Creating…' : 'Create account'}</Button>
        </form>
      </Card>
      <p className="muted">Already have an account? <Link to="/login">Log in</Link></p>
    </div>
  );
}
