using System;
using System.Collections.Generic;

namespace ArQuestTrail.Core
{
    /// <summary>
    /// SR-SEC-02's input. The server judges average speed over a trailing window, so every
    /// completion carries the fixes leading up to it — including ones captured offline, which the
    /// server could not have seen any other way (SR-NET-02).
    /// </summary>
    public sealed class LocationHistoryBuffer
    {
        /// <summary>The server's <c>recentLocationHistory</c> schema caps the array at this.</summary>
        public const int MaxSamples = 500;

        /// <summary>Matches the server's SANITY_LOOKBACK_SECONDS; it ignores anything older anyway.</summary>
        public static readonly TimeSpan DefaultWindow = TimeSpan.FromSeconds(120);

        private readonly List<LocationFix> _fixes = new List<LocationFix>();
        private readonly TimeSpan _window;

        public LocationHistoryBuffer(TimeSpan? window = null)
        {
            _window = window ?? DefaultWindow;
        }

        /// <summary>
        /// When the app last came to the foreground. SR-SEC-02 suspends its check for 15 seconds
        /// after that to absorb GPS settling drift — and only the client knows when it was.
        /// </summary>
        public DateTimeOffset? SessionStartedAt { get; private set; }

        public int Count => _fixes.Count;

        /// <summary>Call on launch and on every return to the foreground.</summary>
        public void MarkSessionStarted(DateTimeOffset at)
        {
            SessionStartedAt = IsoTime.TruncateToMilliseconds(at);
        }

        public void Add(LocationFix fix)
        {
            // The server dedupes by capture timestamp, and a fix that isn't newer than the last one
            // carries no movement information — sending it would only spend the 500-sample budget.
            if (_fixes.Count > 0 && fix.RecordedAt <= _fixes[_fixes.Count - 1].RecordedAt)
            {
                return;
            }

            _fixes.Add(fix);

            DateTimeOffset cutoff = fix.RecordedAt - _window;
            int stale = 0;
            while (stale < _fixes.Count && _fixes[stale].RecordedAt < cutoff)
            {
                stale++;
            }

            int overflow = Math.Max(0, _fixes.Count - stale - MaxSamples);
            _fixes.RemoveRange(0, stale + overflow);
        }

        /// <summary>The fixes inside the window ending at <paramref name="upTo"/>, oldest first.</summary>
        public IReadOnlyList<LocationFix> Snapshot(DateTimeOffset upTo)
        {
            DateTimeOffset cutoff = upTo - _window;
            var result = new List<LocationFix>();
            foreach (LocationFix fix in _fixes)
            {
                if (fix.RecordedAt >= cutoff && fix.RecordedAt <= upTo)
                {
                    result.Add(fix);
                }
            }

            return result;
        }

        public void Clear()
        {
            _fixes.Clear();
            SessionStartedAt = null;
        }
    }
}
