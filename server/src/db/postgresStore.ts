// Postgres + PostGIS implementation of TrailStore (schema: server/migrations/).
//
// Note on spatial queries: the completion radius check is deliberately *not* an ST_DWithin
// query. SR-GEO-04 makes the effective radius depend on the device's reported accuracy at
// completion time, so the comparison lives in application code (services/completion.ts)
// where it is unit-testable. The GIST index on pins.geom stays useful for the Admin
// authoring tool's proximity warnings (SR-ADMIN-01).

import pg from 'pg';
import type {
  AttemptPinState,
  AttemptRecord,
  CompletePinResult,
  LocationHistoryEntry,
  PinRecord,
  PinReportRecord,
  TrailRecord,
  TrailStore,
  TrailVersionRecord,
  UserRecord,
} from './types.js';
import type { LocationSample } from '../services/locationSanityCheck.js';
import { generateJoinCode } from '../services/joinCode.js';

const { Pool } = pg;

// `pg` hands back untyped rows; the mappers below are the single place where that shapelessness
// is converted into the typed records the rest of the code works with.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function toTrail(row: Row): TrailRecord {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.created_by ?? null,
    expiryDays: row.expiry_days,
    currentVersionId: row.current_version_id,
    joinCode: row.join_code,
    createdAt: row.created_at,
  };
}

const MAX_JOIN_CODE_ATTEMPTS = 5;

function isJoinCodeCollision(err: unknown): boolean {
  const pgError = err as { code?: string; constraint?: string } | null;
  return pgError?.code === '23505' && (pgError.constraint ?? '').includes('join_code');
}

/**
 * Runs a write with a freshly generated join code, retrying on the (roughly 1-in-10^11) chance
 * it collides with an existing one. The unique constraint, not this loop, is what guarantees
 * one code never opens two trails.
 */
async function withFreshJoinCode<T>(write: (code: string) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write(generateJoinCode());
    } catch (err) {
      if (!isJoinCodeCollision(err) || attempt >= MAX_JOIN_CODE_ATTEMPTS) {
        throw err;
      }
    }
  }
}

function toTrailVersion(row: Row): TrailVersionRecord {
  return {
    id: row.id,
    trailId: row.trail_id,
    versionNumber: row.version_number,
    publishedAt: row.published_at,
  };
}

function toPin(row: Row): PinRecord {
  return {
    id: row.id,
    trailVersionId: row.trail_version_id,
    sequenceIndex: row.sequence_index,
    lat: Number(row.lat),
    lng: Number(row.lng),
    alt: row.alt === null || row.alt === undefined ? null : Number(row.alt),
    radiusM: Number(row.radius_m),
    challengeType: row.challenge_type,
    challengeConfig: row.challenge_config ?? {},
  };
}

function toUser(row: Row): UserRecord {
  return {
    id: row.id,
    deviceKeyHash: row.device_key_hash,
    role: row.role,
    createdAt: row.created_at,
  };
}

function toPinReport(row: Row): PinReportRecord {
  return {
    id: row.id,
    pinId: row.pin_id,
    reportedByUserId: row.reported_by_user_id,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
  };
}

