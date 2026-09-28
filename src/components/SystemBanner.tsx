import React from 'react';
import { AlertTriangle } from 'lucide-react';

const POLL_INTERVAL_MS = 60_000;

// Platform-wide announcement banner (e.g. "maintenance tonight 10-11 PM") — rendered
// outside <App/> entirely (see main.tsx) so it shows on the login screen too, and polls a
// public, unauthenticated endpoint since there's no logged-in `db`/translation context
// available at this level. See server/routes/systemBanner.ts for the API this talks to.
// Deliberately not dismissible — it stays visible for every user until a super-admin turns
// it off, since a per-user dismiss would defeat the point of an active maintenance warning.
export default function SystemBanner() {
  const [state, setState] = React.useState<{ enabled: boolean; message: string; updatedAt: string | null }>({
    enabled: false, message: '', updatedAt: null,
  });

  React.useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch('/api/system-banner');
        if (!res.ok) return;
        const body = await res.json();
        if (cancelled) return;
        setState(body);
      } catch {
        // Silently skip a failed poll — this must never break the login screen or the app.
      }
    }
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!state.enabled || !state.message) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 2147483647,
      background: '#fffbeb', borderBottom: '1px solid #fcd34d', color: '#78350f',
      display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 16px', fontSize: '13px',
    }}>
      <AlertTriangle style={{ width: 16, height: 16, flexShrink: 0 }} />
      <span dir="auto" style={{ flex: 1, fontWeight: 600 }}>{state.message}</span>
    </div>
  );
}
