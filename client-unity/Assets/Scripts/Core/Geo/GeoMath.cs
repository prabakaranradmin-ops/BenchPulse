using System;

namespace ArQuestTrail.Core
{
    /// <summary>A WGS84 position. Doubles throughout — SR-GEO-02 exists because a float can't hold one.</summary>
    public readonly struct GeoPoint
    {
        public GeoPoint(double lat, double lng, double? alt = null)
        {
            Lat = lat;
            Lng = lng;
            Alt = alt;
        }

        public double Lat { get; }
        public double Lng { get; }
        public double? Alt { get; }
    }

    /// <summary>East/north/up metres from a local origin: SR-GEO-02's double-precision offset.</summary>
    public readonly struct EnuOffset
    {
        public EnuOffset(double east, double north, double up)
        {
            East = east;
            North = north;
            Up = up;
        }

        public double East { get; }
        public double North { get; }
        public double Up { get; }

        public double HorizontalDistance => Math.Sqrt(East * East + North * North);
    }

    public static class GeoMath
    {
        /// <summary>Mean earth radius — the same sphere the server measures on (EARTH_RADIUS_M).</summary>
        public const double EarthRadiusM = 6371000;

        /// <summary>Derived from the same radius, never a rounded constant, so placing and measuring agree.</summary>
        public const double MetersPerDegree = Math.PI * EarthRadiusM / 180;

        private static readonly string[] CompassPoints = { "N", "NE", "E", "SE", "S", "SW", "W", "NW" };

        /// <summary>Written exactly as the server's <c>toRad</c>, so the two round identically.</summary>
        public static double ToRadians(double degrees) => degrees * Math.PI / 180;

        /// <summary>
        /// Great-circle distance, term for term the server's <c>haversineMeters</c>. The client's
        /// "you're close enough" has to agree with the server's, or a player watches a pin complete
        /// on their screen and then get rejected.
        /// </summary>
        public static double HaversineMeters(double lat1, double lng1, double lat2, double lng2)
        {
            double dLat = ToRadians(lat2 - lat1);
            double dLng = ToRadians(lng2 - lng1);
            double phi1 = ToRadians(lat1);
            double phi2 = ToRadians(lat2);

            double sinHalfDLat = Math.Sin(dLat / 2);
            double sinHalfDLng = Math.Sin(dLng / 2);
            double h = sinHalfDLat * sinHalfDLat + Math.Cos(phi1) * Math.Cos(phi2) * sinHalfDLng * sinHalfDLng;
            return 2 * EarthRadiusM * Math.Asin(Math.Sqrt(h));
        }

        /// <summary>
        /// Local tangent-plane offset from <paramref name="origin"/>. Flat-earth, consistent with
        /// the server's <c>offsetPointEast</c>, and accurate to well under a metre across a few
        /// kilometres. SR-GEO-01's re-centring (deferred until after the ST-4.3 field test) is what
        /// keeps a longer trail inside that range.
        /// </summary>
        public static EnuOffset ToEnu(GeoPoint origin, GeoPoint point)
        {
            double north = (point.Lat - origin.Lat) * MetersPerDegree;
            double east = (point.Lng - origin.Lng) * MetersPerDegree * Math.Cos(ToRadians(origin.Lat));
            double up = point.Alt.HasValue && origin.Alt.HasValue ? point.Alt.Value - origin.Alt.Value : 0;
            return new EnuOffset(east, north, up);
        }

        /// <summary>The inverse of <see cref="ToEnu"/>.</summary>
        public static GeoPoint FromEnu(GeoPoint origin, EnuOffset offset)
        {
            double metersPerDegreeLng = MetersPerDegree * Math.Cos(ToRadians(origin.Lat));
            if (Math.Abs(metersPerDegreeLng) < 1e-6)
            {
                throw new ArgumentOutOfRangeException(nameof(origin), "Too close to a pole for an east/north offset.");
            }

            double? alt = origin.Alt.HasValue ? origin.Alt.Value + offset.Up : (double?)null;
            return new GeoPoint(
                origin.Lat + offset.North / MetersPerDegree,
                origin.Lng + offset.East / metersPerDegreeLng,
                alt);
        }

        /// <summary>Initial great-circle bearing, degrees clockwise from true north, in [0, 360).</summary>
        public static double BearingDegrees(double lat1, double lng1, double lat2, double lng2)
        {
            double phi1 = ToRadians(lat1);
            double phi2 = ToRadians(lat2);
            double dLng = ToRadians(lng2 - lng1);

            double y = Math.Sin(dLng) * Math.Cos(phi2);
            double x = Math.Cos(phi1) * Math.Sin(phi2) - Math.Sin(phi1) * Math.Cos(phi2) * Math.Cos(dLng);
            double bearing = Math.Atan2(y, x) * 180 / Math.PI;
            return (bearing + 360) % 360;
        }

        /// <summary>"N", "NE", … for a bearing — what the HUD shows when there's no anchored pin to look at.</summary>
        public static string ToCompassPoint(double bearingDegrees)
        {
            double normalized = (bearingDegrees % 360 + 360) % 360;
            int index = (int)Math.Round(normalized / 45.0) % CompassPoints.Length;
            return CompassPoints[index];
        }
    }
}
