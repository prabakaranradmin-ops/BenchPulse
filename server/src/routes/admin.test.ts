import { describe, it, expect, afterEach } from 'vitest';
import {
  buildTestApp,
  lngAtMeters,
  seedState,
  seedTrail,
  type TestApp,
} from '../testSupport/harness.js';

let ctx: TestApp | undefined;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

const ADMIN = 'admin-1';
const PLAYER = 'player-1';

function draftPin(
  sequenceIndex: number,
  eastMeters: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    sequenceIndex,
    lat: 0,
    lng: lngAtMeters(eastMeters),
    radiusM: 10,
    challengeType: 'proximity_dwell',
    challengeConfig: { dwell_seconds: 15 },
    ...overrides,
  };
}

function createTrail(app: TestApp, body: Record<string, unknown> = { name: 'Harbour Trail' }) {
  return app.app.inject({
    method: 'POST',
    url: '/api/v1/admin/trails',
    headers: app.adminHeader(ADMIN),
    payload: body,
  });
}

function publish(app: TestApp, trailId: string, pins: unknown[]) {
  return app.app.inject({
    method: 'POST',
    url: `/api/v1/admin/trails/${trailId}/versions`,
    headers: app.adminHeader(ADMIN),
    payload: { pins },
  });
}

describe('POST /api/v1/admin/trails (ST-7.2)', () => {
  it('creates an unpublished trail shell owned by the authoring Admin', async () => {
    ctx = await buildTestApp();

    const response = await createTrail(ctx, { name: 'Harbour Trail', expiryDays: 7 });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: 'Harbour Trail',
      expiryDays: 7,
      currentVersionId: null,
    });
    expect(ctx.store.state.trails[0].createdBy).toBe(ADMIN);
  });

  it('defaults to no expiry (GDR-08)', async () => {
    ctx = await buildTestApp();

    const response = await createTrail(ctx);

    expect(response.json().expiryDays).toBeNull();
  });
});

describe('POST /api/v1/admin/trails/:trailId/versions (ST-7.2, GDR-07)', () => {
  it('publishes a version and points the trail at it, ready for players to fetch', async () => {
    ctx = await buildTestApp();
    const trailId = (await createTrail(ctx)).json().trailId;

    const response = await publish(ctx, trailId, [draftPin(1, 0), draftPin(2, 300)]);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ versionNumber: 1, warnings: [] });
    expect(response.json().pins.map((p: { sequenceIndex: number }) => p.sequenceIndex)).toEqual([
      1, 2,
    ]);

    // A player can now fetch it through the normal read path.
    const asPlayer = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/trails/${trailId}`,
      headers: ctx.authHeader(PLAYER),
    });
    expect(asPlayer.statusCode).toBe(200);
    expect(asPlayer.json().pins).toHaveLength(2);
  });

  it('leaves an in-flight attempt on the version it started on when a second version publishes', async () => {
    ctx = await buildTestApp();
    const trailId = (await createTrail(ctx)).json().trailId;
    const first = (await publish(ctx, trailId, [draftPin(1, 0), draftPin(2, 300)])).json();
    const attempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      headers: ctx.authHeader(PLAYER),
      payload: { trailId },
    });
    const attemptId = attempt.json().attemptId;

    const second = await publish(ctx, trailId, [
      draftPin(1, 0),
      draftPin(2, 400),
      draftPin(3, 800),
    ]);

    expect(second.json().versionNumber).toBe(2);
    const resumed = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${attemptId}`,
      headers: ctx.authHeader(PLAYER),
    });
    expect(resumed.json().trailVersionId).toBe(first.trailVersionId);
    expect(resumed.json().pins).toHaveLength(2);
    // A fresh attempt gets the new version.
    const fresh = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      headers: ctx.authHeader(PLAYER),
      payload: { trailId },
    });
    expect(fresh.json().trailVersionId).toBe(second.json().trailVersionId);
    expect(fresh.json().pins).toHaveLength(3);
  });

  it('publishes anyway but reports advisory warnings (SR-ADMIN-01)', async () => {
    ctx = await buildTestApp();
    const trailId = (await createTrail(ctx)).json().trailId;

    // 12m apart with 10m radii — pin 2 would complete itself the moment it unlocks.
    const response = await publish(ctx, trailId, [draftPin(1, 0), draftPin(2, 12)]);

    expect(response.statusCode).toBe(201);
    expect(response.json().warnings.map((w: { code: string }) => w.code)).toEqual([
      'pins_too_close',
    ]);
    expect(ctx.store.state.trails[0].currentVersionId).not.toBeNull();
  });

  it('refuses a structurally broken trail and writes nothing', async () => {
    ctx = await buildTestApp();
    const trailId = (await createTrail(ctx)).json().trailId;

    const response = await publish(ctx, trailId, [draftPin(1, 0), draftPin(3, 600)]);

    expect(response.statusCode).toBe(422);
    expect(response.json().errors.map((e: { code: string }) => e.code)).toContain(
      'non_contiguous_sequence',
    );
    expect(ctx.store.state.pins).toHaveLength(0);
    expect(ctx.store.state.versions).toHaveLength(0);
    expect(ctx.store.state.trails[0].currentVersionId).toBeNull();
  });

  it('404s publishing to a trail that does not exist', async () => {
    ctx = await buildTestApp();

    expect((await publish(ctx, 'nope', [draftPin(1, 0)])).statusCode).toBe(404);
  });
});

