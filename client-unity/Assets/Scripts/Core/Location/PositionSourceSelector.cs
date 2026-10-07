using System;

namespace ArQuestTrail.Core
{
    public enum LocalizationStatus
    {
        /// <summary>Neither VPS nor a fresh GPS fix — nothing to play against.</summary>
        Unavailable,

        /// <summary>VPS is working on a fix. Play can continue on GPS, but no pin is anchored yet.</summary>
        Localizing,

        /// <summary>VPS meets SR-GEO-03: pins may be rendered as anchored AR objects.</summary>
        Vps,

        /// <summary>SR-NET-03: VPS failed or timed out; GPS only, and the UI must say so.</summary>
        GpsFallback,
    }

    /// <summary>What the VPS provider (ARCore Geospatial) reports for one frame.</summary>
    public readonly struct VpsReading
    {
        public VpsReading(
            bool isSupported,
            bool isTracking,
            double lat,
            double lng,
            double alt,
            double horizontalAccuracyM,
            double headingAccuracyDeg,
            DateTimeOffset recordedAt)
        {
            IsSupported = isSupported;
            IsTracking = isTracking;
            Lat = lat;
            Lng = lng;
            Alt = alt;
            HorizontalAccuracyM = horizontalAccuracyM;
            HeadingAccuracyDeg = headingAccuracyDeg;
            RecordedAt = recordedAt;
        }

        /// <summary>False when the device or location can't do VPS at all — fall back immediately.</summary>
        public bool IsSupported { get; }

        public bool IsTracking { get; }
        public double Lat { get; }
        public double Lng { get; }
        public double Alt { get; }
        public double HorizontalAccuracyM { get; }
        public double HeadingAccuracyDeg { get; }
        public DateTimeOffset RecordedAt { get; }

        public static VpsReading Unsupported(DateTimeOffset at) =>
            new VpsReading(false, false, 0, 0, 0, double.PositiveInfinity, double.PositiveInfinity, at);
    }

    public readonly struct PositionEstimate
    {
        public PositionEstimate(LocalizationStatus status, LocationFix? fix)
        {
            Status = status;
            Fix = fix;
        }

        public LocalizationStatus Status { get; }

        /// <summary>The fix gameplay should use, or null when there is none.</summary>
        public LocationFix? Fix { get; }

        /// <summary>SR-GEO-03: anchored AR pins only once VPS meets its accuracy thresholds.</summary>
        public bool CanRenderAnchoredPins => Status == LocalizationStatus.Vps;

        /// <summary>SR-NET-03 / CR-04: true whenever play is running on anything less than VPS.</summary>
        public bool IsReducedPrecision => Fix.HasValue && Fix.Value.Source != PositionSource.Vps;
    }

    /// <summary>
    /// Decides, frame by frame, which position source gameplay uses (SR-GEO-03, SR-NET-03).
    ///
    /// The rule that matters most: a GPS fix keeps GPS's own accuracy figure all the way through
    /// to the SR-GEO-04 check. Reporting a tighter number to make the UI look better would let a
    /// player complete a pin from further away than the server will accept.
    /// </summary>
    public sealed class PositionSourceSelector
    {
        /// <summary>SR-GEO-03.</summary>
        public const double MaxVpsHorizontalAccuracyM = 0.5;

        /// <summary>SR-GEO-03.</summary>
        public const double MaxVpsHeadingAccuracyDeg = 5.0;

        /// <summary>How long to wait on VPS before SR-NET-03's fallback <c>[ASSUMED: 5s]</c>.</summary>
        public static readonly TimeSpan DefaultVpsTimeout = TimeSpan.FromSeconds(5);

        /// <summary>A GPS fix older than this is treated as absent rather than as where the player is.</summary>
        public static readonly TimeSpan DefaultMaxGpsAge = TimeSpan.FromSeconds(15);

        private readonly TimeSpan _vpsTimeout;
        private readonly TimeSpan _maxGpsAge;
        private DateTimeOffset? _waitingForVpsSince;

        public PositionSourceSelector(TimeSpan? vpsTimeout = null, TimeSpan? maxGpsAge = null)
        {
            _vpsTimeout = vpsTimeout ?? DefaultVpsTimeout;
            _maxGpsAge = maxGpsAge ?? DefaultMaxGpsAge;
        }

        /// <summary>Restarts the VPS wait — call on launch and after the app returns to the foreground.</summary>
        public void RequestLocalization(DateTimeOffset now)
        {
            _waitingForVpsSince = now;
        }

        public PositionEstimate Update(VpsReading? vps, LocationFix? gps, DateTimeOffset now)
        {
            if (!_waitingForVpsSince.HasValue)
            {
                _waitingForVpsSince = now;
            }

            LocationFix? freshGps = gps.HasValue && now - gps.Value.RecordedAt <= _maxGpsAge ? gps : null;

            if (vps.HasValue && MeetsVpsThresholds(vps.Value))
            {
                VpsReading reading = vps.Value;
                // A later loss of VPS gets a fresh timeout from this moment, not from launch —
                // that is what lets tracking recover quickly after an interruption (§6.8).
                _waitingForVpsSince = now;
                var fix = new LocationFix(
                    reading.Lat,
                    reading.Lng,
                    reading.HorizontalAccuracyM,
                    reading.RecordedAt,
                    PositionSource.Vps,
                    reading.Alt);
                return new PositionEstimate(LocalizationStatus.Vps, fix);
            }

            bool vpsCouldStillArrive = vps.HasValue && vps.Value.IsSupported
                && now - _waitingForVpsSince.Value < _vpsTimeout;
            if (vpsCouldStillArrive)
            {
                // Don't hold a player hostage to VPS: if they're standing on the pin with good GPS,
                // gameplay can proceed on GPS while VPS settles — it just isn't anchored yet.
                return new PositionEstimate(LocalizationStatus.Localizing, freshGps);
            }

            if (freshGps.HasValue)
            {
                return new PositionEstimate(LocalizationStatus.GpsFallback, freshGps);
            }

            return new PositionEstimate(LocalizationStatus.Unavailable, null);
        }

        public static bool MeetsVpsThresholds(VpsReading reading) =>
            reading.IsSupported
            && reading.IsTracking
            && reading.HorizontalAccuracyM <= MaxVpsHorizontalAccuracyM
            && reading.HeadingAccuracyDeg <= MaxVpsHeadingAccuracyDeg;
    }
}
