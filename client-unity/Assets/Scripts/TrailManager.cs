using System;
using System.Collections.Generic;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// Fetches a trail definition (cached per SR-NET-01), tracks the player's current attempt,
    /// and enforces GDR-01's sequencing rule: pin N+1 stays locked until pin N is completed.
    /// Requirements: GDR-01, GDR-06 (replay creates a new attempt), GDR-07 (versioning).
    /// </summary>
    public class TrailManager : MonoBehaviour
    {
        [SerializeField] private string trailId;

        private TrailDefinition _trail;
        private string _attemptId;
        private int _currentPinIndex;

        public event Action<PinDefinition> OnPinUnlocked;
        public event Action OnTrailCompleted;

        /// <summary>
        /// Loads the trail from local cache if present (SR-NET-01), otherwise fetches from the
        /// server. Does not require connectivity to browse an already-cached trail.
        /// </summary>
        public void LoadTrail(string id)
        {
            trailId = id;
            // TODO: check local cache (e.g. PlayerPrefs/local file) for a previously downloaded
            // trail snapshot; else call the server's GET /api/v1/trails/{trailId} and cache the
            // result. Cache is the trail *version* that was current at download time.
        }

        /// <summary>
        /// Starts a new attempt (GDR-06). Replaying a completed trail calls this again rather
        /// than mutating the existing attempt, so completion history is never overwritten.
        /// </summary>
        public void StartNewAttempt()
        {
            _currentPinIndex = 0;
            // TODO: POST to create a trail_attempts row server-side; store the returned
            // attemptId locally. The attempt snapshots trail_version_id at this moment (GDR-07) —
            // if the Admin edits the trail after this, this attempt keeps playing the old version.
        }

        /// <summary>
        /// Called after a pin's challenge (see ProximityDwellChallenge, etc.) reports completion.
        /// Advances the sequence and fires OnPinUnlocked for the next pin, or OnTrailCompleted
        /// if that was the last one (GDR-04).
        /// </summary>
        public void OnPinCompleted(PinDefinition completedPin)
        {
            // TODO: verify completedPin.sequenceIndex == _currentPinIndex before advancing —
            // never trust the client alone for this; the server enforces it too (see pins.ts).
            _currentPinIndex++;

            if (_trail != null && _currentPinIndex < _trail.pins.Count)
            {
                OnPinUnlocked?.Invoke(_trail.pins[_currentPinIndex]);
            }
            else
            {
                OnTrailCompleted?.Invoke();
            }
        }
    }

    [Serializable]
    public class TrailDefinition
    {
        public string trailId;
        public string trailVersionId;
        public List<PinDefinition> pins;
    }

    [Serializable]
    public class PinDefinition
    {
        public string pinId;
        public int sequenceIndex;
        public double lat;
        public double lng;
        public double? alt;
        public double radiusMeters;
        public string challengeType; // "proximity_dwell" | "photo_confirmation" | "code_entry"
    }
}
