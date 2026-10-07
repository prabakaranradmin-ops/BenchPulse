using System;
using System.Collections.Generic;
using ArQuestTrail.Core;
using Google.XR.ARCoreExtensions;
using UnityEngine;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

namespace ArQuestTrail
{
    /// <summary>
    /// VPS through ARCore Geospatial (SR-GEO-03) and geospatial anchors for pins (CR-01).
    ///
    /// This is the one file written against ARCore Extensions' API without a compiler to check it
    /// (it was authored outside Unity). It targets the 1.3x+ surface — AREarthManager,
    /// GeospatialPose.OrientationYawAccuracy, ARAnchorManager.AddAnchor(lat, lng, alt, rotation).
    /// If your installed version differs, this file is where the compile errors will be, and
    /// nothing else depends on its internals.
    ///
    /// Add it to the XR Origin alongside AREarthManager and ARAnchorManager, and enable
    /// Geospatial in the ARCore Extensions config (see client-unity/README.md).
    /// </summary>
    public sealed class ArCoreGeospatialProvider : MonoBehaviour, IGeospatialProvider
    {
        [SerializeField] private AREarthManager earthManager;
        [SerializeField] private ARAnchorManager anchorManager;

        [Tooltip("When a pin has no authored altitude (multi-level pins are out of scope for v1), " +
                 "stand it this far below the phone — roughly the ground under a held device.")]
        [SerializeField] private float assumedDeviceHeightMeters = 1.5f;

        private readonly Dictionary<string, ARGeospatialAnchor> _anchors = new Dictionary<string, ARGeospatialAnchor>();
        private FeatureSupported _support = FeatureSupported.Unknown;

        public VpsReading? CurrentReading
        {
            get
            {
                if (earthManager == null)
                {
                    return null;
                }

                DateTimeOffset now = DateTimeOffset.UtcNow;
                if (_support == FeatureSupported.Unknown)
                {
                    _support = earthManager.IsGeospatialModeSupported(GeospatialMode.Enabled);
                }

                // An unsupported device, or an EarthState error (API key / authorization / config),
                // won't fix itself by waiting — report it so SR-NET-03's fallback starts at once.
                if (_support == FeatureSupported.Unsupported || earthManager.EarthState != EarthState.Enabled)
                {
                    return VpsReading.Unsupported(now);
                }

                if (earthManager.EarthTrackingState != TrackingState.Tracking)
                {
                    return new VpsReading(true, false, 0, 0, 0, double.PositiveInfinity, double.PositiveInfinity, now);
                }

                GeospatialPose pose = earthManager.CameraGeospatialPose;
                return new VpsReading(
                    true,
                    true,
                    pose.Latitude,
                    pose.Longitude,
                    pose.Altitude,
                    pose.HorizontalAccuracy,
                    pose.OrientationYawAccuracy,
                    now);
            }
        }

        public Transform PlaceAnchor(string pinId, double lat, double lng, double? alt)
        {
            if (_anchors.TryGetValue(pinId, out ARGeospatialAnchor existing) && existing != null)
            {
                return existing.transform;
            }

            if (anchorManager == null || earthManager == null || earthManager.EarthTrackingState != TrackingState.Tracking)
            {
                return null;
            }

            // WGS84 ellipsoid height, as ARCore expects. An authored altitude is used as-is.
            double altitude = alt ?? earthManager.CameraGeospatialPose.Altitude - assumedDeviceHeightMeters;
            ARGeospatialAnchor anchor = anchorManager.AddAnchor(lat, lng, altitude, Quaternion.identity);
            if (anchor == null)
            {
                return null;
            }

            _anchors[pinId] = anchor;
            return anchor.transform;
        }

        public void RemoveAnchor(string pinId)
        {
            if (_anchors.TryGetValue(pinId, out ARGeospatialAnchor anchor))
            {
                if (anchor != null)
                {
                    Destroy(anchor.gameObject);
                }

                _anchors.Remove(pinId);
            }
        }

        private void Awake()
        {
            // Explicit null checks, not ??: Unity's "fake null" for missing components defeats ??.
            if (earthManager == null)
            {
                earthManager = FindFirstObjectByType<AREarthManager>();
            }

            if (anchorManager == null)
            {
                anchorManager = FindFirstObjectByType<ARAnchorManager>();
            }
        }

        private void OnEnable()
        {
            ArIntegrations.Geospatial = this;
        }

        private void OnDisable()
        {
            if (ReferenceEquals(ArIntegrations.Geospatial, this))
            {
                ArIntegrations.Geospatial = null;
            }
        }
    }
}
