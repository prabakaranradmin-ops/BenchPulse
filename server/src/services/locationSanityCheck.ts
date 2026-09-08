// SR-SEC-02 (docs/requirements-v1.0.md): flag (never hard-block) a player session when
// average speed over a trailing window is implausible for someone traveling on foot between
// quest-trail pins, while tolerating: (a) a brief instantaneous spike (e.g. a passenger glancing
// at the app on a highway), and (b) GPS drift in the first few seconds after a cold start.
//
// This module is pure logic with no I/O so it can be fully covered by unit tests before it's
// wired to anything live, per the build order in CLAUDE.md / requirements §7.

export interface LocationSample {
  lat: number;
  lng: number;
  /** When the device captured this fix — not when the server received it (SR-NET-02). */
  recordedAt: Date;
}

export interface SanityCheckOptions {
  /** m/s average over the window that triggers a flag. Spec default: 30. */
  sustainedSpeedThresholdMps?: number;
  /** Trailing window size in seconds over which the average is computed. Spec default: 30. */
  windowSeconds?: number;
  /** A lone jump at or below this speed is tolerated even if sparse data makes the window average spike. Spec default: 45. */
  instantaneousSpikeAllowanceMps?: number;
  /** Suppress flagging entirely for this many seconds after session start, to absorb GPS-fix settling drift. Spec default: 15. */
  coldStartGraceSeconds?: number;
  /** Minimum samples (and window coverage) required before a high average counts as "sustained" rather than a single jump. */
  minSamplesForSustainedCheck?: number;
}

export interface SanityCheckResult {
  flagged: boolean;
  reason:
    | 'insufficient_data'
    | 'cold_start_grace_period'
    | 'insufficient_window_data'
    | 'instantaneous_spike_within_allowance'
    | 'instantaneous_spike_exceeds_allowance'
    | 'sustained_speed_exceeds_threshold'
    | 'within_normal_range';
  avgSpeedMps?: number;
  maxInstantaneousSpeedMps?: number;
}

const DEFAULTS: Required<SanityCheckOptions> = {
  sustainedSpeedThresholdMps: 30,
  windowSeconds: 30,
  instantaneousSpikeAllowanceMps: 45,
  coldStartGraceSeconds: 15,
  minSamplesForSustainedCheck: 3,
};

const EARTH_RADIUS_M = 6371000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Great-circle distance between two lat/lng points, in meters. */
export function haversineMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * Evaluate a player's recent location history for implausible movement.
 * `history` need not be pre-sorted or pre-trimmed; this function sorts and windows it itself.
 */
export function checkLocationSanity(
  history: LocationSample[],
  sessionStartedAt: Date,
  options: SanityCheckOptions = {},
): SanityCheckResult {
  const opts = { ...DEFAULTS, ...options };

  if (history.length < 2) {
    return { flagged: false, reason: 'insufficient_data' };
  }

  const sorted = [...history].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  const latest = sorted[sorted.length - 1];

  if (latest.recordedAt.getTime() - sessionStartedAt.getTime() < opts.coldStartGraceSeconds * 1000) {
    return { flagged: false, reason: 'cold_start_grace_period' };
  }

  const windowStart = latest.recordedAt.getTime() - opts.windowSeconds * 1000;
  const windowSamples = sorted.filter((s) => s.recordedAt.getTime() >= windowStart);

  if (windowSamples.length < 2) {
    return { flagged: false, reason: 'insufficient_window_data' };
  }

  let totalDistance = 0;
  let maxInstantaneousSpeed = 0;
  for (let i = 1; i < windowSamples.length; i++) {
    const dtSeconds = (windowSamples[i].recordedAt.getTime() - windowSamples[i - 1].recordedAt.getTime()) / 1000;
    if (dtSeconds <= 0) continue;
    const distance = haversineMeters(windowSamples[i - 1], windowSamples[i]);
    totalDistance += distance;
    maxInstantaneousSpeed = Math.max(maxInstantaneousSpeed, distance / dtSeconds);
  }

  const totalTimeSeconds = (windowSamples[windowSamples.length - 1].recordedAt.getTime() - windowSamples[0].recordedAt.getTime()) / 1000;
  if (totalTimeSeconds <= 0) {
    return { flagged: false, reason: 'insufficient_window_data' };
  }

  const avgSpeedMps = totalDistance / totalTimeSeconds;
  const windowCoverageRatio = totalTimeSeconds / opts.windowSeconds;
  const hasEnoughDataToCallItSustained =
    windowSamples.length >= opts.minSamplesForSustainedCheck && windowCoverageRatio >= 0.5;

  if (!hasEnoughDataToCallItSustained) {
    // Not enough samples spanning the window to distinguish "sustained" from "one jump" —
    // fall back to the instantaneous-spike allowance instead of the sustained threshold.
    if (maxInstantaneousSpeed <= opts.instantaneousSpikeAllowanceMps) {
      return {
        flagged: false,
        reason: 'instantaneous_spike_within_allowance',
        avgSpeedMps,
        maxInstantaneousSpeedMps: maxInstantaneousSpeed,
      };
    }
    return {
      flagged: true,
      reason: 'instantaneous_spike_exceeds_allowance',
      avgSpeedMps,
      maxInstantaneousSpeedMps: maxInstantaneousSpeed,
    };
  }

  if (avgSpeedMps > opts.sustainedSpeedThresholdMps) {
    return {
      flagged: true,
      reason: 'sustained_speed_exceeds_threshold',
      avgSpeedMps,
      maxInstantaneousSpeedMps: maxInstantaneousSpeed,
    };
  }

  return {
    flagged: false,
    reason: 'within_normal_range',
    avgSpeedMps,
    maxInstantaneousSpeedMps: maxInstantaneousSpeed,
  };
}
