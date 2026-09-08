import { describe, it, expect, afterEach } from 'vitest';
import { buildTestApp, completePin, seedState, seedTrail, type TestApp } from '../testSupport/harness.js';
import { hashDeviceKey } from '../services/deviceKey.js';

let ctx: TestApp | undefined;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

const DEVICE_KEY = 'a'.repeat(16) + 'f3c81d0b9e7a4526';
const OTHER_DEVICE_KEY = 'b'.repeat(16) + '17d4e9c2a8b06f31';

function exchange(app: TestApp, deviceKey: unknown) {
  return app.app.inject({
    method: 'POST',
    url: '/api/v1/players/token',
    payload: { deviceKey },
  });
}

describe('POST /api/v1/players/token (ST-2.6)', () => {
  it('creates a player and issues a session token for a new device key', async () => {
    ctx = await buildTestApp();

    const response = await exchange(ctx, DEVICE_KEY);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.userId).toEqual(expect.any(String));
    expect(body.token).toEqual(expect.any(String));
    expect(body.expiresInSeconds).toBe(30 * 24 * 60 * 60);
    expect(ctx.store.state.users).toHaveLength(1);
    expect(ctx.store.state.users[0].id).toBe(body.userId);
  });

  it('stores only the hash of the device key', async () => {
    ctx = await buildTestApp();

    const response = await exchange(ctx, DEVICE_KEY);

    expect(ctx.store.state.users[0].deviceKeyHash).toBe(hashDeviceKey(DEVICE_KEY));
    expect(ctx.store.state.users[0].deviceKeyHash).not.toBe(DEVICE_KEY);
    // The key must not come back in the response either.
    expect(response.body).not.toContain(DEVICE_KEY);
  });

  it('returns the same player for a repeat exchange, so progress survives token expiry', async () => {
    ctx = await buildTestApp();

    const first = await exchange(ctx, DEVICE_KEY);
    const second = await exchange(ctx, DEVICE_KEY);

    expect(second.json().userId).toBe(first.json().userId);
    expect(ctx.store.state.users).toHaveLength(1);
  });

  it('gives different devices different players (SR-DATA-01)', async () => {
    ctx = await buildTestApp();

    const a = await exchange(ctx, DEVICE_KEY);
    const b = await exchange(ctx, OTHER_DEVICE_KEY);

    expect(b.json().userId).not.toBe(a.json().userId);
    expect(ctx.store.state.users).toHaveLength(2);
  });

  it('rejects a device key short enough to be brute-forced', async () => {
    ctx = await buildTestApp();

    const response = await exchange(ctx, 'too-short');

    expect(response.statusCode).toBe(400);
    expect(ctx.store.state.users).toHaveLength(0);
  });

  it('rejects a request with no device key', async () => {
    ctx = await buildTestApp();

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/players/token',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('issues a token the scoped routes accept, end to end', async () => {
    ctx = await buildTestApp(
      seedState(
        seedTrail({
          pins: [
            { id: 'pin-1', sequenceIndex: 1, eastMeters: 0 },
            { id: 'pin-2', sequenceIndex: 2, eastMeters: 300 },
          ],
        }),
      ),
    );

    const { userId, token } = (await exchange(ctx, DEVICE_KEY)).json();
    const attempt = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      headers: { authorization: `Bearer ${token}` },
      payload: { trailId: 'trail-1' },
    });

    expect(attempt.statusCode).toBe(201);
    // The attempt belongs to the player the token was minted for — not to whoever asked.
    expect(ctx.store.state.attempts[0].userId).toBe(userId);
  });

});

