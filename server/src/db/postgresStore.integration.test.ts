// ST-2.7 — the one test that runs the real SQL in postgresStore.ts against a real
// Postgres+PostGIS instance, on a schema built by the real migrations (ST-1.3). Everything
// else in this suite runs on memoryStore, which proves the rules but not the queries.
//
// Skipped unless TEST_DATABASE_URL (or DATABASE_URL) points at a database with PostGIS
// available. It never touches `public`: the migrations run into a throwaway schema that is
// dropped afterwards, so pointing this at a dev database is safe.
//
//   docker run -d --name arquest-pg-test -e POSTGRES_PASSWORD=arquest -e POSTGRES_USER=arquest \
//     -e POSTGRES_DB=ar_quest_trail -p 55432:5432 postgis/postgis:16-3.4-alpine
//   TEST_DATABASE_URL=postgres://arquest:arquest@localhost:55432/ar_quest_trail npm test

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { runner, type RunnerOption } from 'node-pg-migrate';
import { buildApp } from '../app.js';
import { retentionCutoff } from '../services/retention.js';
import { createPostgresStore } from './postgresStore.js';
import type { TrailStore } from './types.js';

const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describeIfDatabase = connectionString ? describe : describe.skip;

const DEVICE_KEY_A = randomBytes(24).toString('hex');
const DEVICE_KEY_B = randomBytes(24).toString('hex');

/** Fixture geometry: two pins on the equator, 300m apart. */
const METERS_PER_DEGREE_LNG_AT_EQUATOR = 111320;
const PIN_1 = { id: randomUUID(), lat: 0, lng: 0 };
const PIN_2 = { id: randomUUID(), lat: 0, lng: 300 / METERS_PER_DEGREE_LNG_AT_EQUATOR };

