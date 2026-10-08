// The Admin API (server/README.md, "Authoring API"). Same origin as the server, so paths are
// relative and there is no CORS to configure.

export type ChallengeType = 'proximity_dwell' | 'code_entry' | 'photo_confirmation';
export type ReportStatus = 'open' | 'reviewed' | 'resolved';

export interface AdminTrailRow {
  trailId: string;
  name: string;
  joinCode: string;
  expiryDays: number | null;
  currentVersionId: string | null;
  createdAt: string | null;
  versionNumber: number | null;
  pinCount: number;
  openReports: number;
}

export interface AdminPin {
  pinId: string;
  sequenceIndex: number;
  lat: number;
  lng: number;
  alt: number | null;
  radiusM: number;
  challengeType: ChallengeType;
  challengeConfig: Record<string, unknown>;
}

export interface TrailVersionRow {
  trailVersionId: string;
  versionNumber: number;
  publishedAt: string;
  pinCount: number;
  isCurrent: boolean;
}

export interface AdminTrailDetail {
  trailId: string;
  name: string;
  joinCode: string;
  expiryDays: number | null;
  currentVersionId: string | null;
  createdAt: string | null;
  versions: TrailVersionRow[];
  pins: AdminPin[];
}

export interface PublishPin {
  sequenceIndex: number;
  lat: number;
  lng: number;
  alt: number | null;
  radiusM: number;
  challengeType: ChallengeType;
  challengeConfig: Record<string, unknown>;
}

export interface ValidationIssue {
  code: string;
  message: string;
  sequenceIndex?: number;
}

export interface ValidationResult {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface PublishResult {
  trailId: string;
  trailVersionId: string;
  versionNumber: number;
  publishedAt: string;
  warnings: ValidationIssue[];
}

export interface ReportRow {
  reportId: string;
  pinId: string;
  note: string | null;
  status: ReportStatus;
  createdAt: string;
  trailId: string | null;
  trailName: string | null;
  sequenceIndex: number | null;
  lat: number | null;
  lng: number | null;
  versionNumber: number | null;
  isCurrentVersion: boolean;
}

export interface TrailAnalytics {
  trailId: string;
  trailName: string;
  attemptsStarted: number;
  attemptsCompleted: number;
  attemptsExpired: number;
  attemptsActive: number;
  completionRate: number | null;
  medianCompletionSeconds: number | null;
  p90CompletionSeconds: number | null;
  suppressed: boolean;
}

export interface FunnelStep {
  sequenceIndex: number;
  reached: number;
  completed: number;
  dropOffRate: number | null;
}

export interface AdminConfig {
  /** Cesium ion token for 3D terrain and OSM buildings; null falls back to a flat OSM map. */
  cesiumIonToken: string | null;
}

export interface Session {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** What the server said, kept machine-readable so the UI can word it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The subset of the Web Storage API the client needs — injectable for tests. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ApiOptions {
  fetchImpl?: typeof fetch;
  /** "Remember me" storage (localStorage in the browser). */
  persistent?: KeyValueStorage;
  /** This-tab-only storage (sessionStorage in the browser). */
  ephemeral?: KeyValueStorage;
  now?: () => number;
}

const SESSION_KEY = 'trail-admin.session';

export type AdminApi = ReturnType<typeof createApi>;

export function createApi(options: ApiOptions = {}) {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const persistent = options.persistent ?? globalThis.localStorage;
  const ephemeral = options.ephemeral ?? globalThis.sessionStorage;
  const now = options.now ?? Date.now;
  let onSignedOut: (() => void) | undefined;

  function readSession(): Session | null {
    for (const storage of [ephemeral, persistent]) {
      const raw = storage.getItem(SESSION_KEY);
      if (!raw) continue;
      try {
        const session = JSON.parse(raw) as Session;
        if (session.expiresAt > now()) return session;
      } catch {
        // Corrupt entry: treat as signed out.
      }
      storage.removeItem(SESSION_KEY);
    }
    return null;
  }

  function signOut() {
    ephemeral.removeItem(SESSION_KEY);
    persistent.removeItem(SESSION_KEY);
    onSignedOut?.();
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    token?: string | null,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await fetchImpl(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(
        0,
        'network_unavailable',
        "Can't reach the server. Check the connection and try again.",
      );
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const code = (parsed as { error?: string } | undefined)?.error ?? `http_${response.status}`;
      throw new ApiError(response.status, code, describeErrorCode(code, response.status), parsed);
    }
    return parsed as T;
  }

  /** Every Admin call: a 401 means the session is over, so drop it and let the app re-ask. */
  async function authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    const session = readSession();
    if (!session) {
      signOut();
      throw new ApiError(401, 'signed_out', 'Your session has ended. Sign in again.');
    }
    try {
      return await request<T>(method, path, body, session.token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        signOut();
      }
      throw err;
    }
  }