function toAttempt(row: Row): AttemptRecord {
  return {
    id: row.id,
    userId: row.user_id,
    trailId: row.trail_id,
    trailVersionId: row.trail_version_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export interface PostgresStoreOptions {
  /** Postgres `search_path` for this pool's connections. Used by the integration test to run
   *  the whole schema inside a throwaway schema instead of the developer's `public`. */
  searchPath?: string;
}

export function createPostgresStore(
  connectionString: string,
  options: PostgresStoreOptions = {},
): TrailStore {
  const pool = new Pool({
    connectionString,
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  });

  return {
    // ON CONFLICT ... DO UPDATE rather than DO NOTHING: the pointless self-assignment is what
    // makes RETURNING yield the existing row, so a repeat exchange of the same device key is
    // one round trip and can't race two rows into existence.
    async findOrCreateUserByDeviceKeyHash(deviceKeyHash) {
      const { rows } = await pool.query(
        `INSERT INTO users (device_key_hash) VALUES ($1)
         ON CONFLICT (device_key_hash) DO UPDATE SET device_key_hash = EXCLUDED.device_key_hash
         RETURNING id, device_key_hash, role, created_at`,
        [deviceKeyHash],
      );
      return toUser(rows[0]);
    },

    async getUser(userId) {
      const { rows } = await pool.query(
        'SELECT id, device_key_hash, role, created_at FROM users WHERE id = $1',
        [userId],
      );
      return rows[0] ? toUser(rows[0]) : null;
    },

    // SR-PRIV-02. The FK cascades would handle progress and history on their own, but deleting
    // each table explicitly is what makes the guarantee auditable — and gives the player a
    // count of what actually went.
    async deleteUserData(userId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const history = await client.query('DELETE FROM location_history WHERE user_id = $1', [
          userId,
        ]);
        const attempts = await client.query('DELETE FROM trail_attempts WHERE user_id = $1', [
          userId,
        ]);
        const user = await client.query('DELETE FROM users WHERE id = $1', [userId]);
        await client.query('COMMIT');
        return {
          locationSamples: history.rowCount ?? 0,
          attempts: attempts.rowCount ?? 0,
          userDeleted: (user.rowCount ?? 0) > 0,
        };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async purgeLocationHistoryBefore(cutoff) {
      const { rowCount } = await pool.query('DELETE FROM location_history WHERE recorded_at < $1', [
        cutoff,
      ]);
      return rowCount ?? 0;
    },

    async getTrail(trailId) {
      const { rows } = await pool.query('SELECT * FROM trails WHERE id = $1', [trailId]);
      return rows[0] ? toTrail(rows[0]) : null;
    },

    async getTrailVersion(trailVersionId) {
      const { rows } = await pool.query('SELECT * FROM trail_versions WHERE id = $1', [
        trailVersionId,
      ]);
      return rows[0] ? toTrailVersion(rows[0]) : null;
    },

    async getPinsForVersion(trailVersionId) {
      const { rows } = await pool.query(
        'SELECT * FROM pins WHERE trail_version_id = $1 ORDER BY sequence_index ASC',
        [trailVersionId],
      );
      return rows.map(toPin);
    },

    async getPin(pinId) {
      const { rows } = await pool.query('SELECT * FROM pins WHERE id = $1', [pinId]);
      return rows[0] ? toPin(rows[0]) : null;
    },

    // GDR-06/GDR-07: new attempt row snapshotting trailVersionId, plus one pin_progress row
    // per pin in that version. The lowest sequence_index starts `unlocked`; everything after
    // it starts `locked` (GDR-01). MIN() rather than a hardcoded 0/1 so the rule holds
    // whichever base the authoring tool uses.
    async createAttempt({ userId, trailId, trailVersionId }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO trail_attempts (user_id, trail_id, trail_version_id)
           VALUES ($1, $2, $3) RETURNING *`,
          [userId, trailId, trailVersionId],
        );
        const attempt = toAttempt(rows[0]);

        await client.query(
          `INSERT INTO pin_progress (attempt_id, pin_id, status)
           SELECT $1, p.id,
                  CASE WHEN p.sequence_index = (
                         SELECT MIN(sequence_index) FROM pins WHERE trail_version_id = $2
                       ) THEN 'unlocked' ELSE 'locked' END
           FROM pins p
           WHERE p.trail_version_id = $2`,
          [attempt.id, trailVersionId],
        );

        await client.query('COMMIT');
        return attempt;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async getAttempt(attemptId) {
      const { rows } = await pool.query('SELECT * FROM trail_attempts WHERE id = $1', [attemptId]);
      return rows[0] ? toAttempt(rows[0]) : null;
    },

    async getAttemptPinStates(attemptId): Promise<AttemptPinState[]> {
      const { rows } = await pool.query(
        `SELECT pp.pin_id, pp.status, p.sequence_index
         FROM pin_progress pp
         JOIN pins p ON p.id = pp.pin_id
         WHERE pp.attempt_id = $1
         ORDER BY p.sequence_index ASC`,
        [attemptId],
      );
      return rows.map((row) => ({
        pinId: row.pin_id,
        sequenceIndex: row.sequence_index,
        status: row.status,
      }));
    },

    async markAttemptExpired(attemptId) {
      const { rows } = await pool.query(
        `UPDATE trail_attempts SET status = 'expired'
         WHERE id = $1 AND status = 'active' RETURNING *`,
        [attemptId],
      );
      return rows[0] ? toAttempt(rows[0]) : null;
    },

    async completePin({
      attemptId,
      pinId,
      nextPinId,
      completedAt,
    }): Promise<CompletePinResult | null> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // The `status = 'unlocked'` predicate is the write-time guard against a
        // double-submit racing past the route's read-time sequence check (GDR-01).
        const completed = await client.query(
          `UPDATE pin_progress SET status = 'completed', completed_at = $3
           WHERE attempt_id = $1 AND pin_id = $2 AND status = 'unlocked'
           RETURNING id`,
          [attemptId, pinId, completedAt],
        );
        if (completed.rowCount === 0) {
          await client.query('ROLLBACK');
          return null;
        }

        if (nextPinId) {
          await client.query(
            `UPDATE pin_progress SET status = 'unlocked'
             WHERE attempt_id = $1 AND pin_id = $2 AND status = 'locked'`,
            [attemptId, nextPinId],
          );
        }

        // GDR-04: last pin completed ends the attempt.
        const attemptSql = nextPinId
          ? 'SELECT * FROM trail_attempts WHERE id = $1'
          : `UPDATE trail_attempts SET status = 'completed', completed_at = $2
             WHERE id = $1 AND status = 'active' RETURNING *`;
        const attemptParams = nextPinId ? [attemptId] : [attemptId, completedAt];
        const attemptResult = await client.query(attemptSql, attemptParams);

        await client.query('COMMIT');
        return {
          attempt: toAttempt(attemptResult.rows[0]),
          unlockedNextPinId: nextPinId,
        };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async appendLocationHistory(userId, samples: LocationHistoryEntry[]) {
      if (samples.length === 0) return;
      const values: unknown[] = [];
      const tuples = samples.map((sample, i) => {
        const base = i * 5;
        values.push(userId, sample.lat, sample.lng, sample.accuracyM ?? null, sample.recordedAt);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
      });
      await pool.query(
        `INSERT INTO location_history (user_id, lat, lng, accuracy_m, recorded_at)
         VALUES ${tuples.join(', ')}`,
        values,
      );
    },

    async getRecentLocationHistory(userId, since): Promise<LocationSample[]> {
      const { rows } = await pool.query(
        `SELECT lat, lng, recorded_at FROM location_history
         WHERE user_id = $1 AND recorded_at >= $2
         ORDER BY recorded_at ASC`,
        [userId, since],
      );
      return rows.map((row) => ({
        lat: Number(row.lat),
        lng: Number(row.lng),
        recordedAt: row.recorded_at,
      }));
    },

    async createPinReport({ pinId, userId, note }): Promise<PinReportRecord> {
      const { rows } = await pool.query(
        `INSERT INTO pin_reports (pin_id, reported_by_user_id, note)
         VALUES ($1, $2, $3) RETURNING *`,
        [pinId, userId, note],
      );
      return toPinReport(rows[0]);
    },

    async createTrail({ name, createdBy, expiryDays }) {
      return withFreshJoinCode(async (joinCode) => {
        const { rows } = await pool.query(
          `INSERT INTO trails (name, created_by, expiry_days, join_code)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [name, createdBy, expiryDays, joinCode],
        );
        return toTrail(rows[0]);
      });
    },

    async getTrailByJoinCode(joinCode) {
      const { rows } = await pool.query('SELECT * FROM trails WHERE join_code = $1', [joinCode]);
      return rows[0] ? toTrail(rows[0]) : null;
    },

    async rotateJoinCode(trailId) {
      return withFreshJoinCode(async (joinCode) => {
        const { rows } = await pool.query(
          'UPDATE trails SET join_code = $2 WHERE id = $1 RETURNING *',
          [trailId, joinCode],
        );
        return rows[0] ? toTrail(rows[0]) : null;
      });
    },

    async listTrails() {
      const { rows } = await pool.query(
        `SELECT t.*,
                cv.version_number AS current_version_number,
                (SELECT COUNT(*)::int FROM pins p
                  WHERE p.trail_version_id = t.current_version_id)          AS pin_count,
                (SELECT COUNT(*)::int FROM pin_reports r
                   JOIN pins p ON p.id = r.pin_id
                   JOIN trail_versions v ON v.id = p.trail_version_id
                  WHERE v.trail_id = t.id AND r.status = 'open')            AS open_reports
         FROM trails t
         LEFT JOIN trail_versions cv ON cv.id = t.current_version_id
         ORDER BY t.created_at DESC, t.name ASC`,
      );
      return rows.map((row) => ({
        trail: toTrail(row),
        versionNumber: row.current_version_number ?? null,
        pinCount: row.pin_count,
        openReports: row.open_reports,
      }));
    },

    // Each field is applied only when present, so `expiryDays: null` (remove the window) is
    // distinguishable from "don't touch the window".
    async updateTrail(trailId, changes) {
      const { rows } = await pool.query(
        `UPDATE trails
         SET name        = CASE WHEN $2 THEN $3 ELSE name END,
             expiry_days = CASE WHEN $4 THEN $5::int ELSE expiry_days END
         WHERE id = $1
         RETURNING *`,
        [
          trailId,
          changes.name !== undefined,
          changes.name ?? null,
          changes.expiryDays !== undefined,
          changes.expiryDays ?? null,
        ],
      );
      return rows[0] ? toTrail(rows[0]) : null;
    },

    async listTrailVersions(trailId) {
      const { rows } = await pool.query(
        `SELECT v.id, v.version_number, v.published_at, COUNT(p.id)::int AS pin_count
         FROM trail_versions v
         LEFT JOIN pins p ON p.trail_version_id = v.id
         WHERE v.trail_id = $1
         GROUP BY v.id
         ORDER BY v.version_number DESC`,
        [trailId],
      );
      return rows.map((row) => ({
        id: row.id,
        versionNumber: row.version_number,
        publishedAt: row.published_at,
        pinCount: row.pin_count,
      }));
    },

    // GDR-07: a new version is additive. Nothing here touches existing versions, their pins, or
    // any attempt already snapshotted against them — only `trails.current_version_id` moves.
    async publishTrailVersion({ trailId, pins }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const versionResult = await client.query(
          `INSERT INTO trail_versions (trail_id, version_number)
           VALUES ($1, COALESCE((SELECT MAX(version_number) + 1 FROM trail_versions WHERE trail_id = $1), 1))
           RETURNING *`,
          [trailId],
        );
        const version = toTrailVersion(versionResult.rows[0]);

        const inserted: PinRecord[] = [];
        for (const pin of pins) {
          const { rows } = await client.query(
            `INSERT INTO pins (trail_version_id, sequence_index, lat, lng, alt, radius_m, challenge_type, challenge_config)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [
              version.id,
              pin.sequenceIndex,
              pin.lat,
              pin.lng,
              pin.alt,
              pin.radiusM,
              pin.challengeType,
              JSON.stringify(pin.challengeConfig),
            ],
          );
          inserted.push(toPin(rows[0]));
        }

        await client.query('UPDATE trails SET current_version_id = $1 WHERE id = $2', [
          version.id,
          trailId,
        ]);

        await client.query('COMMIT');
        return { version, pins: inserted };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },

    async listPinReports({ status, limit }) {
      const { rows } = await pool.query(
        `SELECT * FROM pin_reports
         WHERE ($1::text IS NULL OR status = $1)
         ORDER BY created_at DESC
         LIMIT $2`,
        [status ?? null, limit],
      );
      return rows.map(toPinReport);
    },

    async updatePinReportStatus(reportId, status) {
      const { rows } = await pool.query(
        'UPDATE pin_reports SET status = $2 WHERE id = $1 RETURNING *',
        [reportId, status],
      );
      return rows[0] ? toPinReport(rows[0]) : null;
    },

    async setUserRole(userId, role) {
      const { rows } = await pool.query(
        'UPDATE users SET role = $2 WHERE id = $1 RETURNING id, device_key_hash, role, created_at',
        [userId, role],
      );
      return rows[0] ? toUser(rows[0]) : null;
    },

    // ST-8.3 / SR-PRIV-03: one grouped pass over trail_attempts. No join to location_history
    // exists here or below — analytics is built to keep working after the SR-PRIV-01 purge.
    // `to` is exclusive so adjacent ranges tile without double-counting.
    async getTrailAttemptAggregates({ trailId, from, to, limit }) {
      const { rows } = await pool.query(
        `SELECT t.id                                                        AS trail_id,
                t.name                                                      AS trail_name,
                COUNT(*)::int                                               AS attempts_started,
                COUNT(*) FILTER (WHERE ta.status = 'completed')::int        AS attempts_completed,
                COUNT(*) FILTER (WHERE ta.status = 'expired')::int          AS attempts_expired,
                COUNT(*) FILTER (WHERE ta.status = 'active')::int           AS attempts_active,
                percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY EXTRACT(EPOCH FROM (ta.completed_at - ta.started_at))
                ) FILTER (WHERE ta.completed_at IS NOT NULL)                AS median_completion_seconds,
                percentile_cont(0.9) WITHIN GROUP (
                    ORDER BY EXTRACT(EPOCH FROM (ta.completed_at - ta.started_at))
                ) FILTER (WHERE ta.completed_at IS NOT NULL)                AS p90_completion_seconds
         FROM trail_attempts ta
         JOIN trails t ON t.id = ta.trail_id
         WHERE ($1::uuid IS NULL OR ta.trail_id = $1)
           AND ($2::timestamptz IS NULL OR ta.started_at >= $2)
           AND ($3::timestamptz IS NULL OR ta.started_at < $3)
         GROUP BY t.id, t.name
         ORDER BY attempts_started DESC, t.name ASC
         LIMIT $4`,
        [trailId ?? null, from ?? null, to ?? null, limit],
      );

      return rows.map((row) => ({
        trailId: row.trail_id,
        trailName: row.trail_name,
        attemptsStarted: row.attempts_started,
        attemptsCompleted: row.attempts_completed,
        attemptsExpired: row.attempts_expired,
        attemptsActive: row.attempts_active,
        medianCompletionSeconds:
          row.median_completion_seconds === null ? null : Number(row.median_completion_seconds),
        p90CompletionSeconds:
          row.p90_completion_seconds === null ? null : Number(row.p90_completion_seconds),
      }));
    },

    // Grouped by sequence_index rather than pin id: a trail's drop-off is a property of the
    // trail, and its pins change identity across versions (GDR-07).
    async getPinFunnel(trailId, { from, to }) {
      const { rows } = await pool.query(
        `SELECT p.sequence_index                                        AS sequence_index,
                COUNT(*) FILTER (WHERE pp.status <> 'locked')::int      AS reached,
                COUNT(*) FILTER (WHERE pp.status = 'completed')::int    AS completed
         FROM pin_progress pp
         JOIN trail_attempts ta ON ta.id = pp.attempt_id
         JOIN pins p ON p.id = pp.pin_id
         WHERE ta.trail_id = $1
           AND ($2::timestamptz IS NULL OR ta.started_at >= $2)
           AND ($3::timestamptz IS NULL OR ta.started_at < $3)
         GROUP BY p.sequence_index
         ORDER BY p.sequence_index ASC`,
        [trailId, from ?? null, to ?? null],
      );

      return rows.map((row) => ({
        sequenceIndex: row.sequence_index,
        reached: row.reached,
        completed: row.completed,
      }));
    },

    async close() {
      await pool.end();
    },
  };
}
