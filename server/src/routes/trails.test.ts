import { describe, it, expect, afterEach } from 'vitest';
import { buildTestApp, seedState, seedTrail, type TestApp } from '../testSupport/harness.js';

let ctx: TestApp | undefined;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

const PLAYER = 'user-a';

describe('GET /api/v1/trails/:trailId (ST-2.1, SR-NET-01)', () => {
  it('returns the current published version pins ordered by sequence_index', async () => {
    const trail = seedTrail({
      name: 'Harbour Trail',
      pins: [
        // Seeded out of order on purpose — ordering is the endpoint's job, not the seed's.
        { id: 'pin-2', sequenceIndex: 2, eastMeters: 200 },
        { id: 'pin-1', sequenceIndex: 1, eastMeters: 0, challengeConfig: { dwell_seconds: 15 } },
        { id: 'pin-3', sequenceIndex: 3, eastMeters: 400 },
      ],
    });
    ctx = await buildTestApp(seedState(trail));

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/trail-1',
      headers: ctx.authHeader(PLAYER),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.trailId).toBe('trail-1');
    expect(body.name).toBe('Harbour Trail');
    expect(body.trailVersionId).toBe('version-1');
    expect(body.versionNumber).toBe(1);
    expect(body.expiryDays).toBeNull();
    expect(body.pins.map((p: { pinId: string }) => p.pinId)).toEqual(['pin-1', 'pin-2', 'pin-3']);
    expect(body.pins[0]).toMatchObject({
      sequenceIndex: 1,
      radiusM: 10,
      challengeType: 'proximity_dwell',
      challenge: { dwell_seconds: 15 },
    });
  });

  it('omits challenge answers from the cacheable payload', async () => {
    const trail = seedTrail({
      pins: [
        {
          id: 'pin-1',
          sequenceIndex: 1,
          eastMeters: 0,
          challengeType: 'code_entry',
          challengeConfig: { code: 'SWAN42', hint: 'Read the plaque' },
        },
      ],
    });
    ctx = await buildTestApp(seedState(trail));

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/trail-1',
      headers: ctx.authHeader(PLAYER),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().pins[0].challenge).toEqual({ hint: 'Read the plaque' });
    expect(response.body).not.toContain('SWAN42');
  });

  it('404s an unpublished trail (no current_version_id)', async () => {
    const trail = seedTrail({
      published: false,
      pins: [{ id: 'pin-1', sequenceIndex: 1, eastMeters: 0 }],
    });
    ctx = await buildTestApp(seedState(trail));

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/trail-1',
      headers: ctx.authHeader(PLAYER),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'trail_not_found' });
  });

  it('404s a trail that does not exist', async () => {
    ctx = await buildTestApp();

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/does-not-exist',
      headers: ctx.authHeader(PLAYER),
    });

    expect(response.statusCode).toBe(404);
  });

  it('401s an unauthenticated request (ST-2.5)', async () => {
    const trail = seedTrail({ pins: [{ id: 'pin-1', sequenceIndex: 1, eastMeters: 0 }] });
    ctx = await buildTestApp(seedState(trail));

    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/trails/trail-1' });

    expect(response.statusCode).toBe(401);
  });

  it('401s a token signed with the wrong secret', async () => {
    const trail = seedTrail({ pins: [{ id: 'pin-1', sequenceIndex: 1, eastMeters: 0 }] });
    ctx = await buildTestApp(seedState(trail));

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/trail-1',
      headers: { authorization: 'Bearer not.a.real.token' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('marks the payload as the current version', async () => {
    const trail = seedTrail({ pins: [{ id: 'pin-1', sequenceIndex: 1, eastMeters: 0 }] });
    ctx = await buildTestApp(seedState(trail));

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/trail-1',
      headers: ctx.authHeader(PLAYER),
    });

    expect(response.json().isCurrentVersion).toBe(true);
  });
});

describe('GET /api/v1/trails/:trailId/versions/:trailVersionId (GDR-07, CR-02)', () => {
  /** Version 1 has two pins; the Admin then republished as version 2 with three. */
  function republishedTrail() {
    return seedState(
      seedTrail({
        versionId: 'version-1',
        versionNumber: 1,
        pins: [
          { id: 'v1-pin-1', sequenceIndex: 1, eastMeters: 0 },
          { id: 'v1-pin-2', sequenceIndex: 2, eastMeters: 300 },
        ],
      }),
      seedTrail({
        versionId: 'version-2',
        versionNumber: 2,
        pins: [
          { id: 'v2-pin-1', sequenceIndex: 1, eastMeters: 0 },
          { id: 'v2-pin-2', sequenceIndex: 2, eastMeters: 400 },
          { id: 'v2-pin-3', sequenceIndex: 3, eastMeters: 800 },
        ],
      }),
    );
  }

  it('serves a replaced version so a mid-trail player can still render their pins', async () => {
    ctx = await buildTestApp(republishedTrail());

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/trail-1/versions/version-1',
      headers: ctx.authHeader(PLAYER),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      trailId: 'trail-1',
      trailVersionId: 'version-1',
      versionNumber: 1,
      isCurrentVersion: false,
    });
    expect(response.json().pins.map((p: { pinId: string }) => p.pinId)).toEqual([
      'v1-pin-1',
      'v1-pin-2',
    ]);
  });

  it('serves the current version too, flagged as current', async () => {
    ctx = await buildTestApp(republishedTrail());

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/trail-1/versions/version-2',
      headers: ctx.authHeader(PLAYER),
    });

    expect(response.json()).toMatchObject({ versionNumber: 2, isCurrentVersion: true });
    expect(response.json().pins).toHaveLength(3);
  });

  it('withholds code answers exactly like the current-version route', async () => {
    ctx = await buildTestApp(
      seedState(
        seedTrail({
          pins: [
            {
              id: 'pin-1',
              sequenceIndex: 1,
              eastMeters: 0,
              challengeType: 'code_entry',
              challengeConfig: { code: 'SWAN42', hint: 'Read the plaque' },
            },
          ],
        }),
      ),
    );

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/trail-1/versions/version-1',
      headers: ctx.authHeader(PLAYER),
    });

    expect(response.body).not.toContain('SWAN42');
    expect(response.json().pins[0].challenge).toEqual({ hint: 'Read the plaque' });
  });

  it('404s a version id that belongs to a different trail, rather than serving it', async () => {
    ctx = await buildTestApp(
      seedState(
        seedTrail({ pins: [{ id: 'pin-1', sequenceIndex: 1, eastMeters: 0 }] }),
        seedTrail({
          trailId: 'trail-2',
          versionId: 'other-version',
          pins: [{ id: 'other-pin', sequenceIndex: 1, eastMeters: 0 }],
        }),
      ),
    );

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/trail-1/versions/other-version',
      headers: ctx.authHeader(PLAYER),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'trail_version_not_found' });
  });

  it('404s an unknown version and an unknown trail', async () => {
    ctx = await buildTestApp(republishedTrail());

    const unknownVersion = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/trail-1/versions/nope',
      headers: ctx.authHeader(PLAYER),
    });
    const unknownTrail = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/nope/versions/version-1',
      headers: ctx.authHeader(PLAYER),
    });

    expect(unknownVersion.json()).toEqual({ error: 'trail_version_not_found' });
    expect(unknownTrail.json()).toEqual({ error: 'trail_not_found' });
  });

  it('401s an unauthenticated request (ST-2.5)', async () => {
    ctx = await buildTestApp(republishedTrail());

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/trails/trail-1/versions/version-1',
    });

    expect(response.statusCode).toBe(401);
  });
});
