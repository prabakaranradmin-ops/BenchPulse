using System;

namespace ArQuestTrail.Core
{
    /// <summary>
    /// SR-VIS-02's fallback cue for devices without usable depth: rather than hard occlusion, a
    /// pin fades and shrinks with distance <c>[ASSUMED: beyond ~15m]</c>. The spec leaves the
    /// exact styling to whoever designs the AR view — this is the curve, not the look.
    /// </summary>
    public readonly struct DistanceFade
    {
        public DistanceFade(double fadeStartM = 15, double fadeEndM = 60, double minAlpha = 0.25, double minScale = 0.6)
        {
            if (fadeEndM <= fadeStartM)
            {
                throw new ArgumentException("The fade has to end further away than it starts.", nameof(fadeEndM));
            }

            FadeStartM = fadeStartM;
            FadeEndM = fadeEndM;
            MinAlpha = minAlpha;
            MinScale = minScale;
        }

        public double FadeStartM { get; }
        public double FadeEndM { get; }

        /// <summary>Never zero: a pin the player is walking toward must stay findable.</summary>
        public double MinAlpha { get; }

        public double MinScale { get; }

        /// <summary>0 at or inside the fade start, 1 at or beyond the fade end.</summary>
        public double FadeAmount(double distanceM) =>
            Math.Max(0, Math.Min(1, (distanceM - FadeStartM) / (FadeEndM - FadeStartM)));

        public double Alpha(double distanceM) => 1 - FadeAmount(distanceM) * (1 - MinAlpha);

        public double Scale(double distanceM) => 1 - FadeAmount(distanceM) * (1 - MinScale);
    }
}
