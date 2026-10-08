import { useState, type FormEvent } from 'react';
import type { AdminApi, Session } from '../lib/api';
import { errorMessage } from './ui';

/**
 * Admins sign in with a key from `npm run admin:new-key`. The key is exchanged for a session
 * token and then forgotten — only the token is kept, and only in this tab unless "remember" is on.
 */
export function SignIn({
  api,
  onSignedIn,
}: {
  api: AdminApi;
  onSignedIn: (session: Session) => void;
}) {
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.signIn(key, remember));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <form className="card" onSubmit={submit}>
        <div className="card-body stack">
          <div className="brand">
            <span className="brand-mark" aria-hidden>
              ◎
            </span>
            Trail Admin
          </div>
          <div>
            <h1>Sign in</h1>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              Paste the Admin key printed by <span className="mono">npm run admin:new-key</span>.
            </p>
          </div>
          <label className="field">
            Admin key
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="64 hexadecimal characters"
              autoFocus
            />
          </label>
          <label className="row" style={{ fontWeight: 500 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            Keep me signed in on this computer
          </label>
          {error && <div className="notice error">{error}</div>}
          <button className="primary" type="submit" disabled={busy || key.trim().length < 32}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
