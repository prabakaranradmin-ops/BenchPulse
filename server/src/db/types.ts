// Storage contract for the trail/progress API.
//
// Route handlers depend on this interface rather than on `pg` directly, so the
// sequencing/scoping rules that carry the requirement weight (GDR-01, SR-DATA-01/02,
// SR-GEO-04, SR-SEC-02) can be tested without a live Postgres+PostGIS instance.
// `postgresStore.ts` is the production implementation; `memoryStore.ts` backs the tests.

import type { LocationSample } from '../services/locationSanityCheck.js';

export type ChallengeType = 'proximity_dwell' | 'photo_confirmation' | 'code_entry';
export type AttemptStatus = 'active' | 'completed' | 'expired';
export type PinProgressStatus = 'locked' | 'unlocked' | 'completed';
export type PinReportStatus = 'open' | 'reviewed' | 'resolved';

export type UserRole = 'player' | 'admin';

export interface UserRecord {
  id: string;
  deviceKeyHash: string | null;
  /** Requirements §2: the Admin is the sole producer of pin content in v1. */
  role: UserRole;
  createdAt: Date;
}

export interface TrailRecord {
  id: string;
  name: string;
  /** The authoring Admin (ST-7.2); null for rows created before authoring existed. */
  createdBy?: string | null;
  /** GDR-08: optional validity window; null = no expiry. */
  expiryDays: number | null;
  /** null until the Admin publishes a version (GDR-07). */
  currentVersionId: string | null;
}

export interface TrailVersionRecord {
  id: string;
  trailId: string;
  versionNumber: number;
  publishedAt: Date;
}

export interface PinRecord {
  id: string;
  trailVersionId: string;
  sequenceIndex: number;
  lat: number;
  lng: number;
  /** Altitude-aware pins are out of scope for v1 (requirements §8) — carried, not used. */
  alt: number | null;
  radiusM: number;
  challengeType: ChallengeType;
  /** May contain answers (e.g. a `code_entry` code) — never serialize this straight to a client. */
  challengeConfig: Record<string, unknown>;
}

export interface AttemptRecord {
  id: string;
  userId: string;
  trailId: string;
  /** GDR-07: the version snapshotted when this attempt started. */
  trailVersionId: string;
  status: AttemptStatus;
  startedAt: Date;
  completedAt: Date | null;
}

/** One pin's position in an attempt — `pin_progress` joined to `pins` for the sequence index. */
export interface AttemptPinState {
  pinId: string;
  sequenceIndex: number;
  status: PinProgressStatus;
}

export interface PinReportRecord {
  id: string;
  pinId: string;
  /** Null once the reporter exercises SR-PRIV-02 deletion — the Admin's queue item survives. */
  reportedByUserId: string | null;
  note: string | null;
  status: PinReportStatus;
  createdAt: Date;
}

export interface LocationHistoryEntry extends LocationSample {
  accuracyM?: number | null;
}

/**
 * ST-8.3 / SR-PRIV-03 inputs. Everything here comes from `trail_attempts` and `pin_progress`,
 * which hold no coordinates — analytics never reads `location_history`, and stays correct after
 * the SR-PRIV-01 purge has emptied it.
 */
export interface AnalyticsRange {
  /** Inclusive lower bound on `started_at`. */
  from?: Date;
  /** Exclusive upper bound on `started_at`, so adjacent ranges don't double-count. */
  to?: Date;
}

export interface TrailAttemptAggregate {
  trailId: string;
  trailName: string;
  attemptsStarted: number;
  attemptsCompleted: number;
  attemptsExpired: number;
  attemptsActive: number;
  /** Seconds from `started_at` to `completed_at`, over completed attempts only. */
  medianCompletionSeconds: number | null;
  p90CompletionSeconds: number | null;
}

/** One step of the drop-off funnel, aggregated across a trail's versions by position. */
export interface PinFunnelRow {
  sequenceIndex: number;
  /** Attempts that got this pin unlocked (whether or not they finished it). */
  reached: number;
  completed: number;
}

/** A pin as authored, before it has an id (ST-7.2). */
export interface NewPinInput {
  sequenceIndex: number;
  lat: number;
  lng: number;
  alt: number | null;
  radiusM: number;
  challengeType: ChallengeType;
  challengeConfig: Record<string, unknown>;
}