  return {
    session: readSession,
    signOut,
    onSignedOut(listener: () => void) {
      onSignedOut = listener;
    },

    /**
     * Exchanges an Admin key (from `npm run admin:new-key`) for a session token. Only the token
     * is stored — the key itself never touches browser storage — and only after confirming the
     * key really is an Admin's.
     */
    async signIn(deviceKey: string, remember: boolean): Promise<Session> {
      const key = deviceKey.trim();
      const token = await request<{ token: string; expiresInSeconds: number }>(
        'POST',
        '/api/v1/players/token',
        {
          deviceKey: key,
        },
      );
      try {
        await request<unknown>('GET', '/api/v1/admin/trails', undefined, token.token);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          throw new ApiError(403, 'admin_required', 'That key belongs to a player, not an Admin.');
        }
        throw err;
      }

      const session: Session = {
        token: token.token,
        expiresAt: now() + token.expiresInSeconds * 1000,
      };
      (remember ? persistent : ephemeral).setItem(SESSION_KEY, JSON.stringify(session));
      return session;
    },

    config: () => authed<AdminConfig>('GET', '/api/v1/admin/config'),

    listTrails: () =>
      authed<{ trails: AdminTrailRow[] }>('GET', '/api/v1/admin/trails').then((r) => r.trails),
    getTrail: (trailId: string) =>
      authed<AdminTrailDetail>('GET', `/api/v1/admin/trails/${encodeURIComponent(trailId)}`),
    createTrail: (name: string) => authed<AdminTrailRow>('POST', '/api/v1/admin/trails', { name }),
    updateTrail: (trailId: string, changes: { name?: string; expiryDays?: number | null }) =>
      authed<AdminTrailRow>(
        'PATCH',
        `/api/v1/admin/trails/${encodeURIComponent(trailId)}`,
        changes,
      ),
    rotateJoinCode: (trailId: string) =>
      authed<{ trailId: string; joinCode: string }>(
        'POST',
        `/api/v1/admin/trails/${encodeURIComponent(trailId)}/join-code`,
      ),
    validate: (pins: PublishPin[]) =>
      authed<ValidationResult>('POST', '/api/v1/admin/trails/validate', { pins }),
    publish: (trailId: string, pins: PublishPin[]) =>
      authed<PublishResult>(
        'POST',
        `/api/v1/admin/trails/${encodeURIComponent(trailId)}/versions`,
        { pins },
      ),

    listReports: (status?: ReportStatus) =>
      authed<{ reports: ReportRow[] }>(
        'GET',
        `/api/v1/admin/pin-reports${status ? `?status=${status}` : ''}`,
      ).then((r) => r.reports),
    setReportStatus: (reportId: string, status: ReportStatus) =>
      authed<unknown>('PATCH', `/api/v1/admin/pin-reports/${encodeURIComponent(reportId)}`, {
        status,
      }),

    analytics: (range: AnalyticsRange = {}) =>
      authed<{ minCohortSize: number; trails: TrailAnalytics[] }>(
        'GET',
        `/api/v1/admin/analytics/trails${rangeQuery(range)}`,
      ),
    trailAnalytics: (trailId: string, range: AnalyticsRange = {}) =>
      authed<TrailAnalytics & { minCohortSize: number; funnel: FunnelStep[] }>(
        'GET',
        `/api/v1/admin/analytics/trails/${encodeURIComponent(trailId)}${rangeQuery(range)}`,
      ),
  };
}

/** Attempts started in [from, to): the server's analytics window. */
export interface AnalyticsRange {
  from?: Date;
  to?: Date;
}

function rangeQuery(range: AnalyticsRange): string {
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from.toISOString());
  if (range.to) params.set('to', range.to.toISOString());
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** Plain-language wording for the server's error codes. */
export function describeErrorCode(code: string, status: number): string {
  switch (code) {
    case 'invalid_trail':
      return 'The trail has problems that stop it being published — see the list below the map.';
    case 'trail_not_found':
      return 'That trail no longer exists.';
    case 'admin_required':
      return 'That key belongs to a player, not an Admin.';
    case 'unauthorized':
      return 'Your session has ended. Sign in again.';
    case 'report_not_found':
      return 'That report no longer exists.';
    default:
      if (status === 429) return 'Too many requests — wait a moment and try again.';
      if (status >= 500) return 'The server had a problem. Try again in a moment.';
      if (status === 400) return 'The server rejected that request. Reload the page and try again.';
      return `Request failed (${code}).`;
  }
}
