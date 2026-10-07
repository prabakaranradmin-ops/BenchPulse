// In-memory TrailStore, mirroring the migrated schema closely enough to exercise the
// route-level rules (GDR-01 sequencing, GDR-06 replay, SR-DATA-01/02 scoping) in unit tests
// without a live Postgres+PostGIS instance. Test support only — production wiring in
// index.ts always uses createPostgresStore.

import { randomUUID } from 'node:crypto';
import type {
  AttemptPinState,
  AttemptRecord,
  CompletePinResult,
  LocationHistoryEntry,
  PinRecord,
  PinReportRecord,
  PinProgressStatus,
  TrailRecord,
  TrailStore,
  TrailVersionRecord,
  UserRecord,
} from './types.js';
import type { LocationSample } from '../services/locationSanityCheck.js';
import { percentileCont } from '../services/analytics.js';
import { generateJoinCode } from '../services/joinCode.js';

export interface ProgressRow {
  attemptId: string;
  pinId: string;
  status: PinProgressStatus;
  completedAt: Date | null;
}

export interface LocationHistoryRow extends LocationHistoryEntry {
  userId: string;
}

export interface MemoryState {
  users: UserRecord[];
  trails: TrailRecord[];
  versions: TrailVersionRecord[];
  pins: PinRecord[];
  attempts: AttemptRecord[];
  progress: ProgressRow[];
  locationHistory: LocationHistoryRow[];
  pinReports: PinReportRecord[];
}

export interface MemoryStore extends TrailStore {
  /** Exposed so tests can assert on persisted rows directly (e.g. "attempt 1 is untouched"). */
  state: MemoryState;
}

