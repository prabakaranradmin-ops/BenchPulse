using System;
using System.Globalization;

namespace ArQuestTrail.Core
{
    /// <summary>
    /// Timestamps on the wire. The server parses them with JavaScript's <c>new Date(...)</c>, so
    /// this emits exactly what <c>Date.prototype.toISOString()</c> produces: UTC, millisecond
    /// precision, trailing Z. SR-NET-02 depends on this round-tripping exactly — an offline
    /// completion is judged at the instant it was captured, not when it reached the server.
    /// </summary>
    public static class IsoTime
    {
        private const string WireFormat = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";

        public static string ToWire(DateTimeOffset time) =>
            time.UtcDateTime.ToString(WireFormat, CultureInfo.InvariantCulture);

        public static DateTimeOffset FromWire(string value) =>
            DateTimeOffset.Parse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal)
                .ToUniversalTime();

        /// <summary>Drops sub-millisecond precision, so a value survives a wire round trip unchanged.</summary>
        public static DateTimeOffset TruncateToMilliseconds(DateTimeOffset time) =>
            new DateTimeOffset(time.UtcTicks - time.UtcTicks % TimeSpan.TicksPerMillisecond, TimeSpan.Zero);
    }

    public interface IClock
    {
        DateTimeOffset UtcNow { get; }
    }

    public sealed class SystemClock : IClock
    {
        public static readonly SystemClock Instance = new SystemClock();

        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
    }
}
