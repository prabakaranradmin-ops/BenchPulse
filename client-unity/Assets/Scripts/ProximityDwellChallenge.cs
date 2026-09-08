using System;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// The first challenge type to implement (per requirements §6.7 build order — cheapest to
    /// get right end-to-end before photo_confirmation/code_entry). Requires the player's
    /// validated position to stay within the pin's effective radius for a minimum duration.
    /// Requirements: GDR-02, SR-GEO-04 (effective radius = max(pin.radius, device accuracy)).
    /// </summary>
    public class ProximityDwellChallenge : MonoBehaviour
    {
        [SerializeField] private float requiredDwellSeconds = 15f;
        [SerializeField] private float accuracyCeilingMeters = 50f; // SR-GEO-04's configured ceiling

        private PinDefinition _pin;
        private float _dwellTimer;
        private bool _completed;

        public event Action OnChallengeCompleted;

        public void Initialize(PinDefinition pin, float dwellSecondsOverride = -1f)
        {
            _pin = pin;
            if (dwellSecondsOverride > 0f) requiredDwellSeconds = dwellSecondsOverride;
            _dwellTimer = 0f;
            _completed = false;
        }

        /// <summary>Call every location update while this pin is the active (unlocked) one.</summary>
        public void OnLocationUpdate(double lat, double lng, double reportedAccuracyMeters, float deltaTime)
        {
            if (_completed) return;

            if (reportedAccuracyMeters > accuracyCeilingMeters)
            {
                // SR-GEO-04: don't silently fail or falsely complete — surface a hint instead.
                // TODO: raise a UI event, e.g. "GPS signal weak — move to open sky".
                _dwellTimer = 0f;
                return;
            }

            double effectiveRadius = Math.Max(_pin.radiusMeters, reportedAccuracyMeters);
            double distance = HaversineMeters(lat, lng, _pin.lat, _pin.lng);

            if (distance <= effectiveRadius)
            {
                _dwellTimer += deltaTime;
                if (_dwellTimer >= requiredDwellSeconds)
                {
                    _completed = true;
                    // TODO: call the server's POST /api/v1/attempts/{attemptId}/pins/{pinId}/complete
                    // (see server/src/routes/pins.ts) rather than trusting client-side completion
                    // alone — the server re-validates radius and runs the SR-SEC-02 sanity check.
                    OnChallengeCompleted?.Invoke();
                }
            }
            else
            {
                _dwellTimer = 0f; // GDR-11: no forced timeout on the challenge itself, but leaving
                                  // the radius resets the dwell clock — that's gameplay, not a timer.
            }
        }

        private static double HaversineMeters(double lat1, double lng1, double lat2, double lng2)
        {
            const double earthRadiusM = 6371000;
            double dLat = (lat2 - lat1) * Math.PI / 180.0;
            double dLng = (lng2 - lng1) * Math.PI / 180.0;
            double a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2)
                     + Math.Cos(lat1 * Math.PI / 180.0) * Math.Cos(lat2 * Math.PI / 180.0)
                     * Math.Sin(dLng / 2) * Math.Sin(dLng / 2);
            double c = 2 * Math.Asin(Math.Sqrt(a));
            return earthRadiusM * c;
        }
    }
}