describe('pin report review queue (ST-7.3, GDR-09)', () => {
  async function seedReport(app: TestApp, note: string) {
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/pins/pin-1/report',
      headers: app.authHeader(PLAYER),
      payload: { note },
    });
    return response.json().reportId;
  }

  it('lists reports newest first, without exposing who filed them', async () => {
    ctx = await buildTestApp(
      seedState(seedTrail({ pins: [{ id: 'pin-1', sequenceIndex: 1, eastMeters: 0 }] })),
    );
    await seedReport(ctx, 'Statue gone');
    await seedReport(ctx, 'Fence around the square');

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/pin-reports',
      headers: ctx.adminHeader(ADMIN),
    });

    expect(response.statusCode).toBe(200);
    const { reports } = response.json();
    expect(reports).toHaveLength(2);
    expect(reports[0]).toMatchObject({ pinId: 'pin-1', status: 'open' });
    expect(response.body).not.toContain(PLAYER);
  });

  it('filters by status so a triaged queue stays short', async () => {
    ctx = await buildTestApp(
      seedState(seedTrail({ pins: [{ id: 'pin-1', sequenceIndex: 1, eastMeters: 0 }] })),
    );
    const first = await seedReport(ctx, 'Statue gone');
    await seedReport(ctx, 'Fence around the square');
    await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/pin-reports/${first}`,
      headers: ctx.adminHeader(ADMIN),
      payload: { status: 'resolved' },
    });

    const open = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/pin-reports?status=open',
      headers: ctx.adminHeader(ADMIN),
    });

    expect(open.json().reports).toHaveLength(1);
    expect(open.json().reports[0].note).toBe('Fence around the square');
  });

  it('moves a report through the review states', async () => {
    ctx = await buildTestApp(
      seedState(seedTrail({ pins: [{ id: 'pin-1', sequenceIndex: 1, eastMeters: 0 }] })),
    );
    const reportId = await seedReport(ctx, 'Statue gone');

    const response = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/pin-reports/${reportId}`,
      headers: ctx.adminHeader(ADMIN),
      payload: { status: 'reviewed' },
    });

    expect(response.json()).toMatchObject({ reportId, status: 'reviewed' });
    expect(ctx.store.state.pinReports[0].status).toBe('reviewed');
  });

  it('rejects an unknown report, an unknown status, and a silly limit', async () => {
    ctx = await buildTestApp();
    const admin = ctx.adminHeader(ADMIN);

    const missing = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/admin/pin-reports/nope',
      headers: admin,
      payload: { status: 'reviewed' },
    });
    const badStatus = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/pin-reports?status=archived',
      headers: admin,
    });
    const badLimit = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/pin-reports?limit=9000',
      headers: admin,
    });

    expect(missing.statusCode).toBe(404);
    expect(badStatus.statusCode).toBe(400);
    expect(badLimit.statusCode).toBe(400);
  });
});

