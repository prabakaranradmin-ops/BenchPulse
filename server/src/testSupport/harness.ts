// Test harness: a real Fastify app (same buildApp as production) wired to the in-memory
// store, so route tests exercise auth, validation, and the sequencing/scoping rules without
// a live Postgres+PostGIS instance.

import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildAppOptions } from '../app.js';
import { createMemoryStore, type MemoryState, type MemoryStore } from '../db/memoryStore.js';
import type { PinRecord, TrailRecord, TrailVersionRecord, UserRole } from '../db/types.js';

export const TEST_JWT_SECRET = 'test-secret-not-for-production';

/** Meters per degree of longitude at the equator — all fixtures sit at lat 0 for easy math. */
export const METERS_PER_DEGREE_LNG_AT_EQUATOR = 111320;

export function lngAtMeters(meters: number): number {
  return meters / METERS_PER_DEGREE_LNG_AT_EQUATOR;
}

export interface TestApp {
  app: FastifyInstance;
  store: MemoryStore;
  tokenFor(userId: string, role?: UserRole): string;
  authHeader(userId: string, role?: UserRole): { authorization: string };
  /** Token for a player seeded (or promoted) as an Admin — EPIC 7 routes. */
  adminHeader(userId: string): { authorization: string };
}

export async function buildTestApp(
  seed: Partial<MemoryState> = {},
  overrides: Partial<BuildAppOptions> = {},
): Promise<TestApp> {
  const store = createMemoryStore(seed);
  const app = await buildApp({
    store,
    jwtSecret: TEST_JWT_SECRET,
    // Off by default so a test's request count can't trip SR-SEC-03; the rate-limit test
    // turns it back on explicitly.
    rateLimit: false,
    ...overrides,
  });
  // Mints a token *and* seeds the player row it points at — a token whose `sub` has no user
  // is exactly the SR-PRIV-02 stale-token case, which tests should have to set up on purpose.
  // A role is only written when the caller names one, so `authHeader` can't quietly demote an
  // admin seeded earlier in the same test.
  const tokenFor = (userId: string, role?: UserRole) => {
    const existing = store.state.users.find((user) => user.id === userId);
    if (existing) {
      if (role) existing.role = role;
    } else {
      store.state.users.push({
        id: userId,
        deviceKeyHash: null,
        role: role ?? 'player',
        createdAt: new Date(),
      });
    }
    return app.jwt.sign({ sub: userId });
  };
  return {
    app,
    store,
    tokenFor,
    authHeader: (userId: string, role?: UserRole) => ({
      authorization: `Bearer ${tokenFor(userId, role)}`,
    }),
    adminHeader: (userId: string) => ({ authorization: `Bearer ${tokenFor(userId, 'admin')}` }),
  };
}

export interface CompleteOptions {
  userId: string;
  attemptId: string;
  pinId: string;
  /** Defaults to the pin's own coordinates — i.e. the player is standing on it. */
  lat?: number;
  lng?: number;
  accuracyM?: number;
  recordedAt?: Date;
  sessionStartedAt?: Date;
  recentLocationHistory?: Array<{ lat: number; lng: number; recordedAt: Date }>;
}

/** POSTs a pin completion, defaulting the reported fix to the pin's own location. */
export function completePin(ctx: TestApp, options: CompleteOptions) {
  const pin = ctx.store.state.pins.find((p) => p.id === options.pinId);
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/attempts/${options.attemptId}/pins/${options.pinId}/complete`,
    headers: ctx.authHeader(options.userId),
    payload: {
      lat: options.lat ?? pin?.lat ?? 0,
      lng: options.lng ?? pin?.lng ?? 0,
      accuracyM: options.accuracyM ?? 5,
      ...(options.recordedAt ? { recordedAt: options.recordedAt.toISOString() } : {}),
      ...(options.sessionStartedAt
        ? { sessionStartedAt: options.sessionStartedAt.toISOString() }
        : {}),
      ...(options.recentLocationHistory
        ? {
            recentLocationHistory: options.recentLocationHistory.map((s) => ({
              lat: s.lat,
              lng: s.lng,
              recordedAt: s.recordedAt.toISOString(),
            })),
          }
        : {}),
    },
  });
}

export interface SeedPinSpec {
  id: string;
  sequenceIndex: number;
  /** Meters east of (0, 0). */
  eastMeters: number;
  radiusM?: number;
  challengeType?: PinRecord['challengeType'];
  challengeConfig?: Record<string, unknown>;
}

export interface SeedTrailSpec {
  trailId?: string;
  versionId?: string;
  versionNumber?: number;
  name?: string;
  expiryDays?: number | null;
  /** When false, the trail exists but has no current_version_id (unpublished). */
  published?: boolean;
  pins: SeedPinSpec[];
}

export interface SeededTrail {
  trail: TrailRecord;
  version: TrailVersionRecord;
  pins: PinRecord[];
}

/** Builds trail/version/pin records for a memory-store seed. */
export function seedTrail(spec: SeedTrailSpec): SeededTrail {
  const trailId = spec.trailId ?? 'trail-1';
  const versionId = spec.versionId ?? 'version-1';

  const version: TrailVersionRecord = {
    id: versionId,
    trailId,
    versionNumber: spec.versionNumber ?? 1,
    publishedAt: new Date('2026-01-01T00:00:00Z'),
  };

  const trail: TrailRecord = {
    id: trailId,
    name: spec.name ?? 'Harbour Trail',
    expiryDays: spec.expiryDays ?? null,
    currentVersionId: spec.published === false ? null : versionId,
  };

  const pins: PinRecord[] = spec.pins.map((pin) => ({
    id: pin.id,
    trailVersionId: versionId,
    sequenceIndex: pin.sequenceIndex,
    lat: 0,
    lng: lngAtMeters(pin.eastMeters),
    alt: null,
    radiusM: pin.radiusM ?? 10,
    challengeType: pin.challengeType ?? 'proximity_dwell',
    challengeConfig: pin.challengeConfig ?? { dwell_seconds: 15 },
  }));

  return { trail, version, pins };
}

/**
 * Merges seeded trails into a memory-store seed. Trails are deduped by id, last one wins —
 * so passing two versions of the same trail models an Admin publishing a new version (GDR-07):
 * both versions' pins exist, and the trail points at the later one.
 */
export function seedState(...trails: SeededTrail[]): Partial<MemoryState> {
  const byTrailId = new Map<string, TrailRecord>();
  for (const seeded of trails) {
    byTrailId.set(seeded.trail.id, seeded.trail);
  }
  return {
    trails: [...byTrailId.values()],
    versions: trails.map((t) => t.version),
    pins: trails.flatMap((t) => t.pins),
  };
}
