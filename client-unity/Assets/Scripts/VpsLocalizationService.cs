using System;
using ArQuestTrail.Core;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// Combines ARCore Geospatial (VPS) with GPS each frame and publishes the position gameplay
    /// should use. The decision itself — SR-GEO-03's thresholds, SR-NET-03's timed fallback, never
    /// tightening GPS's accuracy figure — is <see cref="PositionSourceSelector"/>, which is unit
    /// tested in Core; this component only feeds it Unity's inputs.
    /// </summary>
    public class VpsLocalizationService : MonoBehaviour
    {
        [Tooltip("Seconds to wait for VPS before SR-NET-03's GPS fallback. [ASSUMED: 5s] — ARCore " +
                 "Geospatial often needs longer to reach 0.5m; the selector switches back the moment it does.")]
        [SerializeField] private float vpsTimeoutSeconds = 5f;

        private PositionSourceSelector _selector;
        private ILocationSource _gps;

        public PositionEstimate Current { get; private set; }

        public string GpsStatus => _gps?.Status ?? "No location source";

        public event Action<PositionEstimate> OnPositionUpdated;

        public void Initialize(ILocationSource gps)
        {
            _gps = gps;
            _selector = new PositionSourceSelector(TimeSpan.FromSeconds(vpsTimeoutSeconds));
            RequestLocalization();
        }

        /// <summary>Restart the VPS wait — on launch and every return to the foreground.</summary>
        public void RequestLocalization()
        {
            _selector?.RequestLocalization(DateTimeOffset.UtcNow);
        }

        private void Update()
        {
            if (_selector == null)
            {
                return;
            }

            VpsReading? vps = ArIntegrations.Geospatial?.CurrentReading;
            Current = _selector.Update(vps, _gps?.Latest, DateTimeOffset.UtcNow);
            OnPositionUpdated?.Invoke(Current);
        }
    }
}
