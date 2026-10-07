using System;
using System.Collections;
using ArQuestTrail.Core;
using UnityEngine;
#if UNITY_ANDROID
using UnityEngine.Android;
#endif

namespace ArQuestTrail
{
    /// <summary>Where gameplay's raw GPS-class fixes come from: the device, or the Editor simulator.</summary>
    public interface ILocationSource
    {
        /// <summary>The most recent fix, or null before the first one.</summary>
        LocationFix? Latest { get; }

        string Status { get; }
    }

    /// <summary>
    /// The device's location service (SR-NET-03's fallback source). Unity reports coordinates as
    /// floats — about 1m of resolution at worst, well inside GPS's own error, which is why this is
    /// tolerable here and would not be for VPS (SR-GEO-02).
    /// </summary>
    public sealed class DeviceGpsSource : ILocationSource
    {
        public string Status { get; private set; } = "GPS not started";

        public LocationFix? Latest
        {
            get
            {
                if (Input.location.status != LocationServiceStatus.Running)
                {
                    return null;
                }

                LocationInfo data = Input.location.lastData;
                return new LocationFix(
                    data.latitude,
                    data.longitude,
                    data.horizontalAccuracy,
                    DateTimeOffset.FromUnixTimeMilliseconds((long)(data.timestamp * 1000)),
                    PositionSource.GpsFallback,
                    data.altitude);
            }
        }

        /// <summary>Run as a coroutine: asks for permission, starts the service, and waits for it.</summary>
        public IEnumerator Start(float desiredAccuracyM = 2f, float updateDistanceM = 0.5f)
        {
#if UNITY_ANDROID
            if (!Permission.HasUserAuthorizedPermission(Permission.FineLocation))
            {
                Permission.RequestUserPermission(Permission.FineLocation);
                float waited = 0;
                while (!Permission.HasUserAuthorizedPermission(Permission.FineLocation) && waited < 30f)
                {
                    waited += Time.unscaledDeltaTime;
                    yield return null;
                }
            }
#endif
            if (!Input.location.isEnabledByUser)
            {
                Status = "Location is turned off for this app";
                yield break;
            }

            Input.location.Start(desiredAccuracyM, updateDistanceM);
            float elapsed = 0;
            while (Input.location.status == LocationServiceStatus.Initializing && elapsed < 20f)
            {
                elapsed += Time.unscaledDeltaTime;
                Status = "Starting GPS…";
                yield return null;
            }

            Status = Input.location.status == LocationServiceStatus.Running
                ? "GPS running"
                : "GPS unavailable (" + Input.location.status + ")";
        }
    }

    /// <summary>
    /// A walking player for the Editor, where there is no GPS: reports 4m-accurate fixes once a
    /// second, can be nudged, or can walk itself to a target at a realistic pace — slowly enough
    /// that SR-SEC-02 sees a pedestrian, not a teleport.
    /// </summary>
    public sealed class SimulatedWalker : ILocationSource
    {
        public const double WalkingSpeedMps = 1.4;

        private GeoPoint _position;
        private DateTimeOffset _lastFixAt;
        private LocationFix? _latest;

        public SimulatedWalker(GeoPoint start)
        {
            _position = start;
        }

        public string Status => Target.HasValue ? "Simulated walk — heading to the pin" : "Simulated position";

        public LocationFix? Latest => _latest;

        /// <summary>Where to walk to; null to stand still.</summary>
        public GeoPoint? Target { get; set; }

        public GeoPoint Position => _position;

        public void Nudge(double eastMeters, double northMeters)
        {
            _position = GeoMath.FromEnu(_position, new EnuOffset(eastMeters, northMeters, 0));
        }

        public void Teleport(GeoPoint to) => _position = to;

        /// <summary>Call every frame.</summary>
        public void Tick(DateTimeOffset now, float deltaTime)
        {
            if (Target.HasValue)
            {
                EnuOffset toTarget = GeoMath.ToEnu(_position, Target.Value);
                double remaining = toTarget.HorizontalDistance;
                double step = WalkingSpeedMps * deltaTime;
                if (remaining <= step)
                {
                    _position = Target.Value;
                }
                else
                {
                    double scale = step / remaining;
                    _position = GeoMath.FromEnu(_position, new EnuOffset(toTarget.East * scale, toTarget.North * scale, 0));
                }
            }

            if (now - _lastFixAt >= TimeSpan.FromSeconds(1))
            {
                _lastFixAt = now;
                _latest = new LocationFix(_position.Lat, _position.Lng, 4, now, PositionSource.Simulated);
            }
        }
    }
}
