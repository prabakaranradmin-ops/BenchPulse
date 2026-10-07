using System;
using ArQuestTrail.Core;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// GDR-02's proximity_dwell for whichever pin is active. The rule — stay inside SR-GEO-04's
    /// effective radius, timed by fix timestamps — is <see cref="DwellTracker"/> in Core, which is
    /// tested against the server's own completion cases. This only routes fixes to it and reports
    /// when it is satisfied; the server still re-checks the completion fix.
    /// </summary>
    public class ProximityDwellChallenge : MonoBehaviour
    {
        private PinDto _pin;
        private bool _submitting;

        public PinDto Pin => _pin;

        /// <summary>Null when the active pin isn't a dwell pin.</summary>
        public DwellTracker Tracker { get; private set; }

        public bool IsSubmitting => _submitting;

        /// <summary>The pin and the in-radius fix that satisfied it — what to submit.</summary>
        public event Action<PinDto, LocationFix> OnChallengeCompleted;

        /// <summary>Follow the active pin. A change of pin starts a fresh dwell.</summary>
        public void Track(PinDto pin)
        {
            if (_pin?.PinId == pin?.PinId)
            {
                return;
            }

            _pin = pin;
            _submitting = false;
            Tracker = pin != null && pin.ChallengeType == ChallengeTypes.ProximityDwell
                ? DwellTracker.ForPin(pin)
                : null;
        }

        public void OnLocationUpdate(LocationFix fix)
        {
            if (Tracker == null || _submitting)
            {
                return;
            }

            if (Tracker.Update(fix) == DwellState.Satisfied && Tracker.CompletionFix.HasValue)
            {
                _submitting = true;
                OnChallengeCompleted?.Invoke(_pin, Tracker.CompletionFix.Value);
            }
        }

        /// <summary>The server said no (e.g. a stale position): dwell again from scratch.</summary>
        public void ResetAfterRejection()
        {
            Tracker?.Reset();
            _submitting = false;
        }
    }
}
