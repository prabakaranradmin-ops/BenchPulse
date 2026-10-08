import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { createApi, type AdminConfig } from './lib/api';
import { routeHref, useRoute } from './lib/router';
import { SignIn } from './components/SignIn';
import { TrailsPage } from './components/TrailsPage';
import { ReportsPage } from './components/ReportsPage';
import { AnalyticsPage } from './components/AnalyticsPage';
import { ErrorBoundary, ToastProvider } from './components/ui';

// CesiumJS is most of the bundle; only the map screen pays for it.
const TrailEditor = lazy(() =>
  import('./components/TrailEditor').then((module) => ({ default: module.TrailEditor })),
);

export function App() {
  const api = useMemo(() => createApi(), []);
  const [session, setSession] = useState(() => api.session());
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const route = useRoute();

  useEffect(() => api.onSignedOut(() => setSession(null)), [api]);

  const signedIn = session !== null;
  useEffect(() => {
    if (!signedIn) return;
    // Map configuration is optional: without it the editor falls back to a flat OSM map. The
    // editor waits for the answer so the 3D viewer is built once, with the right imagery.
    api.config().then(setConfig, () => setConfig({ cesiumIonToken: null }));
  }, [api, signedIn]);

  if (!session) {
    return (
      <ToastProvider>
        <SignIn api={api} onSignedIn={setSession} />
      </ToastProvider>
    );
  }

  const section = route.name === 'trail' ? 'trails' : route.name;

  return (
    <ToastProvider>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden>
              ◎
            </span>
            Trail Admin
          </div>
          <nav className="nav" aria-label="Sections">
            <a
              href={routeHref({ name: 'trails' })}
              className={section === 'trails' ? 'active' : ''}
            >
              Trails
            </a>
            <a
              href={routeHref({ name: 'reports' })}
              className={section === 'reports' ? 'active' : ''}
            >
              Reports
            </a>
            <a
              href={routeHref({ name: 'analytics', trailId: null })}
              className={section === 'analytics' ? 'active' : ''}
            >
              Analytics
            </a>
          </nav>
          <button className="small" onClick={() => api.signOut()}>
            Sign out
          </button>
        </header>
        <main className="content">
          <ErrorBoundary resetKey={routeHref(route)}>
            {route.name === 'trails' && <TrailsPage api={api} />}
            {route.name === 'trail' && (
              <Suspense fallback={<div className="empty">Loading the map…</div>}>
                {config ? (
                  <TrailEditor
                    key={route.trailId}
                    api={api}
                    trailId={route.trailId}
                    focusPin={route.pinIndex}
                    config={config}
                  />
                ) : (
                  <div className="empty">Loading the map…</div>
                )}
              </Suspense>
            )}
            {route.name === 'reports' && <ReportsPage api={api} />}
            {route.name === 'analytics' && <AnalyticsPage api={api} trailId={route.trailId} />}
          </ErrorBoundary>
        </main>
      </div>
    </ToastProvider>
  );
}
