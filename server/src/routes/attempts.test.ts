import { describe, it, expect, afterEach } from 'vitest';
import {
  buildTestApp,
  completePin,
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

function startAttempt(app: TestApp, userId: string, trailId = 'trail-1') {
  return app.app.inject({
    method: 'POST',
    url: '/api/v1/attempts',
    headers: app.authHeader(userId),
    payload: { trailId },
  });
}

describe('POST /api/v1/attempts (ST-2.2)', () => {
  it('snapshots the current trail version and unlocks only the first pin (GDR-01, GDR-07)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));

    const response = await startAttempt(ctx, PLAYER_A);

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.trailVersionId).toBe('version-1');
    expect(body.status).toBe('active');
    expect(body.currentPinId).toBe('pin-1');
    expect(body.pins).toEqual([
      { pinId: 'pin-1', sequenceIndex: 1, status: 'unlocked' },
      { pinId: 'pin-2', sequenceIndex: 2, status: 'locked' },
    ]);
  });

  it('creates a new attempt on replay and leaves the completed one untouched (GDR-06)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));

    // Full walkthrough of the trail first (requirements §7 integration case).
    const first = (await startAttempt(ctx, PLAYER_A)).json();
    await completePin(ctx, { userId: PLAYER_A, attemptId: first.attemptId, pinId: 'pin-1' });
    const finalPin = await completePin(ctx, {
      userId: PLAYER_A,
      attemptId: first.attemptId,
      pinId: 'pin-2',
    });
    expect(finalPin.json().attemptStatus).toBe('completed');

    const replay = await startAttempt(ctx, PLAYER_A);

    expect(replay.statusCode).toBe(201);
    const second = replay.json();
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.pins.map((p: { status: string }) => p.status)).toEqual(['unlocked', 'locked']);

    // The original attempt keeps its completion history — replay never overwrites it.
    const original = ctx.store.state.attempts.find((a) => a.id === first.attemptId);
    expect(original?.status).toBe('completed');
    expect(original?.completedAt).not.toBeNull();
    const originalProgress = ctx.store.state.progress.filter(
      (p) => p.attemptId === first.attemptId,
    );
    expect(originalProgress.map((p) => p.status)).toEqual(['completed', 'completed']);
  });

  it('keeps an in-progress attempt on the version it started on when the Admin publishes an edit (GDR-07)', async () => {
    const v1 = seedTrail(TWO_PIN_TRAIL);
    const v2 = seedTrail({
      versionId: 'version-2',
      versionNumber: 2,
      pins: [
        { id: 'pin-1-v2', sequenceIndex: 1, eastMeters: 0 },
        { id: 'pin-2-v2', sequenceIndex: 2, eastMeters: 500 },
        { id: 'pin-3-v2', sequenceIndex: 3, eastMeters: 900 },
      ],
    });
    ctx = await buildTestApp(seedState(v1, v2));

    // Player started before the edit: their attempt was seeded against version-1.
    const midTrail = await ctx.store.createAttempt({
      userId: PLAYER_A,
      trailId: 'trail-1',
      trailVersionId: 'version-1',
    });

    const existing = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${midTrail.id}`,
      headers: ctx.authHeader(PLAYER_A),
    });
    expect(existing.json().trailVersionId).toBe('version-1');
    expect(existing.json().pins.map((p: { pinId: string }) => p.pinId)).toEqual(['pin-1', 'pin-2']);

    // A new attempt picks up the freshly published version.
    const fresh = await startAttempt(ctx, PLAYER_A);
    expect(fresh.json().trailVersionId).toBe('version-2');
    expect(fresh.json().pins).toHaveLength(3);
  });

  it('404s an unpublished or unknown trail', async () => {
    ctx = await buildTestApp(
      seedState(
        seedTrail({ published: false, pins: [{ id: 'pin-1', sequenceIndex: 1, eastMeters: 0 }] }),
      ),
    );

    expect((await startAttempt(ctx, PLAYER_A)).statusCode).toBe(404);
    expect((await startAttempt(ctx, PLAYER_A, 'no-such-trail')).statusCode).toBe(404);
  });

  it('400s a request with no trailId', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      headers: ctx.authHeader(PLAYER_A),
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('401s an unauthenticated request (ST-2.5)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      payload: { trailId: 'trail-1' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/v1/attempts/:attemptId (CR-02, SR-DATA-01/02)', () => {
  it('resumes on the pin the player left off at', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attempt = (await startAttempt(ctx, PLAYER_A)).json();
    await completePin(ctx, { userId: PLAYER_A, attemptId: attempt.attemptId, pinId: 'pin-1' });

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${attempt.attemptId}`,
      headers: ctx.authHeader(PLAYER_A),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().currentPinId).toBe('pin-2');
    expect(response.json().pins).toEqual([
      { pinId: 'pin-1', sequenceIndex: 1, status: 'completed' },
      { pinId: 'pin-2', sequenceIndex: 2, status: 'unlocked' },
    ]);
  });

  it("never returns another player's attempt (SR-DATA-02)", async () => {
    ctx = await buildTestApp(seedState(seedTrail(TWO_PIN_TRAIL)));
    const attempt = (await startAttempt(ctx, PLAYER_A)).json();

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${attempt.attemptId}`,
      headers: ctx.authHeader(PLAYER_B),
    });

    // 404, not 403 — player B shouldn't be able to confirm the attempt exists at all.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'attempt_not_found' });
  });

  it('marks an attempt past its trail validity window as expired without deleting it (GDR-08)', async () => {
    ctx = await buildTestApp(seedState(seedTrail({ ...TWO_PIN_TRAIL, expiryDays: 7 })));
    const attempt = await ctx.store.createAttempt({
      userId: PLAYER_A,
      trailId: 'trail-1',
      trailVersionId: 'version-1',
    });
    attempt.startedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/attempts/${attempt.id}`,
      headers: ctx.authHeader(PLAYER_A),
    });

    expect(response.json().status).toBe('expired');
    expect(ctx.store.state.attempts.find((a) => a.id === attempt.id)?.status).toBe('expired');
    // Expiry must not block a fresh attempt.
    expect((await startAttempt(ctx, PLAYER_A)).statusCode).toBe(201);
  });
});