describe('analytics endpoints (ST-8.3, SR-PRIV-03)', () => {
  const TRAIL = {
    pins: [
      { id: 'pin-1', sequenceIndex: 1, eastMeters: 0 },
      { id: 'pin-2', sequenceIndex: 2, eastMeters: 300 },
    ],
  };

  /** Seeds attempts directly so timestamps and outcomes are exact. */
  function seedAttempts(
    app: TestApp,
    specs: Array<{ startedAt: string; completedSeconds?: number; status?: 'active' | 'expired' }>,
  ) {
    specs.forEach((spec, index) => {
      const startedAt = new Date(spec.startedAt);
      const completed = spec.completedSeconds !== undefined;
      const attemptId = `attempt-${index + 1}`;
      app.store.state.attempts.push({
        id: attemptId,
        userId: `player-${index + 1}`,
        trailId: 'trail-1',
        trailVersionId: 'version-1',
        status: completed ? 'completed' : (spec.status ?? 'active'),
        startedAt,
        completedAt: completed
          ? new Date(startedAt.getTime() + spec.completedSeconds! * 1000)
          : null,
      });
      app.store.state.progress.push(
        { attemptId, pinId: 'pin-1', status: 'completed', completedAt: startedAt },
        {
          attemptId,
          pinId: 'pin-2',
          status: completed ? 'completed' : 'unlocked',
          completedAt: completed ? startedAt : null,
        },
      );
    });
  }

  it('reports completion rate, timings, and the drop-off funnel for one trail', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TRAIL)));
    seedAttempts(ctx, [
      { startedAt: '2026-05-01T00:00:00Z', completedSeconds: 600 },
      { startedAt: '2026-05-01T01:00:00Z', completedSeconds: 1200 },
      { startedAt: '2026-05-01T02:00:00Z', completedSeconds: 3000 },
      { startedAt: '2026-05-01T03:00:00Z', status: 'expired' },
      { startedAt: '2026-05-01T04:00:00Z', status: 'active' },
      { startedAt: '2026-05-01T05:00:00Z', status: 'active' },
    ]);

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics/trails/trail-1',
      headers: ctx.adminHeader(ADMIN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      attemptsStarted: 6,
      attemptsCompleted: 3,
      attemptsExpired: 1,
      attemptsActive: 2,
      completionRate: 0.5,
      medianCompletionSeconds: 1200,
      suppressed: false,
    });
    expect(response.json().funnel).toEqual([
      { sequenceIndex: 1, reached: 6, completed: 6, dropOffRate: 0 },
      { sequenceIndex: 2, reached: 6, completed: 3, dropOffRate: 0.5 },
    ]);
  });

  it('returns zeros rather than a 404 for a range with no attempts in it', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TRAIL)));
    seedAttempts(ctx, [{ startedAt: '2026-05-01T00:00:00Z', completedSeconds: 600 }]);

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics/trails/trail-1?from=2026-06-01T00:00:00Z&to=2026-07-01T00:00:00Z',
      headers: ctx.adminHeader(ADMIN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      attemptsStarted: 0,
      completionRate: null,
      suppressed: true,
      funnel: [],
    });
    expect(response.json().range).toEqual({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-07-01T00:00:00.000Z',
    });
  });

  it('lists trails with their aggregates', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TRAIL)));
    seedAttempts(ctx, [
      { startedAt: '2026-05-01T00:00:00Z', completedSeconds: 600 },
      { startedAt: '2026-05-01T01:00:00Z', status: 'active' },
    ]);

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics/trails',
      headers: ctx.adminHeader(ADMIN),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().minCohortSize).toBe(5);
    expect(response.json().trails).toEqual([
      expect.objectContaining({ trailId: 'trail-1', attemptsStarted: 2, suppressed: true }),
    ]);
    expect(response.json().range).toEqual({ from: null, to: null });
  });

  it('404s analytics for a trail that does not exist', async () => {
    ctx = await buildTestApp();

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/analytics/trails/nope',
      headers: ctx.adminHeader(ADMIN),
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects malformed date ranges and limits', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TRAIL)));
    const admin = ctx.adminHeader(ADMIN);
    const cases = [
      ['/api/v1/admin/analytics/trails?from=last-tuesday', 'invalid_from'],
      ['/api/v1/admin/analytics/trails?to=nonsense', 'invalid_to'],
      ['/api/v1/admin/analytics/trails?from=2026-02-01&to=2026-01-01', 'inverted_range'],
      ['/api/v1/admin/analytics/trails?limit=0', 'invalid_limit'],
      ['/api/v1/admin/analytics/trails?limit=9000', 'invalid_limit'],
      ['/api/v1/admin/analytics/trails/trail-1?from=whenever', 'invalid_from'],
    ] as const;

    for (const [url, error] of cases) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: admin });
      expect({ url, status: response.statusCode, error: response.json().error }).toEqual({
        url,
        status: 400,
        error,
      });
    }
  });
});