describe('DELETE /api/v1/players/me (ST-8.2, SR-PRIV-02)', () => {
  const TRAIL = {
    pins: [
      { id: 'pin-1', sequenceIndex: 1, eastMeters: 0 },
      { id: 'pin-2', sequenceIndex: 2, eastMeters: 300 },
    ],
  };

  /** Plays a player partway through the trail so there is real data to delete. */
  async function playerWithProgress(app: TestApp, deviceKey: string) {
    const { userId, token } = (await exchange(app, deviceKey)).json();
    const auth = { authorization: `Bearer ${token}` };
    const attempt = await app.app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      headers: auth,
      payload: { trailId: 'trail-1' },
    });
    const attemptId = attempt.json().attemptId;
    await completePin(app, { userId, attemptId, pinId: 'pin-1' });
    await app.app.inject({
      method: 'POST',
      url: '/api/v1/pins/pin-2/report',
      headers: auth,
      payload: { note: 'Gate was locked' },
    });
    return { userId, auth };
  }

  it('deletes the requesting player’s location history, progress, and attempts', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TRAIL)));
    const { userId, auth } = await playerWithProgress(ctx, DEVICE_KEY);
    expect(ctx.store.state.locationHistory.length).toBeGreaterThan(0);

    const response = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/players/me', headers: auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      deleted: { locationSamples: 1, attempts: 1, player: true },
      discardDeviceKey: true,
    });
    expect(ctx.store.state.locationHistory).toHaveLength(0);
    expect(ctx.store.state.attempts).toHaveLength(0);
    expect(ctx.store.state.progress).toHaveLength(0);
    expect(ctx.store.state.users.find((u) => u.id === userId)).toBeUndefined();
  });

  it("leaves another player's data completely alone (SR-DATA-01)", async () => {
    ctx = await buildTestApp(seedState(seedTrail(TRAIL)));
    const survivor = await playerWithProgress(ctx, OTHER_DEVICE_KEY);
    const leaving = await playerWithProgress(ctx, DEVICE_KEY);

    await ctx.app.inject({ method: 'DELETE', url: '/api/v1/players/me', headers: leaving.auth });

    expect(ctx.store.state.users.map((u) => u.id)).toEqual([survivor.userId]);
    expect(ctx.store.state.attempts.map((a) => a.userId)).toEqual([survivor.userId]);
    expect(ctx.store.state.locationHistory.map((r) => r.userId)).toEqual([survivor.userId]);
    expect(ctx.store.state.progress).toHaveLength(2);
  });

  it('keeps the pin report but detaches the reporter (GDR-09)', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TRAIL)));
    const { auth } = await playerWithProgress(ctx, DEVICE_KEY);

    await ctx.app.inject({ method: 'DELETE', url: '/api/v1/players/me', headers: auth });

    // The Admin still has a "gate was locked" item to act on; it just isn't anyone's anymore.
    expect(ctx.store.state.pinReports).toHaveLength(1);
    expect(ctx.store.state.pinReports[0].reportedByUserId).toBeNull();
    expect(ctx.store.state.pinReports[0].note).toBe('Gate was locked');
  });

  it('turns a token whose player is gone into a 401 rather than a database error', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TRAIL)));
    const { auth } = await playerWithProgress(ctx, DEVICE_KEY);
    await ctx.app.inject({ method: 'DELETE', url: '/api/v1/players/me', headers: auth });

    // The JWT is still cryptographically valid — the player behind it isn't.
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      headers: auth,
      payload: { trailId: 'trail-1' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'player_not_found' });
  });

  it('gives the same device key a fresh player after deletion', async () => {
    ctx = await buildTestApp(seedState(seedTrail(TRAIL)));
    const first = (await exchange(ctx, DEVICE_KEY)).json();
    await ctx.app.inject({
      method: 'DELETE',
      url: '/api/v1/players/me',
      headers: { authorization: `Bearer ${first.token}` },
    });

    const second = (await exchange(ctx, DEVICE_KEY)).json();

    expect(second.userId).not.toBe(first.userId);
    expect(ctx.store.state.users).toHaveLength(1);
  });

  it('401s an unauthenticated deletion', async () => {
    ctx = await buildTestApp();

    const response = await ctx.app.inject({ method: 'DELETE', url: '/api/v1/players/me' });

    expect(response.statusCode).toBe(401);
  });
});
