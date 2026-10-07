using System;

namespace ArQuestTrail.Core
{
    public enum PositionVerdict
    {
        WithinEffectiveRadius,
        OutsideEffectiveRadius,
        AccuracyExceedsCeiling,
    }

    public readonly struct PositionEvaluation
    {
        public PositionEvaluation(PositionVerdict verdict, double effectiveRadiusM, double distanceM)
        {
            Verdict = verdict;
            EffectiveRadiusM = effectiveRadiusM;
            DistanceM = distanceM;
        }

        public PositionVerdict Verdict { get; }

        /// <summary>max(pin radius, reported accuracy), capped at the ceiling.</summary>
        public double EffectiveRadiusM { get; }

        public double DistanceM { get; }

        public bool IsWithin => Verdict == PositionVerdict.WithinEffectiveRadius;
    }

    /// <summary>
    /// SR-GEO-04, mirrored from <c>server/src/services/completion.ts</c>. On the device this is a
    /// <em>prediction</em> of the server's verdict — the server still decides — but if the two
    /// ever disagree, a player sees a pin complete and then un-complete, which is worse than
    /// either answer. Keep them identical, down to the strict <c>&gt;</c> comparisons.
    /// </summary>
    public static class CompletionRules
    {
        /// <summary>SR-GEO-04 <c>[ASSUMED: 50m]</c> — must equal the server's ACCURACY_CEILING_M.</summary>
        public const double AccuracyCeilingM = 50;

        public static PositionEvaluation Evaluate(
            double pinLat,
            double pinLng,
            double pinRadiusM,
            double reportedLat,
            double reportedLng,
            double reportedAccuracyM,
            double accuracyCeilingM = AccuracyCeilingM)
        {
            double distanceM = GeoMath.HaversineMeters(pinLat, pinLng, reportedLat, reportedLng);
            double effectiveRadiusM = Math.Min(Math.Max(pinRadiusM, reportedAccuracyM), accuracyCeilingM);

            if (reportedAccuracyM > accuracyCeilingM)
            {
                return new PositionEvaluation(PositionVerdict.AccuracyExceedsCeiling, effectiveRadiusM, distanceM);
            }

            if (distanceM > effectiveRadiusM)
            {
                return new PositionEvaluation(PositionVerdict.OutsideEffectiveRadius, effectiveRadiusM, distanceM);
            }

            return new PositionEvaluation(PositionVerdict.WithinEffectiveRadius, effectiveRadiusM, distanceM);
        }
    }
}