describe('admin authorization (requirements §2)', () => {
  const adminRoutes = [
    { method: 'POST' as const, url: '/api/v1/admin/trails', payload: { name: 'Sneaky Trail' } },
    {
      method: 'POST' as const,
      url: '/api/v1/admin/trails/trail-1/versions',
      payload: { pins: [draftPin(1, 0)] },
    },
    { method: 'GET' as const, url: '/api/v1/admin/pin-reports', payload: undefined },
    {
      method: 'PATCH' as const,
      url: '/api/v1/admin/pin-reports/some-id',
      payload: { status: 'resolved' },
    },
    { method: 'GET' as const, url: '/api/v1/admin/analytics/trails', payload: undefined },
    { method: 'GET' as const, url: '/api/v1/admin/analytics/trails/trail-1', payload: undefined },
    { method: 'GET' as const, url: '/api/v1/admin/trails', payload: undefined },
    { method: 'GET' as const, url: '/api/v1/admin/trails/trail-1', payload: undefined },
    {
      method: 'PATCH' as const,
      url: '/api/v1/admin/trails/trail-1',
      payload: { name: 'Mine now' },
    },
    { method: 'POST' as const, url: '/api/v1/admin/trails/trail-1/join-code', payload: undefined },
    {
      method: 'POST' as const,
      url: '/api/v1/admin/trails/validate',
      payload: { pins: [draftPin(1, 0)] },
    },
  ];

  it('403s a player on every authoring route — content is Admin-authored in v1', async () => {
    ctx = await buildTestApp(
      seedState(seedTrail({ pins: [{ id: 'pin-1', sequenceIndex: 1, eastMeters: 0 }] })),
    );

    for (const route of adminRoutes) {
      const response = await ctx.app.inject({
        method: route.method,
        url: route.url,
        headers: ctx.authHeader(PLAYER),
        ...(route.payload ? { payload: route.payload } : {}),
      });
      expect({ url: route.url, status: response.statusCode }).toEqual({
        url: route.url,
        status: 403,
      });
    }
    expect(ctx.store.state.trails.map((t) => t.name)).not.toContain('Sneaky Trail');
  });

  it('401s an unauthenticated caller on every authoring route', async () => {
    ctx = await buildTestApp();

    for (const route of adminRoutes) {
      const response = await ctx.app.inject({
        method: route.method,
        url: route.url,
        ...(route.payload ? { payload: route.payload } : {}),
      });
      expect({ url: route.url, status: response.statusCode }).toEqual({
        url: route.url,
        status: 401,
      });
    }
  });

  it('403s a token whose admin rights were revoked, without waiting for it to expire', async () => {
    ctx = await buildTestApp();
    const header = ctx.adminHeader(ADMIN);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/admin/pin-reports',
          headers: header,
        })
      ).statusCode,
    ).toBe(200);

    await ctx.store.setUserRole(ADMIN, 'player');

    // Same token, still cryptographically valid — the role is re-read per request.
    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/admin/pin-reports',
      headers: header,
    });
    expect(after.statusCode).toBe(403);
  });
});
