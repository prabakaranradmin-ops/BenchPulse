import { describe, it, expect, afterEach } from 'vitest';
import {
  buildTestApp,
  completePin,
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

const PLAYER_A = 'user-a';
const PLAYER_B = 'user-b';

const TWO_PIN_TRAIL = {
  pins: [
    { id: 'pin-1', sequenceIndex: 1, eastMeters: 0 },
    { id: 'pin-2', sequenceIndex: 2, eastMeters: 300 },
  ],
};

async function startAttempt(app: TestApp, userId: string, trailId = 'trail-1'): Promise<string> {
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/v1/attempts',
    headers: app.authHeader(userId),
    payload: { trailId },
  });
  return response.json().attemptId;
}

function progressFor(app: TestApp, attemptId: string, pinId: string) {
  return app.store.state.progress.find((p) => p.attemptId === attemptId && p.pinId === pinId);
}

describe('POST /api/v1/attempts/:attemptId/pins/:pinId/complete (ST-2.3)', () => {
  it('completes the unlocked pin and unlocks the next one (GDR-01)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);

    const response = await completePin(ctx, { userId: PLAYER_A, attemptId, pinId: 'pin-1' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      pinId: 'pin-1',
      status: 'completed',
      nextPinId: 'pin-2',
      attemptStatus: 'active',
      effectiveRadiusM: 10,
      locationFlag: null,
    });
    expect(progressFor(ctx, attemptId, 'pin-1')?.status).toBe('completed');
    expect(progressFor(ctx, attemptId, 'pin-2')?.status).toBe('unlocked');
  });

  it('completes the attempt when the last pin is done (GDR-04)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);
    await completePin(ctx, { userId: PLAYER_A, attemptId, pinId: 'pin-1' });

    const response = await completePin(ctx, { userId: PLAYER_A, attemptId, pinId: 'pin-2' });

    expect(response.json()).toMatchObject({ nextPinId: null, attemptStatus: 'completed' });
    const attempt = ctx.store.state.attempts.find((a) => a.id === attemptId);
    expect(attempt?.status).toBe('completed');
    expect(attempt?.completedAt).not.toBeNull();
  });

  it('rejects skipping ahead to a locked pin and changes nothing (GDR-01)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);

    const response = await completePin(ctx, { userId: PLAYER_A, attemptId, pinId: 'pin-2' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'pin_locked' });
    expect(progressFor(ctx, attemptId, 'pin-1')?.status).toBe('unlocked');
    expect(progressFor(ctx, attemptId, 'pin-2')?.status).toBe('locked');
  });

  it('rejects re-completing a pin', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);
    await completePin(ctx, { userId: PLAYER_A, attemptId, pinId: 'pin-1' });

    const response = await completePin(ctx, { userId: PLAYER_A, attemptId, pinId: 'pin-1' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'pin_already_completed' });
  });

  it("rejects completing another player's attempt and leaves their progress alone (SR-DATA-01/02)", async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);

    const response = await completePin(ctx, { userId: PLAYER_B, attemptId, pinId: 'pin-1' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'attempt_not_found' });
    expect(progressFor(ctx, attemptId, 'pin-1')?.status).toBe('unlocked');
    // Nothing about player A's session should have been written by player B's request either.
    expect(ctx.store.state.locationHistory).toHaveLength(0);
  });

  it('rejects a pin that belongs to a different trail', async () => {
    const other = seedTrail({
      trailId: 'trail-2',
      versionId: 'version-2',
      pins: [{ id: 'other-pin', sequenceIndex: 1, eastMeters: 0 }],
    });
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL), other));
    const attemptId = await startAttempt(ctx, PLAYER_A);

    const response = await completePin(ctx, { userId: PLAYER_A, attemptId, pinId: 'other-pin' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'pin_not_in_attempt' });
  });

  it('rejects a fix outside the effective radius with the distance the client needs (SR-GEO-04)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);

    const response = await completePin(ctx, {
      userId: PLAYER_A,
      attemptId,
      pinId: 'pin-1',
      lat: 0,
      lng: lngAtMeters(80),
      accuracyM: 5,
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error).toBe('outside_effective_radius');
    expect(body.distanceM).toBeCloseTo(80, 0);
    expect(body.effectiveRadiusM).toBe(10);
    expect(progressFor(ctx, attemptId, 'pin-1')?.status).toBe('unlocked');
  });

  it('accepts a fix inside the accuracy-widened radius (SR-GEO-04)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);

    // 22m from a 10m pin, but the device only claims 30m accuracy.
    const response = await completePin(ctx, {
      userId: PLAYER_A,
      attemptId,
      pinId: 'pin-1',
      lat: 0,
      lng: lngAtMeters(22),
      accuracyM: 30,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().effectiveRadiusM).toBe(30);
  });

  it('asks the player to move to open sky when accuracy exceeds the ceiling (SR-GEO-04)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);

    const response = await completePin(ctx, {
      userId: PLAYER_A,
      attemptId,
      pinId: 'pin-1',
      accuracyM: 85,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: 'accuracy_exceeds_ceiling',
      message: 'GPS signal weak — move to open sky',
    });
    expect(progressFor(ctx, attemptId, 'pin-1')?.status).toBe('unlocked');
  });

  it("flags implausible movement but still grants the completion (SR-SEC-02 flag, don't block)", async () => {
    // 35 m/s sustained across the full 30s window, ending on the pin.
    const speedMps = 35;
    const intervalSeconds = 5;
    const sampleCount = 7;
    const totalMeters = speedMps * intervalSeconds * (sampleCount - 1);
    ctx = await buildTestApp(
      seedState(
        seedTrail({
          pins: [
            { id: 'pin-1', sequenceIndex: 1, eastMeters: totalMeters },
            { id: 'pin-2', sequenceIndex: 2, eastMeters: totalMeters + 300 },
          ],
        }),
      ),
    );
    const attemptId = await startAttempt(ctx, PLAYER_A);

    const firstSampleAt = new Date('2026-03-01T10:00:00Z');
    const history = Array.from({ length: sampleCount }, (_, i) => ({
      lat: 0,
      lng: lngAtMeters(speedMps * intervalSeconds * i),
      recordedAt: new Date(firstSampleAt.getTime() + i * intervalSeconds * 1000),
    }));

    const response = await completePin(ctx, {
      userId: PLAYER_A,
      attemptId,
      pinId: 'pin-1',
      recordedAt: history[history.length - 1].recordedAt,
      sessionStartedAt: new Date(firstSampleAt.getTime() - 120_000),
      recentLocationHistory: history,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().locationFlag).toMatchObject({
      reason: 'sustained_speed_exceeds_threshold',
    });
    expect(response.json().locationFlag.avgSpeedMps).toBeCloseTo(35, 0);
    // Flagged, not blocked — progress still moves.
    expect(progressFor(ctx, attemptId, 'pin-1')?.status).toBe('completed');
  });

  it('does not flag a normal walk to the pin', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);

    const firstSampleAt = new Date('2026-03-01T10:00:00Z');
    const history = Array.from({ length: 7 }, (_, i) => ({
      lat: 0,
      lng: lngAtMeters(-1.4 * 5 * (6 - i)), // walking east toward the pin at ~1.4 m/s
      recordedAt: new Date(firstSampleAt.getTime() + i * 5000),
    }));

    const response = await completePin(ctx, {
      userId: PLAYER_A,
      attemptId,
      pinId: 'pin-1',
      recordedAt: history[history.length - 1].recordedAt,
      sessionStartedAt: new Date(firstSampleAt.getTime() - 120_000),
      recentLocationHistory: history,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().locationFlag).toBeNull();
  });

  it('stores location samples at their capture time, not receipt time (SR-NET-02)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);
    // A completion that happened offline ten minutes ago and is only now being submitted.
    const capturedAt = new Date(Date.now() - 10 * 60 * 1000);

    const response = await completePin(ctx, {
      userId: PLAYER_A,
      attemptId,
      pinId: 'pin-1',
      recordedAt: capturedAt,
    });

    expect(response.statusCode).toBe(200);
    expect(progressFor(ctx, attemptId, 'pin-1')?.completedAt?.toISOString()).toBe(
      capturedAt.toISOString(),
    );
    expect(ctx.store.state.locationHistory).toEqual([
      expect.objectContaining({ userId: PLAYER_A, recordedAt: capturedAt }),
    ]);
  });

  it('does not re-store a sample it already holds at that capture time (SR-PRIV-01)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);
    const at = new Date('2026-03-01T10:00:00Z');
    const history = [
      { lat: 0, lng: 0, recordedAt: new Date(at.getTime() - 10_000) },
      { lat: 0, lng: 0, recordedAt: at },
    ];

    await completePin(ctx, {
      userId: PLAYER_A,
      attemptId,
      pinId: 'pin-1',
      recordedAt: at,
      recentLocationHistory: history,
    });
    // Client resubmits overlapping history with the next completion.
    await completePin(ctx, {
      userId: PLAYER_A,
      attemptId,
      pinId: 'pin-2',
      recordedAt: new Date(at.getTime() + 60_000),
      recentLocationHistory: history,
    });

    const times = ctx.store.state.locationHistory.map((row) => row.recordedAt.getTime());
    expect(new Set(times).size).toBe(times.length);
  });

  it('400s an unparseable timestamp', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/pins/pin-1/complete`,
      headers: ctx.authHeader(PLAYER_A),
      payload: { lat: 0, lng: 0, accuracyM: 5, recordedAt: 'yesterday-ish' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_timestamp' });
  });

  it('401s an unauthenticated completion (ST-2.5)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attemptId = await startAttempt(ctx, PLAYER_A);

    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/pins/pin-1/complete`,
      payload: { lat: 0, lng: 0, accuracyM: 5 },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/v1/pins/:pinId/report (ST-2.4, GDR-09)', () => {
  it('queues a report against the pin for Admin review', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/pins/pin-1/report',
      headers: ctx.authHeader(PLAYER_A),
      payload: { note: 'Statue is gone, fence around the whole square' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ pinId: 'pin-1', status: 'open' });
    expect(ctx.store.state.pinReports).toHaveLength(1);
    expect(ctx.store.state.pinReports[0]).toMatchObject({
      pinId: 'pin-1',
      reportedByUserId: PLAYER_A,
      note: 'Statue is gone, fence around the whole square',
      status: 'open',
    });
  });

  it('accepts a report with no note, and does not dedup in v1', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));

    for (const player of [PLAYER_A, PLAYER_A, PLAYER_B]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/pins/pin-1/report',
        headers: ctx.authHeader(player),
        payload: {},
      });
      expect(response.statusCode).toBe(201);
    }

    expect(ctx.store.state.pinReports).toHaveLength(3);
    expect(ctx.store.state.pinReports[0].note).toBeNull();
  });

  it('404s a report against a pin that does not exist', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/pins/nope/report',
      headers: ctx.authHeader(PLAYER_A),
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(ctx.store.state.pinReports).toHaveLength(0);
  });

  it('401s an unauthenticated report', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/pins/pin-1/report',
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('rate limiting (SR-SEC-03)', () => {
  it('limits per player, not per IP', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)), {
      rateLimit: { max: 2, timeWindow: '1 minute' },
    });
    const report = (userId: string) =>
      ctx!.app.inject({
        method: 'POST',
        url: '/api/v1/pins/pin-1/report',
        headers: ctx!.authHeader(userId),
        payload: {},
      });

    expect((await report(PLAYER_A)).statusCode).toBe(201);
    expect((await report(PLAYER_A)).statusCode).toBe(201);
    expect((await report(PLAYER_A)).statusCode).toBe(429);
    // Player B shares the test's IP but must not share player A's budget.
    expect((await report(PLAYER_B)).statusCode).toBe(201);
  });
});
