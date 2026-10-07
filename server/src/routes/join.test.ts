import { describe, it, expect, afterEach } from 'vitest';
import { buildTestApp, seedState, seedTrail, type TestApp } from '../testSupport/harness.js';

let ctx: TestApp | undefined;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

const PLAYER = 'player-1';
const CODE = 'HRBR7K2Q';

function harbourTrail(overrides: { published?: boolean } = {}) {
  return seedState(
    seedTrail({
      name: 'Harbour Trail',
      joinCode: CODE,
      published: overrides.published,
      pins: [
        { id: 'pin-1', sequenceIndex: 1, eastMeters: 0 },
        { id: 'pin-2', sequenceIndex: 2, eastMeters: 300 },
      ],
    }),
  );
}

describe('GET /api/v1/join/:code (join codes)', () => {
  it('resolves a code to its trail, however the player typed it', async () => {
    ctx = await buildTestApp(harbourTrail());

    for (const typed of ['HRBR7K2Q', 'hrbr-7k2q', 'HRBR 7K2Q']) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/join/${encodeURIComponent(typed)}`,
        headers: ctx.authHeader(PLAYER),
      });

      expect({ typed, status: response.statusCode }).toEqual({ typed, status: 200 });
      expect(response.json()).toEqual({
        trailId: 'trail-1',
        name: 'Harbour Trail',
        joinCode: 'HRBR-7K2Q',
        pinCount: 2,
        expiryDays: null,
      });
    }
  });

  it('tells a malformed code apart from an unknown one', async () => {
    ctx = await buildTestApp(harbourTrail());

    const malformed = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/join/NOT-A-CODE-0',
      headers: ctx.authHeader(PLAYER),
    });
    const unknown = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/join/ZZZZ-ZZZZ',
      headers: ctx.authHeader(PLAYER),
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: 'invalid_join_code' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: 'join_code_not_found' });
  });

  it("doesn't open an unpublished trail", async () => {
    ctx = await buildTestApp(harbourTrail({ published: false }));

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/join/${CODE}`,
      headers: ctx.authHeader(PLAYER),
    });

    expect(response.statusCode).toBe(404);
  });

  it('needs a signed-in player (SR-DATA-02: no anonymous browsing)', async () => {
    ctx = await buildTestApp(harbourTrail());

    const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/join/${CODE}` });

    expect(response.statusCode).toBe(401);
  });

  it('throttles guessing per address, even across many players', async () => {
    // Fresh device keys mint fresh players for free, so a per-player limit alone wouldn't slow
    // an enumeration. Twenty-one different players from one address still hit the wall.
    ctx = await buildTestApp(harbourTrail(), { rateLimit: { max: 1000, timeWindow: '1 minute' } });

    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/join/ZZZZ-ZZZZ',
        headers: ctx.authHeader(`player-${i}`),
      });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 20).every((status) => status === 404)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('GET /join/:code (the page a QR code or shared link opens)', () => {
  it('hands off to the app with the code, and nothing else about the trail', async () => {
    ctx = await buildTestApp(harbourTrail());

    const response = await ctx.app.inject({ method: 'GET', url: '/join/hrbr-7k2q' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('HRBR-7K2Q');
    expect(response.body).toContain('href="arquest://join/HRBR7K2Q"');
    // Trail details need a signed-in player; this page is public.
    expect(response.body).not.toContain('Harbour Trail');
  });

  it('renders the same page for a code that does not exist, so it cannot be used to test codes', async () => {
    ctx = await buildTestApp(harbourTrail());

    const known = await ctx.app.inject({ method: 'GET', url: `/join/${CODE}` });
    const unknown = await ctx.app.inject({ method: 'GET', url: '/join/ZZZZZZZZ' });

    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body.replaceAll('ZZZZ-ZZZZ', 'X').replaceAll('ZZZZZZZZ', 'Y')).toBe(
      known.body.replaceAll('HRBR-7K2Q', 'X').replaceAll(CODE, 'Y'),
    );
  });

  it('refuses a malformed code without reflecting it into the page', async () => {
    ctx = await buildTestApp(harbourTrail());

    const response = await ctx.app.inject({
      method: 'GET',
      url: `/join/${encodeURIComponent('<script>alert(1)</script>')}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('<script>');
  });

  it('locks the page down: no scripts, no sniffing, no referrer', async () => {
    ctx = await buildTestApp(harbourTrail());

    const response = await ctx.app.inject({ method: 'GET', url: `/join/${CODE}` });

    expect(response.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });
});
