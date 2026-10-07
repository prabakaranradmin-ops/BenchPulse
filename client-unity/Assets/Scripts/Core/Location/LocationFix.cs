using System;

namespace ArQuestTrail.Core
{
    public enum PositionSource
    {
        Unavailable,

        /// <summary>ARCore Geospatial / VPS, meeting SR-GEO-03's thresholds.</summary>
        Vps,

        /// <summary>Device GPS: SR-NET-03's reduced-precision fallback.</summary>
        GpsFallback,

        /// <summary>The Editor walk simulator. Never produced on a device.</summary>
        Simulated,
    }

    /// <summary>One position report, carrying the accuracy the source actually claimed.</summary>
    public readonly struct LocationFix
    {
        public LocationFix(
            double lat,
            double lng,
            double accuracyM,
            DateTimeOffset recordedAt,
            PositionSource source = PositionSource.GpsFallback,
            double? alt = null)
        {
            Lat = lat;
            Lng = lng;
            AccuracyM = accuracyM;
            // Wire timestamps carry milliseconds; trimming here means the instant a fix is judged
            // at locally is exactly the instant the server sees.
            RecordedAt = IsoTime.TruncateToMilliseconds(recordedAt);
            Source = source;
            Alt = alt;
        }

        public double Lat { get; }
        public double Lng { get; }
        public double? Alt { get; }

        /// <summary>Horizontal accuracy in metres — never tightened to flatter the UI (SR-NET-03).</summary>
        public double AccuracyM { get; }

        /// <summary>When the fix was <em>captured</em>, which for offline play is not "now" (SR-NET-02).</summary>
        public DateTimeOffset RecordedAt { get; }

        public PositionSource Source { get; }

        public GeoPoint ToGeoPoint() => new GeoPoint(Lat, Lng, Alt);
    }
}
