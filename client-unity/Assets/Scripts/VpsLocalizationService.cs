using System;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// Wraps ARCore Geospatial API / Niantic Lightship VPS localization, and falls back to
    /// GPS-only positioning when VPS is unavailable or times out.
    /// Requirements: SR-GEO-03 (VPS accuracy thresholds), SR-NET-03 (VPS-unavailable fallback).
    /// </summary>
    public class VpsLocalizationService : MonoBehaviour
    {
        public enum PositionSource { Vps, GpsFallback, Unavailable }

        [SerializeField] private float vpsTimeoutSeconds = 5f;
        [SerializeField] private double maxHorizontalAccuracyMeters = 0.5; // SR-GEO-03
        [SerializeField] private double maxHeadingAccuracyDegrees = 5.0;   // SR-GEO-03

        public event Action<PositionResult> OnPositionUpdated;

        private float _vpsAttemptStartedAt = -1f;

        public void RequestLocalization()
        {
            _vpsAttemptStartedAt = Time.time;
            // TODO: call into ARCore Geospatial API (or Lightship VPS) for a localization
            // attempt. On success meeting SR-GEO-03's thresholds, emit PositionSource.Vps.
            // On failure or once vpsTimeoutSeconds elapses, call FallBackToGps().
        }

        private void FallBackToGps()
        {
            // SR-NET-03: reduced precision, but the app must say so rather than pretend the
            // pin is still sub-meter accurate. Feed this through to the challenge's
            // reportedAccuracyMeters (see ProximityDwellChallenge / SR-GEO-04) unchanged —
            // don't fake a tighter accuracy value to make the UI look better.
            // TODO: read Input.location (or the platform equivalent) and emit GpsFallback with
            // its native accuracy figure.
        }

        public readonly struct PositionResult
        {
            public readonly PositionSource Source;
            public readonly double Lat;
            public readonly double Lng;
            public readonly double HorizontalAccuracyMeters;

            public PositionResult(PositionSource source, double lat, double lng, double horizontalAccuracyMeters)
            {
                Source = source;
                Lat = lat;
                Lng = lng;
                HorizontalAccuracyMeters = horizontalAccuracyMeters;
            }
        }
    }
}