export interface DeletionSummary {
  locationSamples: number;
  attempts: number;
  userDeleted: boolean;
}

export interface CompletePinResult {
  attempt: AttemptRecord;
  unlockedNextPinId: string | null;
}

export interface TrailStore {
  /**
   * ST-2.6: find-or-create in one step, so two devices racing on the same key (a retried
   * request, an app relaunch mid-flight) converge on one player rather than two.
   */
  findOrCreateUserByDeviceKeyHash(deviceKeyHash: string): Promise<UserRecord>;
  getUser(userId: string): Promise<UserRecord | null>;

  /**
   * SR-PRIV-02: removes the player's raw location history, progress, attempts, and the user
   * row itself. Pin reports (GDR-09) survive with a null reporter — they're an Admin work
   * item about a place, not personal data about the player.
   */
  deleteUserData(userId: string): Promise<DeletionSummary>;

  /** SR-PRIV-01: drops raw location fixes captured before `cutoff`. Returns the row count. */
  purgeLocationHistoryBefore(cutoff: Date): Promise<number>;

  getTrail(trailId: string): Promise<TrailRecord | null>;
  getTrailVersion(trailVersionId: string): Promise<TrailVersionRecord | null>;
  getPinsForVersion(trailVersionId: string): Promise<PinRecord[]>;
  getPin(pinId: string): Promise<PinRecord | null>;

  /** GDR-06: always inserts a new attempt (plus its `pin_progress` rows); never mutates an existing one. */
  createAttempt(input: {
    userId: string;
    trailId: string;
    trailVersionId: string;
  }): Promise<AttemptRecord>;
  getAttempt(attemptId: string): Promise<AttemptRecord | null>;
  getAttemptPinStates(attemptId: string): Promise<AttemptPinState[]>;
  /** GDR-08: an attempt past its trail's validity window is marked expired, not deleted. */
  markAttemptExpired(attemptId: string): Promise<AttemptRecord | null>;

  /**
   * Completes `pinId` and unlocks `nextPinId` in one transaction. Returns null if the pin
   * was not in `unlocked` state at write time — that guard is what makes a concurrent
   * double-submit safe, independent of the read-time sequence check in the route.
   */
  completePin(input: {
    attemptId: string;
    pinId: string;
    nextPinId: string | null;
    completedAt: Date;
  }): Promise<CompletePinResult | null>;

  /** SR-SEC-02 input, SR-PRIV-01 retention target. `recordedAt` is device capture time (SR-NET-02). */
  appendLocationHistory(userId: string, samples: LocationHistoryEntry[]): Promise<void>;
  getRecentLocationHistory(userId: string, since: Date): Promise<LocationSample[]>;

  /** GDR-09: "can't find this pin" report queue. */
  createPinReport(input: {
    pinId: string;
    userId: string;
    note: string | null;
  }): Promise<PinReportRecord>;

  // --- Authoring (EPIC 7). Admin-only at the route layer; the store just does the writes. ---

  /** ST-7.2: creates the trail shell. Pins arrive with the first published version. */
  createTrail(input: {
    name: string;
    createdBy: string;
    expiryDays: number | null;
  }): Promise<TrailRecord>;

  /**
   * ST-7.2 / GDR-07: writes a new version with its pins and points the trail at it, in one
   * transaction. Attempts already in flight keep their own snapshot and are untouched.
   */
  publishTrailVersion(input: {
    trailId: string;
    pins: NewPinInput[];
  }): Promise<{ version: TrailVersionRecord; pins: PinRecord[] }>;

  /** ST-7.3: the Admin review queue, newest first. */
  listPinReports(filter: { status?: PinReportStatus; limit: number }): Promise<PinReportRecord[]>;
  updatePinReportStatus(reportId: string, status: PinReportStatus): Promise<PinReportRecord | null>;

  /** Out-of-band promotion (`npm run grant-admin`) — never reachable from a player route. */
  setUserRole(userId: string, role: UserRole): Promise<UserRecord | null>;

  // --- Analytics (ST-8.3, SR-PRIV-03). Aggregates only; no per-player rows leave the store. ---

  getTrailAttemptAggregates(
    query: AnalyticsRange & { trailId?: string; limit: number },
  ): Promise<TrailAttemptAggregate[]>;
  getPinFunnel(trailId: string, range: AnalyticsRange): Promise<PinFunnelRow[]>;

  close(): Promise<void>;
}
