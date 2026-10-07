using ArQuestTrail.Core;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// One pin in the AR scene. Requirements: GDR-01 (only the active pin is a target), SR-GEO-03
    /// (anchored only once VPS meets its thresholds), SR-GEO-02 (double precision until the last
    /// cast), CR-04 (never a pin drawn in a guessed place — hidden instead, with the HUD giving
    /// distance and direction).
    /// </summary>
    public class PinController : MonoBehaviour
    {
        [Tooltip("Optional. Without one, a simple marker is built so the field test needs no art.")]
        [SerializeField] private GameObject pinVisual;

        [SerializeField] private OcclusionFallbackController occlusion;

        [Tooltip("Metres below the viewer to stand a simulated pin, so it reads as on the ground.")]
        [SerializeField] private float simulatedGroundOffset = 1.5f;

        public PinDto Pin { get; private set; }

        public PinState State { get; private set; }

        public void Initialize(PinDto pin)
        {
            Pin = pin;
            name = $"Pin {pin.SequenceIndex} ({pin.ChallengeType})";
            if (pinVisual == null)
            {
                pinVisual = BuildDefaultMarker();
            }

            if (occlusion == null)
            {
                occlusion = gameObject.AddComponent<OcclusionFallbackController>();
            }

            occlusion.SetTarget(pinVisual.transform, pinVisual.GetComponentInChildren<Renderer>());
            SetVisible(false);
        }

        public void SetState(PinState state)
        {
            State = state;
            Renderer marker = pinVisual != null ? pinVisual.GetComponentInChildren<Renderer>() : null;
            if (marker == null)
            {
                return;
            }

            // Unconfirmed completions read differently from the live target (ST-9.2).
            marker.material.color = state switch
            {
                PinState.Active => new Color(0.2f, 0.85f, 0.4f, 1f),
                PinState.CompletedPendingSync => new Color(0.95f, 0.75f, 0.2f, 1f),
                PinState.AwaitingVerification => new Color(0.95f, 0.75f, 0.2f, 1f),
                _ => new Color(0.6f, 0.6f, 0.6f, 1f),
            };
        }

        /// <summary>Places (or hides) the pin for this frame.</summary>
        public void UpdatePlacement(PositionEstimate estimate, Transform viewer)
        {
            bool showable = State == PinState.Active
                || State == PinState.CompletedPendingSync
                || State == PinState.AwaitingVerification;
            if (!showable || !estimate.Fix.HasValue)
            {
                SetVisible(false);
                return;
            }

            if (estimate.CanRenderAnchoredPins && ArIntegrations.Geospatial != null)
            {
                Transform anchor = ArIntegrations.Geospatial.PlaceAnchor(Pin.PinId, Pin.Lat, Pin.Lng, Pin.Alt);
                if (anchor == null)
                {
                    SetVisible(false);
                    return;
                }

                if (transform.parent != anchor)
                {
                    transform.SetParent(anchor, false);
                    transform.localPosition = Vector3.zero;
                    transform.localRotation = Quaternion.identity;
                }

                SetVisible(true);
                return;
            }

            if (estimate.Fix.Value.Source == PositionSource.Simulated && viewer != null)
            {
                // ST-3.2's local ENU offset, Editor only: doubles throughout, cast to float at the
                // last step (SR-GEO-02). Scene +X is east and +Z is north here.
                EnuOffset offset = GeoMath.ToEnu(estimate.Fix.Value.ToGeoPoint(), new GeoPoint(Pin.Lat, Pin.Lng));
                transform.SetParent(null, true);
                transform.position = viewer.position + new Vector3(
                    (float)offset.East,
                    -simulatedGroundOffset,
                    (float)offset.North);
                SetVisible(true);
                return;
            }

            // GPS-only or still localizing: an anchored pin would sit metres off its true spot.
            SetVisible(false);
        }

        public void Despawn()
        {
            ArIntegrations.Geospatial?.RemoveAnchor(Pin.PinId);
            Destroy(gameObject);
        }

        private void SetVisible(bool visible)
        {
            if (pinVisual != null && pinVisual.activeSelf != visible)
            {
                pinVisual.SetActive(visible);
            }
        }

        private GameObject BuildDefaultMarker()
        {
            var root = new GameObject("Marker");
            root.transform.SetParent(transform, false);

            GameObject post = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            post.transform.SetParent(root.transform, false);
            post.transform.localScale = new Vector3(0.3f, 1f, 0.3f);
            post.transform.localPosition = new Vector3(0, 1f, 0);
            Destroy(post.GetComponent<Collider>());

            return root;
        }
    }
}
