using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// Places a single pin's AR anchor at the correct local-origin offset and toggles its
    /// visual/interactable state based on lock status.
    /// Requirements: GDR-01 (locked pins are non-interactable), SR-GEO-01 (floating origin),
    /// SR-GEO-02 (double-precision coordinate storage / single-precision render offset).
    /// </summary>
    public class PinController : MonoBehaviour
    {
        [SerializeField] private GameObject pinVisual;
        [SerializeField] private OcclusionFallbackController occlusionController;

        private PinDefinition _definition;
        private bool _isUnlocked;

        public void Initialize(PinDefinition definition, Vector3d originGeo)
        {
            _definition = definition;

            // SR-GEO-02: compute this pin's position as a double-precision offset from the
            // scene's current floating origin, then cast down to single precision only for the
            // final Unity Transform assignment. Do not do this arithmetic in single precision.
            // TODO: replace with real geodetic-to-local-tangent-plane conversion (e.g. via
            // Cesium for Unity's georeference component) rather than a naive lat/lng delta.
            transform.position = ComputeLocalOffset(definition, originGeo);

            SetLocked(definition.sequenceIndex != 0); // only the first pin starts unlocked
        }

        public void SetLocked(bool locked)
        {
            _isUnlocked = !locked;
            if (pinVisual != null) pinVisual.SetActive(_isUnlocked);
            // A locked pin still exists in the scene graph (so the distance-fade fallback in
            // OcclusionFallbackController has something to fade), it's just non-interactable.
        }

        /// <summary>Re-evaluated every frame the scene's floating origin shifts (SR-GEO-01).</summary>
        public void OnOriginShifted(Vector3d newOrigin)
        {
            transform.position = ComputeLocalOffset(_definition, newOrigin);
        }

        private Vector3 ComputeLocalOffset(PinDefinition definition, Vector3d originGeo)
        {
            // TODO: real implementation. Placeholder keeps this compiling as a stub.
            return Vector3.zero;
        }
    }

    /// <summary>Minimal double-precision vector — Unity's Vector3 is single precision (SR-GEO-02
    /// exists specifically because that's not enough for absolute geographic coordinates).</summary>
    public struct Vector3d
    {
        public double x, y, z;
        public Vector3d(double x, double y, double z) { this.x = x; this.y = y; this.z = z; }
    }
}
