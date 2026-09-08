using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// Picks real depth-based occlusion where the device supports it, and a distance-based
    /// visual fallback everywhere else, so gameplay stays fair across device tiers rather than
    /// gating occlusion quality on hardware. This is a polish/fairness concern, not a
    /// gameplay-blocking one — proximity_dwell doesn't require line-of-sight to a pin.
    /// Requirements: SR-VIS-01 (hardware occlusion), SR-VIS-02 (fallback).
    /// </summary>
    public class OcclusionFallbackController : MonoBehaviour
    {
        [SerializeField] private Renderer pinRenderer;
        [SerializeField] private float fadeStartDistanceMeters = 15f; // [ASSUMED in spec — confirm]

        private bool _hasHardwareDepth;

        private void Start()
        {
            // TODO: query AR Foundation's AROcclusionManager for environment depth support
            // (works on many non-LiDAR Android devices via stereo estimation, not just
            // LiDAR/ToF). Set _hasHardwareDepth accordingly.
        }

        private void Update()
        {
            if (_hasHardwareDepth)
            {
                // SR-VIS-01: handled by the AR occlusion shader/AROcclusionManager directly —
                // nothing to do here per-frame beyond making sure it's enabled.
                return;
            }

            ApplyDistanceFade();
        }

        private void ApplyDistanceFade()
        {
            // SR-VIS-02: opacity fade + slight scale-down beyond fadeStartDistanceMeters.
            // TODO: compute distance from camera to this pin, drive a shader property or
            // material alpha. Exact cue styling (fade vs. outline vs. scale) is a visual-design
            // decision, not fixed by the requirements doc — this is a placeholder default.
        }
    }
}