export function createMemoryStore(seed: Partial<MemoryState> = {}): MemoryStore {
  const state: MemoryState = {
    users: seed.users ?? [],
    trails: seed.trails ?? [],
    versions: seed.versions ?? [],
    pins: seed.pins ?? [],
    attempts: seed.attempts ?? [],
    progress: seed.progress ?? [],
    locationHistory: seed.locationHistory ?? [],
    pinReports: seed.pinReports ?? [],
  };

  // Mirrors the UNIQUE constraint on trails.join_code.
  const uniqueJoinCode = (): string => {
    for (;;) {
      const code = generateJoinCode();
      if (!state.trails.some((t) => t.joinCode === code)) return code;
    }
  };

  return {
    state,

    async findOrCreateUserByDeviceKeyHash(deviceKeyHash) {
      const existing = state.users.find((u) => u.deviceKeyHash === deviceKeyHash);
      if (existing) return existing;
      const user: UserRecord = {
        id: randomUUID(),
        deviceKeyHash,
        role: 'player',
        createdAt: new Date(),
      };
      state.users.push(user);
      return user;
    },

    async getUser(userId) {
      return state.users.find((u) => u.id === userId) ?? null;
    },

    async deleteUserData(userId) {
      const locationSamples = state.locationHistory.filter((row) => row.userId === userId).length;
      state.locationHistory = state.locationHistory.filter((row) => row.userId !== userId);

      const attemptIds = state.attempts.filter((a) => a.userId === userId).map((a) => a.id);
      state.progress = state.progress.filter((row) => !attemptIds.includes(row.attemptId));
      state.attempts = state.attempts.filter((a) => a.userId !== userId);

      // Mirrors ON DELETE SET NULL: the Admin's queue item outlives the reporter.
      for (const report of state.pinReports) {
        if (report.reportedByUserId === userId) report.reportedByUserId = null;
      }

      const userIndex = state.users.findIndex((u) => u.id === userId);
      if (userIndex >= 0) state.users.splice(userIndex, 1);

      return { locationSamples, attempts: attemptIds.length, userDeleted: userIndex >= 0 };
    },

    async purgeLocationHistoryBefore(cutoff) {
      const before = state.locationHistory.length;
      state.locationHistory = state.locationHistory.filter(
        (row) => row.recordedAt.getTime() >= cutoff.getTime(),
      );
      return before - state.locationHistory.length;
    },

    async getTrail(trailId) {
      return state.trails.find((t) => t.id === trailId) ?? null;
    },

    async getTrailVersion(trailVersionId) {
      return state.versions.find((v) => v.id === trailVersionId) ?? null;
    },

    async getPinsForVersion(trailVersionId) {
      return state.pins
        .filter((p) => p.trailVersionId === trailVersionId)
        .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
    },

    async getPin(pinId) {
      return state.pins.find((p) => p.id === pinId) ?? null;
    },

    async createAttempt({ userId, trailId, trailVersionId }) {
      const attempt: AttemptRecord = {
        id: randomUUID(),
        userId,
        trailId,
        trailVersionId,
        status: 'active',
        startedAt: new Date(),
        completedAt: null,
      };
      state.attempts.push(attempt);

      const pins = state.pins
        .filter((p) => p.trailVersionId === trailVersionId)
        .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
      const firstIndex = pins.length > 0 ? pins[0].sequenceIndex : null;
      for (const pin of pins) {
        state.progress.push({
          attemptId: attempt.id,
          pinId: pin.id,
          status: pin.sequenceIndex === firstIndex ? 'unlocked' : 'locked',
          completedAt: null,
        });
      }
      return attempt;
    },

    async getAttempt(attemptId) {
      return state.attempts.find((a) => a.id === attemptId) ?? null;
    },

    async getAttemptPinStates(attemptId): Promise<AttemptPinState[]> {
      return state.progress
        .filter((row) => row.attemptId === attemptId)
        .map((row) => {
          const pin = state.pins.find((p) => p.id === row.pinId) as PinRecord;
          return { pinId: row.pinId, sequenceIndex: pin.sequenceIndex, status: row.status };
        })
        .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
    },

    async markAttemptExpired(attemptId) {
      const attempt = state.attempts.find((a) => a.id === attemptId && a.status === 'active');
      if (!attempt) return null;
      attempt.status = 'expired';
      return attempt;
    },

    async completePin({
      attemptId,
      pinId,
      nextPinId,
      completedAt,
    }): Promise<CompletePinResult | null> {
      const row = state.progress.find(
        (p) => p.attemptId === attemptId && p.pinId === pinId && p.status === 'unlocked',
      );
      if (!row) return null;
      row.status = 'completed';
      row.completedAt = completedAt;

      if (nextPinId) {
        const next = state.progress.find(
          (p) => p.attemptId === attemptId && p.pinId === nextPinId && p.status === 'locked',
        );
        if (next) next.status = 'unlocked';
      }

      const attempt = state.attempts.find((a) => a.id === attemptId) as AttemptRecord;
      if (!nextPinId && attempt.status === 'active') {
        attempt.status = 'completed';
        attempt.completedAt = completedAt;
      }
      return { attempt, unlockedNextPinId: nextPinId };
    },

    async appendLocationHistory(userId, samples) {
      for (const sample of samples) {
        state.locationHistory.push({ userId, ...sample });
      }
    },

    async getRecentLocationHistory(userId, since): Promise<LocationSample[]> {
      return state.locationHistory
        .filter((row) => row.userId === userId && row.recordedAt.getTime() >= since.getTime())
        .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
        .map((row) => ({ lat: row.lat, lng: row.lng, recordedAt: row.recordedAt }));
    },

    async createPinReport({ pinId, userId, note }): Promise<PinReportRecord> {
      const report: PinReportRecord = {
        id: randomUUID(),
        pinId,
        reportedByUserId: userId,
        note,
        status: 'open',
        createdAt: new Date(),
      };
      state.pinReports.push(report);
      return report;
    },

    async createTrail({ name, createdBy, expiryDays }) {
      const trail: TrailRecord = {
        id: randomUUID(),
        name,
        expiryDays,
        currentVersionId: null,
        createdBy,
        joinCode: uniqueJoinCode(),
        createdAt: new Date(),
      };
      state.trails.push(trail);
      return trail;
    },

    async getTrailByJoinCode(joinCode) {
      return state.trails.find((t) => t.joinCode === joinCode) ?? null;
    },

    async rotateJoinCode(trailId) {
      const trail = state.trails.find((t) => t.id === trailId);
      if (!trail) return null;
      trail.joinCode = uniqueJoinCode();
      return trail;
    },

    async listTrails() {
      return [...state.trails]
        .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
        .map((trail) => {
          const versionIds = new Set(
            state.versions.filter((v) => v.trailId === trail.id).map((v) => v.id),
          );
          const pinIds = new Set(
            state.pins.filter((p) => versionIds.has(p.trailVersionId)).map((p) => p.id),
          );
          return {
            trail,
            versionNumber:
              state.versions.find((v) => v.id === trail.currentVersionId)?.versionNumber ?? null,
            pinCount: state.pins.filter((p) => p.trailVersionId === trail.currentVersionId).length,
            openReports: state.pinReports.filter((r) => r.status === 'open' && pinIds.has(r.pinId))
              .length,
          };
        });
    },

    async updateTrail(trailId, changes) {
      const trail = state.trails.find((t) => t.id === trailId);
      if (!trail) return null;
      if (changes.name !== undefined) trail.name = changes.name;
      if (changes.expiryDays !== undefined) trail.expiryDays = changes.expiryDays;
      return trail;
    },

    async listTrailVersions(trailId) {
      return state.versions
        .filter((v) => v.trailId === trailId)
        .sort((a, b) => b.versionNumber - a.versionNumber)
        .map((v) => ({
          id: v.id,
          versionNumber: v.versionNumber,
          publishedAt: v.publishedAt,
          pinCount: state.pins.filter((p) => p.trailVersionId === v.id).length,
        }));
    },

    async publishTrailVersion({ trailId, pins }) {
      const versionNumber =
        state.versions
          .filter((v) => v.trailId === trailId)
          .reduce((max, v) => Math.max(max, v.versionNumber), 0) + 1;
      const version: TrailVersionRecord = {
        id: randomUUID(),
        trailId,
        versionNumber,
        publishedAt: new Date(),
      };
      state.versions.push(version);

      const inserted: PinRecord[] = pins.map((pin) => ({
        id: randomUUID(),
        trailVersionId: version.id,
        sequenceIndex: pin.sequenceIndex,
        lat: pin.lat,
        lng: pin.lng,
        alt: pin.alt,
        radiusM: pin.radiusM,
        challengeType: pin.challengeType,
        challengeConfig: pin.challengeConfig,
      }));
      state.pins.push(...inserted);

      const trail = state.trails.find((t) => t.id === trailId);
      if (trail) trail.currentVersionId = version.id;

      return { version, pins: inserted };
    },

    async listPinReports({ status, limit }) {
      return state.pinReports
        .filter((report) => (status ? report.status === status : true))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    },

    async updatePinReportStatus(reportId, status) {
      const report = state.pinReports.find((r) => r.id === reportId);
      if (!report) return null;
      report.status = status;
      return report;
    },

    async setUserRole(userId, role) {
      const user = state.users.find((u) => u.id === userId);
      if (!user) return null;
      user.role = role;
      return user;
    },

    // ST-8.3: mirrors the SQL in postgresStore, including `to` being exclusive and percentiles
    // using percentile_cont interpolation (shared helper, so the two agree).
    async getTrailAttemptAggregates({ trailId, from, to, limit }) {
      const inRange = state.attempts.filter((attempt) => {
        if (trailId && attempt.trailId !== trailId) return false;
        if (from && attempt.startedAt.getTime() < from.getTime()) return false;
        if (to && attempt.startedAt.getTime() >= to.getTime()) return false;
        return true;
      });

      const byTrail = new Map<string, AttemptRecord[]>();
      for (const attempt of inRange) {
        const bucket = byTrail.get(attempt.trailId);
        if (bucket) bucket.push(attempt);
        else byTrail.set(attempt.trailId, [attempt]);
      }

      return [...byTrail.entries()]
        .map(([id, attempts]) => {
          const durations = attempts
            .filter((a) => a.completedAt !== null)
            .map((a) => (a.completedAt!.getTime() - a.startedAt.getTime()) / 1000);
          return {
            trailId: id,
            trailName: state.trails.find((t) => t.id === id)?.name ?? '',
            attemptsStarted: attempts.length,
            attemptsCompleted: attempts.filter((a) => a.status === 'completed').length,
            attemptsExpired: attempts.filter((a) => a.status === 'expired').length,
            attemptsActive: attempts.filter((a) => a.status === 'active').length,
            medianCompletionSeconds: percentileCont(durations, 0.5),
            p90CompletionSeconds: percentileCont(durations, 0.9),
          };
        })
        .sort(
          (a, b) => b.attemptsStarted - a.attemptsStarted || a.trailName.localeCompare(b.trailName),
        )
        .slice(0, limit);
    },

    async getPinFunnel(trailId, { from, to }) {
      const attemptIds = new Set(
        state.attempts
          .filter((attempt) => {
            if (attempt.trailId !== trailId) return false;
            if (from && attempt.startedAt.getTime() < from.getTime()) return false;
            if (to && attempt.startedAt.getTime() >= to.getTime()) return false;
            return true;
          })
          .map((attempt) => attempt.id),
      );

      const bySequence = new Map<number, { reached: number; completed: number }>();
      for (const row of state.progress) {
        if (!attemptIds.has(row.attemptId)) continue;
        const pin = state.pins.find((p) => p.id === row.pinId);
        if (!pin) continue;
        const step = bySequence.get(pin.sequenceIndex) ?? { reached: 0, completed: 0 };
        if (row.status !== 'locked') step.reached += 1;
        if (row.status === 'completed') step.completed += 1;
        bySequence.set(pin.sequenceIndex, step);
      }

      return [...bySequence.entries()]
        .map(([sequenceIndex, counts]) => ({ sequenceIndex, ...counts }))
        .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
    },

    async close() {
      // nothing to release
    },
  };
}
