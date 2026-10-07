import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  buildTestApp,
  lngAtMeters,
  seedState,
  seedTrail,
  type TestApp,
} from '../testSupport/harness.js';
import type { LandcoverChecker, LandcoverResult } from '../services/landcover.js';

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

/** A landcover checker that answers from a script and records what it was asked. */
function fakeLandcover(result: LandcoverResult = { findings: [] }) {
  const check = vi.fn((_pins: Parameters<LandcoverChecker['check']>[0]) => Promise.resolve(result));
  return { checker: { check } as LandcoverChecker, check };
}

async function asAdmin(
  app: TestApp,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
) {
  return app.app.inject({
    method,
    url,
    headers: app.adminHeader(ADMIN),
    ...(payload ? { payload } : {}),
  });
}

async function createAndPublish(app: TestApp, name: string, pins: unknown[]) {
  const created = (await asAdmin(app, 'POST', '/api/v1/admin/trails', { name })).json();
  if (pins.length > 0) {
    await asAdmin(app, 'POST', `/api/v1/admin/trails/${created.trailId}/versions`, { pins });
  }
  return created as { trailId: string; joinCode: string };
}

describe('trail management for the Admin tool', () => {
  it('gives every new trail a join code', async () => {
    ctx = await buildTestApp();

    const created = await asAdmin(ctx, 'POST', '/api/v1/admin/trails', { name: 'Harbour Trail' });

    expect(created.statusCode).toBe(201);
    expect(created.json().joinCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(ctx.store.state.trails[0].joinCode).toBe(created.json().joinCode.replace('-', ''));
  });

  it('lists trails with what each row needs at a glance', async () => {
    ctx = await buildTestApp();
    const published = await createAndPublish(ctx, 'Published', [draftPin(1, 0), draftPin(2, 300)]);
    await createAndPublish(ctx, 'Draft', []);
    await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/pins/${ctx.store.state.pins[0].id}/report`,
      headers: ctx.authHeader(PLAYER),
      payload: { note: 'Gate locked' },
    });

    const response = await asAdmin(ctx, 'GET', '/api/v1/admin/trails');

    expect(response.statusCode).toBe(200);
    const rows = response.json().trails as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.name).sort()).toEqual(['Draft', 'Published']);
    expect(rows.find((row) => row.name === 'Published')).toMatchObject({
      trailId: published.trailId,
      joinCode: published.joinCode,
      versionNumber: 1,
      pinCount: 2,
      openReports: 1,
    });
    expect(rows.find((row) => row.name === 'Draft')).toMatchObject({
      versionNumber: null,
      pinCount: 0,
      openReports: 0,
    });
  });

  it('opens one trail for editing — with the answers players never see', async () => {
    ctx = await buildTestApp();
    const trail = await createAndPublish(ctx, 'Code Trail', [
      draftPin(1, 0, {
        challengeType: 'code_entry',
        challengeConfig: { code: 'SWAN42', hint: 'Plaque' },
      }),
    ]);
    await asAdmin(ctx, 'POST', `/api/v1/admin/trails/${trail.trailId}/versions`, {
      pins: [
        draftPin(1, 0, { challengeType: 'code_entry', challengeConfig: { code: 'SWAN43' } }),
        draftPin(2, 300),
      ],
    });

    const response = await asAdmin(ctx, 'GET', `/api/v1/admin/trails/${trail.trailId}`);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pins).toHaveLength(2);
    expect(body.pins[0].challengeConfig).toEqual({ code: 'SWAN43' });
    expect(
      body.versions.map((v: { versionNumber: number; isCurrent: boolean }) => [
        v.versionNumber,
        v.isCurrent,
      ]),
    ).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it('404s a trail that does not exist', async () => {
    ctx = await buildTestApp();

    expect((await asAdmin(ctx, 'GET', '/api/v1/admin/trails/nope')).statusCode).toBe(404);
    expect(
      (await asAdmin(ctx, 'PATCH', '/api/v1/admin/trails/nope', { name: 'x' })).statusCode,
    ).toBe(404);
    expect((await asAdmin(ctx, 'POST', '/api/v1/admin/trails/nope/join-code')).statusCode).toBe(
      404,
    );
  });

  it('renames a trail and sets or clears its GDR-08 window', async () => {
    ctx = await buildTestApp();
    const trail = await createAndPublish(ctx, 'Old name', [draftPin(1, 0)]);

    const renamed = await asAdmin(ctx, 'PATCH', `/api/v1/admin/trails/${trail.trailId}`, {
      name: 'New name',
      expiryDays: 7,
    });
    expect(renamed.json()).toMatchObject({ name: 'New name', expiryDays: 7 });

    // Only what's sent changes: clearing the window leaves the name alone.
    const cleared = await asAdmin(ctx, 'PATCH', `/api/v1/admin/trails/${trail.trailId}`, {
      expiryDays: null,
    });
    expect(cleared.json()).toMatchObject({ name: 'New name', expiryDays: null });
  });

  it('refuses an empty or unknown change', async () => {
    ctx = await buildTestApp();
    const trail = await createAndPublish(ctx, 'Trail', [draftPin(1, 0)]);

    expect(
      (await asAdmin(ctx, 'PATCH', `/api/v1/admin/trails/${trail.trailId}`, {})).statusCode,
    ).toBe(400);
    expect(
      (
        await asAdmin(ctx, 'PATCH', `/api/v1/admin/trails/${trail.trailId}`, {
          currentVersionId: 'x',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('rotating the join code revokes the old one at once', async () => {
    ctx = await buildTestApp();
    const trail = await createAndPublish(ctx, 'Trail', [draftPin(1, 0)]);
    const resolve = (code: string) =>
      ctx!.app.inject({
        method: 'GET',
        url: `/api/v1/join/${code}`,
        headers: ctx!.authHeader(PLAYER),
      });
    expect((await resolve(trail.joinCode)).statusCode).toBe(200);

    const rotated = await asAdmin(ctx, 'POST', `/api/v1/admin/trails/${trail.trailId}/join-code`);

    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().joinCode).not.toBe(trail.joinCode);
    expect((await resolve(trail.joinCode)).statusCode).toBe(404);
    expect((await resolve(rotated.json().joinCode)).statusCode).toBe(200);
  });
});

describe('POST /api/v1/admin/trails/validate (dry-run publishing)', () => {
  it('reports errors and warnings without writing anything', async () => {
    ctx = await buildTestApp();

    const response = await asAdmin(ctx, 'POST', '/api/v1/admin/trails/validate', {
      pins: [draftPin(1, 0), draftPin(2, 12)],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      errors: [],
      warnings: [expect.objectContaining({ code: 'pins_too_close', sequenceIndex: 2 })],
    });
    expect(ctx.store.state.trails).toHaveLength(0);
    expect(ctx.store.state.pins).toHaveLength(0);
  });

  it('accepts an empty draft and says what is missing', async () => {
    ctx = await buildTestApp();

    const response = await asAdmin(ctx, 'POST', '/api/v1/admin/trails/validate', { pins: [] });

    expect(response.json().errors).toEqual([expect.objectContaining({ code: 'no_pins' })]);
  });

  it('includes SR-ADMIN-01 water and building warnings', async () => {
    const landcover = fakeLandcover({
      findings: [
        { sequenceIndex: 2, kind: 'water', name: 'Chetpet Lake' },
        { sequenceIndex: 3, kind: 'building' },
      ],
    });
    ctx = await buildTestApp({}, { landcover: landcover.checker });

    const response = await asAdmin(ctx, 'POST', '/api/v1/admin/trails/validate', {
      pins: [draftPin(1, 0), draftPin(2, 300), draftPin(3, 600)],
    });

    expect(response.json().warnings.map((w: { code: string }) => w.code)).toEqual([
      'pin_in_water',
      'pin_inside_building',
    ]);
    expect(landcover.check).toHaveBeenCalledWith([
      { sequenceIndex: 1, lat: 0, lng: lngAtMeters(0) },
      { sequenceIndex: 2, lat: 0, lng: lngAtMeters(300) },
      { sequenceIndex: 3, lat: 0, lng: lngAtMeters(600) },
    ]);
  });

  it("doesn't spend a map lookup on a draft that can't publish", async () => {
    const landcover = fakeLandcover();
    ctx = await buildTestApp({}, { landcover: landcover.checker });

    await asAdmin(ctx, 'POST', '/api/v1/admin/trails/validate', {
      pins: [draftPin(1, 0), draftPin(3, 600)],
    });

    expect(landcover.check).not.toHaveBeenCalled();
  });
});

describe('publishing with SR-ADMIN-01 landcover checks', () => {
  it('publishes anyway and returns the warnings — they are advisory', async () => {
    const landcover = fakeLandcover({ findings: [{ sequenceIndex: 1, kind: 'water' }] });
    ctx = await buildTestApp({}, { landcover: landcover.checker });
    const created = (
      await asAdmin(ctx, 'POST', '/api/v1/admin/trails', { name: 'Lake Trail' })
    ).json();

    const response = await asAdmin(
      ctx,
      'POST',
      `/api/v1/admin/trails/${created.trailId}/versions`,
      {
        pins: [draftPin(1, 0)],
      },
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().warnings).toEqual([
      expect.objectContaining({ code: 'pin_in_water', sequenceIndex: 1 }),
    ]);
    expect(ctx.store.state.versions).toHaveLength(1);
  });

  it('still publishes when the lookup is unavailable, and says the check did not run', async () => {
    const landcover = fakeLandcover({ findings: [], unavailableReason: 'Overpass timed out' });
    ctx = await buildTestApp({}, { landcover: landcover.checker });
    const created = (await asAdmin(ctx, 'POST', '/api/v1/admin/trails', { name: 'Trail' })).json();

    const response = await asAdmin(
      ctx,
      'POST',
      `/api/v1/admin/trails/${created.trailId}/versions`,
      {
        pins: [draftPin(1, 0)],
      },
    );

    expect(response.statusCode).toBe(201);
    expect(response.json().warnings).toEqual([
      expect.objectContaining({ code: 'landcover_check_unavailable' }),
    ]);
  });
});

describe('the report queue shows where each report is', () => {
  it('locates a report on its trail and flags reports against a replaced version', async () => {
    ctx = await buildTestApp(
      seedState(
        seedTrail({
          name: 'Harbour Trail',
          pins: [
            { id: 'pin-1', sequenceIndex: 1, eastMeters: 0 },
            { id: 'pin-2', sequenceIndex: 2, eastMeters: 300 },
          ],
        }),
      ),
    );
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/pins/pin-2/report',
      headers: ctx.authHeader(PLAYER),
      payload: { note: 'Scaffolding' },
    });

    const before = (await asAdmin(ctx, 'GET', '/api/v1/admin/pin-reports')).json().reports[0];
    expect(before).toMatchObject({
      pinId: 'pin-2',
      trailId: 'trail-1',
      trailName: 'Harbour Trail',
      sequenceIndex: 2,
      lat: 0,
      lng: lngAtMeters(300),
      versionNumber: 1,
      isCurrentVersion: true,
    });

    // The Admin republishes (perhaps moving the pin) — the old report now concerns version 1.
    await asAdmin(ctx, 'POST', '/api/v1/admin/trails/trail-1/versions', {
      pins: [draftPin(1, 0), draftPin(2, 350)],
    });
    const after = (await asAdmin(ctx, 'GET', '/api/v1/admin/pin-reports')).json().reports[0];
    expect(after.isCurrentVersion).toBe(false);
  });
});