describeIfDatabase('postgresStore against real Postgres+PostGIS (ST-2.7)', () => {
  const schemaName = `qt_test_${randomBytes(4).toString('hex')}`;
  let fixtures: pg.Pool;
  let store: TrailStore;
  let app: FastifyInstance;
  const trailId = randomUUID();
  const versionId = randomUUID();

  const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));
  const migrationOptions = (direction: 'up' | 'down'): RunnerOption => ({
    databaseUrl: connectionString as string,
    dir: migrationsDir,
    direction,
    // Schema objects and node-pg-migrate's own bookkeeping table both land in the throwaway
    // schema, so dropping it afterwards leaves nothing behind. `public` stays on the search
    // path for PostGIS's types.
    schema: [schemaName, 'public'],
    migrationsSchema: schemaName,
    createSchema: true,
    createMigrationsSchema: true,
    migrationsTable: 'pgmigrations',
    log: () => {},
  });

  beforeAll(async () => {
    // PostGIS lives in `public`; the throwaway schema goes in front of it on the search path.
    fixtures = new pg.Pool({
      connectionString,
      options: `-c search_path=${schemaName},public`,
    });
    // Database-wide, and not something a throwaway schema should own or drop.
    await fixtures.query('CREATE EXTENSION IF NOT EXISTS postgis');

    await runner(migrationOptions('up'));

    await fixtures.query('INSERT INTO trails (id, name) VALUES ($1, $2)', [trailId, 'Integration Trail']);
    await fixtures.query(
      'INSERT INTO trail_versions (id, trail_id, version_number) VALUES ($1, $2, 1)',
      [versionId, trailId],
    );
    await fixtures.query('UPDATE trails SET current_version_id = $1 WHERE id = $2', [versionId, trailId]);
    for (const [index, pin] of [PIN_1, PIN_2].entries()) {
      await fixtures.query(
        `INSERT INTO pins (id, trail_version_id, sequence_index, lat, lng, radius_m, challenge_type, challenge_config)
         VALUES ($1, $2, $3, $4, $5, 10, 'proximity_dwell', $6)`,
        [pin.id, versionId, index + 1, pin.lat, pin.lng, JSON.stringify({ dwell_seconds: 15, code: 'SECRET' })],
      );
    }

    store = createPostgresStore(connectionString as string, {
      searchPath: `${schemaName},public`,
    });
    app = await buildApp({ store, jwtSecret: 'integration-test-secret', rateLimit: false });
  }, 60_000);

  afterAll(async () => {
    await app?.close(); // releases the store's pool via the onClose hook
    if (fixtures) {
      await fixtures.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await fixtures.end();
    }
  });

  async function tokenFor(deviceKey: string): Promise<{ userId: string; token: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/players/token',
      payload: { deviceKey },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  it('applies migrations idempotently, so a second run is a no-op (ST-1.3)', async () => {
    // beforeAll already migrated this schema; running again must change nothing.
    const applied = await runner(migrationOptions('up'));

    expect(applied).toEqual([]);
    // Compared against the files on disk rather than a hardcoded list, so adding a migration
    // doesn't require editing this test — only breaking the ordering does.
    const onDisk = (await readdir(migrationsDir))
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .map((file) => file.replace(/\.sql$/, ''));
    const { rows } = await fixtures.query('SELECT name FROM pgmigrations ORDER BY id');
    expect(rows.map((row) => row.name)).toEqual(onDisk);
  });

  it('populates the generated geography column from lat/lng', async () => {
    const { rows } = await fixtures.query(
      'SELECT ST_AsText(geom) AS wkt FROM pins WHERE id = $1',
      [PIN_2.id],
    );

    expect(rows[0].wkt).toMatch(/^POINT\(/);
  });

  it('walks a full trail end to end over HTTP: token → trail → attempt → both pins', async () => {
    const { userId, token } = await tokenFor(DEVICE_KEY_A);
    const auth = { authorization: `Bearer ${token}` };

    // The FK from trail_attempts.user_id to users.id is exactly what ST-2.6 unblocked.
    const users = await fixtures.query('SELECT id FROM users WHERE id = $1', [userId]);
    expect(users.rowCount).toBe(1);

    const trail = await app.inject({ method: 'GET', url: `/api/v1/trails/${trailId}`, headers: auth });
    expect(trail.statusCode).toBe(200);
    expect(trail.json().pins.map((p: { pinId: string }) => p.pinId)).toEqual([PIN_1.id, PIN_2.id]);
    // ST-2.1: the authored answer stays server-side even when it's really in the database.
    expect(trail.body).not.toContain('SECRET');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      headers: auth,
      payload: { trailId },
    });
    expect(created.statusCode).toBe(201);
    const attemptId = created.json().attemptId;
    expect(created.json().pins.map((p: { status: string }) => p.status)).toEqual(['unlocked', 'locked']);

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/pins/${PIN_1.id}/complete`,
      headers: auth,
      payload: { lat: PIN_1.lat, lng: PIN_1.lng, accuracyM: 5 },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ nextPinId: PIN_2.id, attemptStatus: 'active' });

    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attemptId}/pins/${PIN_2.id}/complete`,
      headers: auth,
      payload: { lat: PIN_2.lat, lng: PIN_2.lng, accuracyM: 5 },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ nextPinId: null, attemptStatus: 'completed' });

    // The transactional writes in completePin landed the way the rules expect.
    const progress = await fixtures.query(
      `SELECT pp.status FROM pin_progress pp JOIN pins p ON p.id = pp.pin_id
       WHERE pp.attempt_id = $1 ORDER BY p.sequence_index`,
      [attemptId],
    );
    expect(progress.rows.map((r) => r.status)).toEqual(['completed', 'completed']);
    const attempt = await fixtures.query('SELECT status, completed_at FROM trail_attempts WHERE id = $1', [
      attemptId,
    ]);
    expect(attempt.rows[0].status).toBe('completed');
    expect(attempt.rows[0].completed_at).not.toBeNull();

    // SR-SEC-02 input persisted at capture time (SR-NET-02).
    const history = await fixtures.query('SELECT COUNT(*)::int AS n FROM location_history WHERE user_id = $1', [
      userId,
    ]);
    expect(history.rows[0].n).toBe(2);
  });

  it('replays into a new attempt without touching the completed one (GDR-06)', async () => {
    const { token } = await tokenFor(DEVICE_KEY_A);
    const auth = { authorization: `Bearer ${token}` };

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      headers: auth,
      payload: { trailId },
    });

    expect(replay.statusCode).toBe(201);
    expect(replay.json().pins.map((p: { status: string }) => p.status)).toEqual(['unlocked', 'locked']);
    const attempts = await fixtures.query('SELECT status FROM trail_attempts ORDER BY started_at');
    expect(attempts.rows.map((r) => r.status)).toEqual(['completed', 'active']);
  });

  it("refuses to touch another player's attempt (SR-DATA-01/02)", async () => {
    const { token: tokenB } = await tokenFor(DEVICE_KEY_B);
    const { rows } = await fixtures.query(
      "SELECT id FROM trail_attempts WHERE status = 'active' ORDER BY started_at DESC LIMIT 1",
    );
    const playerAAttemptId = rows[0].id;

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${playerAAttemptId}/pins/${PIN_1.id}/complete`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { lat: PIN_1.lat, lng: PIN_1.lng, accuracyM: 5 },
    });

    expect(response.statusCode).toBe(404);
    const untouched = await fixtures.query(
      'SELECT status FROM pin_progress WHERE attempt_id = $1 AND pin_id = $2',
      [playerAAttemptId, PIN_1.id],
    );
    expect(untouched.rows[0].status).toBe('unlocked');
  });

  it('deletes a player and everything of theirs, keeping the Admin queue item (SR-PRIV-02)', async () => {
    const deviceKey = randomBytes(24).toString('hex');
    const { userId, token } = await tokenFor(deviceKey);
    const auth = { authorization: `Bearer ${token}` };

    const attempt = await app.inject({
      method: 'POST',
      url: '/api/v1/attempts',
      headers: auth,
      payload: { trailId },
    });
    await app.inject({
      method: 'POST',
      url: `/api/v1/attempts/${attempt.json().attemptId}/pins/${PIN_1.id}/complete`,
      headers: auth,
      payload: { lat: PIN_1.lat, lng: PIN_1.lng, accuracyM: 5 },
    });
    const report = await app.inject({
      method: 'POST',
      url: `/api/v1/pins/${PIN_2.id}/report`,
      headers: auth,
      payload: { note: 'Bollard removed' },
    });
    const reportId = report.json().reportId;

    const deletion = await app.inject({ method: 'DELETE', url: '/api/v1/players/me', headers: auth });

    expect(deletion.statusCode).toBe(200);
    expect(deletion.json().deleted).toMatchObject({ attempts: 1, player: true });
    for (const [table, column] of [
      ['users', 'id'],
      ['trail_attempts', 'user_id'],
      ['location_history', 'user_id'],
    ] as const) {
      const { rows } = await fixtures.query(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} = $1`,
        [userId],
      );
      expect({ table, n: rows[0].n }).toEqual({ table, n: 0 });
    }
    // pin_progress went with the attempt via ON DELETE CASCADE.
    const orphanProgress = await fixtures.query(
      `SELECT COUNT(*)::int AS n FROM pin_progress pp
       LEFT JOIN trail_attempts ta ON ta.id = pp.attempt_id WHERE ta.id IS NULL`,
    );
    expect(orphanProgress.rows[0].n).toBe(0);
    // The report survives with no reporter — ON DELETE SET NULL.
    const kept = await fixtures.query('SELECT reported_by_user_id, note FROM pin_reports WHERE id = $1', [
      reportId,
    ]);
    expect(kept.rows[0]).toEqual({ reported_by_user_id: null, note: 'Bollard removed' });
  });

  it('purges only location history past the retention window (SR-PRIV-01)', async () => {
    const { rows } = await fixtures.query('INSERT INTO users DEFAULT VALUES RETURNING id');
    const userId = rows[0].id;
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await fixtures.query(
      `INSERT INTO location_history (user_id, lat, lng, recorded_at)
       VALUES ($1, 0, 0, $2), ($1, 0, 0, $3), ($1, 0, 0, $4)`,
      [userId, daysAgo(120), daysAgo(91), daysAgo(1)],
    );

    const deleted = await store.purgeLocationHistoryBefore(retentionCutoff(new Date()));

    expect(deleted).toBe(2);
    const remaining = await fixtures.query(
      'SELECT COUNT(*)::int AS n FROM location_history WHERE user_id = $1',
      [userId],
    );
    expect(remaining.rows[0].n).toBe(1);
  });

  it('queues a pin report for the Admin dashboard (GDR-09)', async () => {
    const { userId, token } = await tokenFor(DEVICE_KEY_B);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/pins/${PIN_1.id}/report`,
      headers: { authorization: `Bearer ${token}` },
      payload: { note: 'Scaffolding over the whole facade' },
    });

    expect(response.statusCode).toBe(201);
    const { rows } = await fixtures.query(
      'SELECT status, note FROM pin_reports WHERE pin_id = $1 AND reported_by_user_id = $2',
      [PIN_1.id, userId],
    );
    expect(rows[0]).toMatchObject({ status: 'open', note: 'Scaffolding over the whole facade' });
  });

  it('authors, publishes, and re-publishes a trail through the admin API (ST-7.2)', async () => {
    const { userId, token } = await tokenFor(randomBytes(24).toString('hex'));
    await store.setUserRole(userId, 'admin');
    const auth = { authorization: `Bearer ${token}` };
    const pin = (sequenceIndex: number, eastMeters: number) => ({
      sequenceIndex,
      lat: 0,
      lng: eastMeters / METERS_PER_DEGREE_LNG_AT_EQUATOR,
      radiusM: 10,
      challengeType: 'proximity_dwell',
      challengeConfig: { dwell_seconds: 15 },
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/trails',
      headers: auth,
      payload: { name: 'Authored Trail', expiryDays: 14 },
    });
    expect(created.statusCode).toBe(201);
    const authoredTrailId = created.json().trailId;

    const v1 = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/trails/${authoredTrailId}/versions`,
      headers: auth,
      payload: { pins: [pin(1, 0), pin(2, 300)] },
    });
    expect(v1.statusCode).toBe(201);
    expect(v1.json()).toMatchObject({ versionNumber: 1, warnings: [] });

    const v2 = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/trails/${authoredTrailId}/versions`,
      headers: auth,
      payload: { pins: [pin(1, 0), pin(2, 300), pin(3, 600)] },
    });
    expect(v2.json().versionNumber).toBe(2);

    // The trail points at v2; v1's pins survive untouched for anyone mid-attempt (GDR-07).
    const trailRow = await fixtures.query('SELECT current_version_id, created_by FROM trails WHERE id = $1', [
      authoredTrailId,
    ]);
    expect(trailRow.rows[0]).toEqual({
      current_version_id: v2.json().trailVersionId,
      created_by: userId,
    });
    const pinCounts = await fixtures.query(
      'SELECT trail_version_id, COUNT(*)::int AS n FROM pins GROUP BY trail_version_id',
    );
    const byVersion = Object.fromEntries(pinCounts.rows.map((r) => [r.trail_version_id, r.n]));
    expect(byVersion[v1.json().trailVersionId]).toBe(2);
    expect(byVersion[v2.json().trailVersionId]).toBe(3);

    // And a player can play what was just authored.
    const asPlayer = await app.inject({
      method: 'GET',
      url: `/api/v1/trails/${authoredTrailId}`,
      headers: auth,
    });
    expect(asPlayer.json().pins).toHaveLength(3);
  });

  it('lists and triages the pin report queue as an Admin (ST-7.3)', async () => {
    const { userId, token } = await tokenFor(randomBytes(24).toString('hex'));
    await store.setUserRole(userId, 'admin');
    const auth = { authorization: `Bearer ${token}` };

    const open = await app.inject({ method: 'GET', url: '/api/v1/admin/pin-reports?status=open', headers: auth });
    expect(open.statusCode).toBe(200);
    const reports = open.json().reports;
    expect(reports.length).toBeGreaterThanOrEqual(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/pin-reports/${reports[0].reportId}`,
      headers: auth,
      payload: { status: 'resolved' },
    });

    expect(patched.json()).toMatchObject({ status: 'resolved' });
    const { rows } = await fixtures.query('SELECT status FROM pin_reports WHERE id = $1', [
      reports[0].reportId,
    ]);
    expect(rows[0].status).toBe('resolved');
  });

  it('refuses authoring to a player (requirements §2)', async () => {
    const { token } = await tokenFor(randomBytes(24).toString('hex'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/trails',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Player-authored trail' },
    });

    expect(response.statusCode).toBe(403);
    const { rows } = await fixtures.query('SELECT COUNT(*)::int AS n FROM trails WHERE name = $1', [
      'Player-authored trail',
    ]);
    expect(rows[0].n).toBe(0);
  });

  // ST-8.3 — the aggregation runs in SQL, so these are the tests that actually prove it. The
  // fixture below has known outcomes and exact timestamps so every number is checkable by hand.
  describe('analytics aggregation (SR-PRIV-03)', () => {
    const analyticsTrailId = randomUUID();
    const analyticsVersionId = randomUUID();
    const analyticsPinIds = [randomUUID(), randomUUID(), randomUUID()];
    const BASE = new Date('2026-05-01T00:00:00Z');
    const hoursIn = (n: number) => new Date(BASE.getTime() + n * 3_600_000);
    let adminAuth: { authorization: string };
    let playerAuth: { authorization: string };

    async function seedAttempt(spec: {
      startedAt: Date;
      status: 'completed' | 'expired' | 'active';
      completedSeconds?: number;
      progress: Array<'locked' | 'unlocked' | 'completed'>;
    }) {
      const user = await fixtures.query('INSERT INTO users DEFAULT VALUES RETURNING id');
      const completedAt =
        spec.completedSeconds === undefined
          ? null
          : new Date(spec.startedAt.getTime() + spec.completedSeconds * 1000);
      const attempt = await fixtures.query(
        `INSERT INTO trail_attempts (user_id, trail_id, trail_version_id, status, started_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [user.rows[0].id, analyticsTrailId, analyticsVersionId, spec.status, spec.startedAt, completedAt],
      );
      for (const [index, status] of spec.progress.entries()) {
        await fixtures.query(
          'INSERT INTO pin_progress (attempt_id, pin_id, status, completed_at) VALUES ($1, $2, $3, $4)',
          [
            attempt.rows[0].id,
            analyticsPinIds[index],
            status,
            status === 'completed' ? completedAt ?? spec.startedAt : null,
          ],
        );
      }
    }

    beforeAll(async () => {
      await fixtures.query('INSERT INTO trails (id, name) VALUES ($1, $2)', [
        analyticsTrailId,
        'Analytics Trail',
      ]);
      await fixtures.query(
        'INSERT INTO trail_versions (id, trail_id, version_number) VALUES ($1, $2, 1)',
        [analyticsVersionId, analyticsTrailId],
      );
      await fixtures.query('UPDATE trails SET current_version_id = $1 WHERE id = $2', [
        analyticsVersionId,
        analyticsTrailId,
      ]);
      for (const [index, pinId] of analyticsPinIds.entries()) {
        await fixtures.query(
          `INSERT INTO pins (id, trail_version_id, sequence_index, lat, lng, radius_m, challenge_type)
           VALUES ($1, $2, $3, 0, $4, 10, 'proximity_dwell')`,
          [pinId, analyticsVersionId, index + 1, (index * 300) / METERS_PER_DEGREE_LNG_AT_EQUATOR],
        );
      }

      // Three finishers (600s, 1200s, 3000s), one expiry, two still walking.
      await seedAttempt({
        startedAt: hoursIn(0),
        status: 'completed',
        completedSeconds: 600,
        progress: ['completed', 'completed', 'completed'],
      });
      await seedAttempt({
        startedAt: hoursIn(1),
        status: 'completed',
        completedSeconds: 1200,
        progress: ['completed', 'completed', 'completed'],
      });
      await seedAttempt({
        startedAt: hoursIn(2),
        status: 'completed',
        completedSeconds: 3000,
        progress: ['completed', 'completed', 'completed'],
      });
      await seedAttempt({
        startedAt: hoursIn(3),
        status: 'expired',
        progress: ['completed', 'unlocked', 'locked'],
      });
      await seedAttempt({
        startedAt: hoursIn(4),
        status: 'active',
        progress: ['completed', 'unlocked', 'locked'],
      });
      await seedAttempt({
        startedAt: hoursIn(5),
        status: 'active',
        progress: ['unlocked', 'locked', 'locked'],
      });

      const admin = await tokenFor(randomBytes(24).toString('hex'));
      await store.setUserRole(admin.userId, 'admin');
      adminAuth = { authorization: `Bearer ${admin.token}` };
      const player = await tokenFor(randomBytes(24).toString('hex'));
      playerAuth = { authorization: `Bearer ${player.token}` };
    }, 30_000);

    it('counts outcomes and computes percentiles in SQL', async () => {
      const [aggregate] = await store.getTrailAttemptAggregates({
        trailId: analyticsTrailId,
        limit: 1,
      });

      expect(aggregate).toMatchObject({
        trailName: 'Analytics Trail',
        attemptsStarted: 6,
        attemptsCompleted: 3,
        attemptsExpired: 1,
        attemptsActive: 2,
      });
      // Median of 600/1200/3000 is the middle value; p90 interpolates 80% of the way from
      // 1200 to 3000 — percentile_cont, matching the in-memory helper.
      expect(aggregate.medianCompletionSeconds).toBe(1200);
      expect(aggregate.p90CompletionSeconds).toBe(2640);
    });

    it('builds the drop-off funnel from real progress rows', async () => {
      const funnel = await store.getPinFunnel(analyticsTrailId, {});

      expect(funnel).toEqual([
        { sequenceIndex: 1, reached: 6, completed: 5 },
        { sequenceIndex: 2, reached: 5, completed: 3 },
        { sequenceIndex: 3, reached: 3, completed: 3 },
      ]);
    });

    it('serves the whole picture over the API, with rates derived from those counts', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/analytics/trails/${analyticsTrailId}`,
        headers: adminAuth,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        attemptsStarted: 6,
        completionRate: 0.5,
        medianCompletionSeconds: 1200,
        p90CompletionSeconds: 2640,
        suppressed: false,
      });
      expect(response.json().funnel).toEqual([
        { sequenceIndex: 1, reached: 6, completed: 5, dropOffRate: 0.1667 },
        { sequenceIndex: 2, reached: 5, completed: 3, dropOffRate: 0.4 },
        { sequenceIndex: 3, reached: 3, completed: 3, dropOffRate: 0 },
      ]);
    });

    it('treats `from` as inclusive and `to` as exclusive, so ranges tile without double-counting', async () => {
      // [00:00, 03:00) — the 03:00 expiry starts exactly on the upper bound and must fall out,
      // while the 00:00 attempt sits exactly on the lower bound and must count.
      const response = await app.inject({
        method: 'GET',
        url:
          `/api/v1/admin/analytics/trails/${analyticsTrailId}` +
          `?from=${hoursIn(0).toISOString()}&to=${hoursIn(3).toISOString()}`,
        headers: adminAuth,
      });

      expect(response.json()).toMatchObject({
        attemptsStarted: 3,
        attemptsCompleted: 3,
        attemptsExpired: 0,
      });
      // The other half of the split contains the remaining three.
      const rest = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/analytics/trails/${analyticsTrailId}?from=${hoursIn(3).toISOString()}`,
        headers: adminAuth,
      });
      expect(rest.json().attemptsStarted).toBe(3);
    });

    it('suppresses rates for a small cohort while still reporting counts (SR-PRIV-03)', async () => {
      // A one-hour window catches a single attempt — a 100% completion rate there would be one
      // identifiable player's outcome.
      const response = await app.inject({
        method: 'GET',
        url:
          `/api/v1/admin/analytics/trails/${analyticsTrailId}` +
          `?from=${hoursIn(0).toISOString()}&to=${hoursIn(1).toISOString()}`,
        headers: adminAuth,
      });

      expect(response.json()).toMatchObject({
        attemptsStarted: 1,
        attemptsCompleted: 1,
        completionRate: null,
        medianCompletionSeconds: null,
        suppressed: true,
      });
    });

    it('reports zeros for a quiet window instead of 404ing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/analytics/trails/${analyticsTrailId}?from=2030-01-01T00:00:00Z`,
        headers: adminAuth,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ attemptsStarted: 0, completionRate: null, funnel: [] });
    });

    it('includes the trail in the cross-trail listing, ordered by attempts', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/analytics/trails?limit=50',
        headers: adminAuth,
      });

      const trails = response.json().trails;
      const mine = trails.find((t: { trailId: string }) => t.trailId === analyticsTrailId);
      expect(mine).toMatchObject({ attemptsStarted: 6, completionRate: 0.5 });
      const counts = trails.map((t: { attemptsStarted: number }) => t.attemptsStarted);
      expect(counts).toEqual([...counts].sort((a: number, b: number) => b - a));
    });

    it('survives the SR-PRIV-01 purge unchanged — analytics never reads coordinates', async () => {
      const before = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/analytics/trails/${analyticsTrailId}`,
        headers: adminAuth,
      });
      const stored = await fixtures.query('SELECT COUNT(*)::int AS n FROM location_history');
      expect(stored.rows[0].n).toBeGreaterThan(0);

      // Purge everything, not just the 90-day window.
      await store.purgeLocationHistoryBefore(new Date(Date.now() + 86_400_000));

      const after = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/analytics/trails/${analyticsTrailId}`,
        headers: adminAuth,
      });
      const emptied = await fixtures.query('SELECT COUNT(*)::int AS n FROM location_history');
      expect(emptied.rows[0].n).toBe(0);
      expect(after.json()).toEqual(before.json());
    });

    it('refuses analytics to players and to unauthenticated callers', async () => {
      const urls = [
        '/api/v1/admin/analytics/trails',
        `/api/v1/admin/analytics/trails/${analyticsTrailId}`,
      ];

      for (const url of urls) {
        const asPlayer = await app.inject({ method: 'GET', url, headers: playerAuth });
        const anonymous = await app.inject({ method: 'GET', url });
        expect({ url, player: asPlayer.statusCode, anonymous: anonymous.statusCode }).toEqual({
          url,
          player: 403,
          anonymous: 401,
        });
      }
    });
  });
});
