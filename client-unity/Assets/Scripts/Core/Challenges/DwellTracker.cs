using System;

namespace ArQuestTrail.Core
{
    public enum DwellState
    {
        WaitingForFix,

        /// <summary>SR-GEO-04: accuracy is past the ceiling — show "GPS signal weak — move to open sky".</summary>
        WeakSignal,

        /// <summary>Outside the effective radius — show "move closer" with the distance.</summary>
        OutsideRadius,

        Dwelling,

        /// <summary>Latched: the dwell is done and <see cref="DwellTracker.CompletionFix"/> is what to submit.</summary>
        Satisfied,
    }

    /// <summary>
    /// GDR-02's <c>proximity_dwell</c>: stay inside the pin's effective radius for a minimum
    /// duration. Time is measured between fix timestamps, not frame deltas, so a dropped frame
    /// or a slow device can't stretch or shrink the dwell — and the tests can drive it exactly.
    /// </summary>
    public sealed class DwellTracker
    {
        /// <summary>
        /// A longer silence between fixes means nobody knows where the player was in between, so
        /// the dwell starts over instead of crediting the gap (e.g. the app sat in the background).
        /// </summary>
        public static readonly TimeSpan DefaultMaxFixGap = TimeSpan.FromSeconds(10);

        private readonly double _pinLat;
        private readonly double _pinLng;
        private readonly double _pinRadiusM;
        private readonly double _accuracyCeilingM;
        private readonly TimeSpan _maxFixGap;
        private DateTimeOffset? _lastFixAt;
        private DateTimeOffset? _dwellStartedAt;
        private DateTimeOffset? _lastInsideAt;

        public DwellTracker(
            double pinLat,
            double pinLng,
            double pinRadiusM,
            double requiredSeconds,
            TimeSpan? maxFixGap = null,
            double accuracyCeilingM = CompletionRules.AccuracyCeilingM)
        {
            if (requiredSeconds < 0)
            {
                throw new ArgumentOutOfRangeException(nameof(requiredSeconds));
            }

            _pinLat = pinLat;
            _pinLng = pinLng;
            _pinRadiusM = pinRadiusM;
            RequiredSeconds = requiredSeconds;
            _maxFixGap = maxFixGap ?? DefaultMaxFixGap;
            _accuracyCeilingM = accuracyCeilingM;
            State = DwellState.WaitingForFix;
        }

        public static DwellTracker ForPin(PinDto pin) =>
            new DwellTracker(
                pin.Lat,
                pin.Lng,
                pin.RadiusM,
                pin.Challenge?.DwellSeconds ?? ChallengeTypes.DefaultDwellSeconds);

        public double RequiredSeconds { get; }

        public DwellState State { get; private set; }

        public double ElapsedSeconds { get; private set; }

        public double Progress => RequiredSeconds <= 0 ? 1 : Math.Min(1, ElapsedSeconds / RequiredSeconds);

        /// <summary>The most recent verdict, for "move closer — 34m" and the weak-signal hint.</summary>
        public PositionEvaluation? LastEvaluation { get; private set; }

        /// <summary>The in-radius fix that satisfied the dwell — the one the server re-checks.</summary>
        public LocationFix? CompletionFix { get; private set; }

        public DwellState Update(LocationFix fix)
        {
            if (State == DwellState.Satisfied)
            {
                return State;
            }

            // A repeated or out-of-order fix carries no new time and must not be double-counted.
            if (_lastFixAt.HasValue && fix.RecordedAt <= _lastFixAt.Value)
            {
                return State;
            }

            _lastFixAt = fix.RecordedAt;

            PositionEvaluation evaluation = CompletionRules.Evaluate(
                _pinLat,
                _pinLng,
                _pinRadiusM,
                fix.Lat,
                fix.Lng,
                fix.AccuracyM,
                _accuracyCeilingM);
            LastEvaluation = evaluation;

            if (!evaluation.IsWithin)
            {
                // Leaving the radius resets the clock. GDR-11 forbids a forced timeout on the
                // challenge itself; this is the gameplay rule of the challenge, not a timer on it.
                ResetDwell();
                State = evaluation.Verdict == PositionVerdict.AccuracyExceedsCeiling
                    ? DwellState.WeakSignal
                    : DwellState.OutsideRadius;
                return State;
            }

            bool continuesDwell = _dwellStartedAt.HasValue
                && _lastInsideAt.HasValue
                && fix.RecordedAt - _lastInsideAt.Value <= _maxFixGap;
            if (!continuesDwell)
            {
                _dwellStartedAt = fix.RecordedAt;
            }

            _lastInsideAt = fix.RecordedAt;
            ElapsedSeconds = (fix.RecordedAt - _dwellStartedAt.Value).TotalSeconds;

            if (ElapsedSeconds >= RequiredSeconds)
            {
                State = DwellState.Satisfied;
                CompletionFix = fix;
                return State;
            }

            State = DwellState.Dwelling;
            return State;
        }

        /// <summary>Back to the start — e.g. after the server rejected the submitted completion.</summary>
        public void Reset()
        {
            ResetDwell();
            _lastFixAt = null;
            LastEvaluation = null;
            CompletionFix = null;
            State = DwellState.WaitingForFix;
        }

        private void ResetDwell()
        {
            _dwellStartedAt = null;
            _lastInsideAt = null;
            ElapsedSeconds = 0;
        }
    }
}
