// SR-PRIV-01 — raw location history is kept for a bounded window, then dropped.
//
// The spec allows either deleting old rows or reducing them to trail-level completion facts for
// analytics. Deleting is enough here: completion facts already live in `trail_attempts` and
// `pin_progress`, which hold no coordinates, so SR-PRIV-03's aggregate analytics survive a purge
// with nothing extra to aggregate first.

/** Retention window for raw per-player coordinates `[ASSUMED: 90 days — confirm]`. */
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * Rows captured strictly before this instant are past the window. Throws rather than guessing
 * on a nonsense value — a misread env var must not silently turn into "delete everything".
 */
export function retentionCutoff(now: Date, retentionDays: number = DEFAULT_RETENTION_DAYS): Date {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new RangeError(`retentionDays must be a finite number >= 1, got ${retentionDays}`);
  }
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}
