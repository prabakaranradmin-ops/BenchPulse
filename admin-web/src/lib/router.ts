// Hash routing: the server only has to serve /admin/index.html, and deep links still work.

import { useEffect, useState } from 'react';

export type Route =
  | { name: 'trails' }
  | { name: 'trail'; trailId: string; pinIndex: number | null }
  | { name: 'reports' }
  | { name: 'analytics'; trailId: string | null };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [section, id, sub, subId] = path.split('/').map((part) => decodeURIComponent(part));

  if (section === 'trails' && id) {
    const pinIndex = sub === 'pins' && subId && /^\d+$/.test(subId) ? Number(subId) : null;
    return { name: 'trail', trailId: id, pinIndex };
  }
  if (section === 'reports') return { name: 'reports' };
  if (section === 'analytics') return { name: 'analytics', trailId: id || null };
  return { name: 'trails' };
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case 'trails':
      return '#/trails';
    case 'trail':
      return `#/trails/${encodeURIComponent(route.trailId)}${route.pinIndex ? `/pins/${route.pinIndex}` : ''}`;
    case 'reports':
      return '#/reports';
    case 'analytics':
      return route.trailId ? `#/analytics/${encodeURIComponent(route.trailId)}` : '#/analytics';
  }
}

export function navigate(route: Route) {
  window.location.hash = routeHref(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
