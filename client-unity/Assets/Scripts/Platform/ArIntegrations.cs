using ArQuestTrail.Core;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// VPS (ARCore Geospatial). Implemented in the optional ArQuestTrail.ARCore assembly, which
    /// only compiles once ARCore Extensions is installed — so this project builds and runs in the
    /// Editor before any AR package is present, and lights up when one is.
    /// </summary>
    public interface IGeospatialProvider
    {
        /// <summary>This frame's VPS state, or null when there is nothing to report yet.</summary>
        VpsReading? CurrentReading { get; }

        /// <summary>
        /// Anchors a pin at its real-world coordinates (CR-01) and returns the transform to parent
        /// its visual under, or null if it can't be placed right now.
        /// </summary>
        Transform PlaceAnchor(string pinId, double lat, double lng, double? alt);

        void RemoveAnchor(string pinId);
    }

    /// <summary>Environment depth (SR-VIS-01). Implemented in the optional ArQuestTrail.ARFoundation assembly.</summary>
    public interface IDepthCapabilityProvider
    {
        /// <summary>True once real depth-based occlusion is actually running on this device.</summary>
        bool HasEnvironmentDepth { get; }
    }

    /// <summary>Where the optional assemblies register themselves; the main assembly never references them.</summary>
    public static class ArIntegrations
    {
        public static IGeospatialProvider Geospatial { get; set; }

        public static IDepthCapabilityProvider Depth { get; set; }
    }
}
