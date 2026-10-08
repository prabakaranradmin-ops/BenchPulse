using System.Collections.Generic;
using Newtonsoft.Json;

namespace ArQuestTrail.Core
{
    // Wire shapes for server/src/routes/*.ts. Property names map to the API's camelCase through
    // Json.Settings; timestamps stay ISO strings (see IsoTime).

    public sealed class TokenRequest
    {
        public string DeviceKey { get; set; }
    }

    /// <summary>POST /api/v1/players/token (ST-2.6).</summary>
    public sealed class TokenResponse
    {
        public string UserId { get; set; }
        public string Token { get; set; }
        public int ExpiresInSeconds { get; set; }
    }

    /// <summary>GET /api/v1/trails/:trailId and .../versions/:trailVersionId (SR-NET-01, GDR-07).</summary>
    public sealed class TrailDto
    {
        public string TrailId { get; set; }
        public string Name { get; set; }

        /// <summary>GDR-08: null means no expiry.</summary>
        public int? ExpiryDays { get; set; }

        public string TrailVersionId { get; set; }
        public int? VersionNumber { get; set; }

        /// <summary>False when this is a version the Admin has since replaced.</summary>
        public bool IsCurrentVersion { get; set; } = true;

        public List<PinDto> Pins { get; set; } = new List<PinDto>();
    }

    public sealed class PinDto
    {
        public string PinId { get; set; }
        public int SequenceIndex { get; set; }
        public double Lat { get; set; }
        public double Lng { get; set; }
        public double? Alt { get; set; }
        public double RadiusM { get; set; }
        public string ChallengeType { get; set; }

        /// <summary>The allowlisted, player-safe part of the authored challenge (never a code answer).</summary>
        public ChallengeInfo Challenge { get; set; } = new ChallengeInfo();
    }

    /// <summary>CR-05: what a player sees on inspecting a pin. Keys are snake_case on the wire.</summary>
    public sealed class ChallengeInfo
    {
        [JsonProperty("dwell_seconds")]
        public int? DwellSeconds { get; set; }

        [JsonProperty("hint")]
        public string Hint { get; set; }

        [JsonProperty("prompt")]
        public string Prompt { get; set; }

        [JsonProperty("code_length")]
        public int? CodeLength { get; set; }
    }

    /// <summary>GET /api/v1/join/:code (ST-2.10): the trail a join code points at.</summary>
    public sealed class JoinedTrailDto
    {
        public string TrailId { get; set; }
        public string Name { get; set; }

        /// <summary>Formatted, e.g. "ABCD-EFGH".</summary>
        public string JoinCode { get; set; }

        public int PinCount { get; set; }

        /// <summary>GDR-08: null means no time limit.</summary>
        public int? ExpiryDays { get; set; }
    }

    public sealed class StartAttemptRequest
    {
        public string TrailId { get; set; }
    }

    /// <summary>POST /api/v1/attempts and GET /api/v1/attempts/:attemptId.</summary>
    public sealed class AttemptDto
    {
        public string AttemptId { get; set; }
        public string TrailId { get; set; }

        /// <summary>GDR-07: the version this attempt is playing, which may no longer be current.</summary>
        public string TrailVersionId { get; set; }

        /// <summary>"active" | "completed" | "expired".</summary>
        public string Status { get; set; }

        public string StartedAt { get; set; }
        public string CompletedAt { get; set; }

        /// <summary>GDR-01: the one pin the player may interact with, or null.</summary>
        public string CurrentPinId { get; set; }

        public List<AttemptPinDto> Pins { get; set; } = new List<AttemptPinDto>();
    }

    public sealed class AttemptPinDto
    {
        public string PinId { get; set; }
        public int SequenceIndex { get; set; }

        /// <summary>"locked" | "unlocked" | "completed".</summary>
        public string Status { get; set; }
    }

    /// <summary>POST /api/v1/attempts/:attemptId/pins/:pinId/complete body.</summary>
    public sealed class CompletionRequest
    {
        public double Lat { get; set; }
        public double Lng { get; set; }
        public double AccuracyM { get; set; }

        /// <summary>SR-NET-02: when the fix was captured — for a queued completion, not "now".</summary>
        public string RecordedAt { get; set; }

        /// <summary>SR-SEC-02 cold-start grace is measured from this.</summary>
        public string SessionStartedAt { get; set; }

        public List<LocationSampleDto> RecentLocationHistory { get; set; }

        /// <summary>ST-6.2: a code_entry answer. Omitted (not null) for other challenge types.</summary>
        public string ChallengeAnswer { get; set; }
    }

    public sealed class LocationSampleDto
    {
        public double Lat { get; set; }
        public double Lng { get; set; }
        public double? AccuracyM { get; set; }
        public string RecordedAt { get; set; }
    }

    public sealed class CompletionResponse
    {
        public string AttemptId { get; set; }
        public string PinId { get; set; }
        public string Status { get; set; }

        /// <summary>Null when this was the final pin (GDR-04).</summary>
        public string NextPinId { get; set; }

        public string AttemptStatus { get; set; }
        public double EffectiveRadiusM { get; set; }
        public double DistanceM { get; set; }

        /// <summary>Non-null when SR-SEC-02 flagged the movement. The completion still stands.</summary>
        public LocationFlagDto LocationFlag { get; set; }
    }

    public sealed class LocationFlagDto
    {
        public string Reason { get; set; }
        public double? AvgSpeedMps { get; set; }
    }

    public sealed class PinReportRequest
    {
        public string Note { get; set; }
    }

    /// <summary>POST /api/v1/pins/:pinId/report (GDR-09).</summary>
    public sealed class PinReportResponse
    {
        public string ReportId { get; set; }
    }

    /// <summary>DELETE /api/v1/players/me (SR-PRIV-02).</summary>
    public sealed class DeleteMyDataResponse
    {
        public DeletedCounts Deleted { get; set; }
        public bool DiscardDeviceKey { get; set; }
    }

    public sealed class DeletedCounts
    {
        public int LocationSamples { get; set; }
        public int Attempts { get; set; }
        public bool Player { get; set; }
    }

    /// <summary>Every non-2xx response carries at least <c>error</c>; completion rejections carry more.</summary>
    public sealed class ApiErrorBody
    {
        public string Error { get; set; }
        public string Message { get; set; }
        public double? EffectiveRadiusM { get; set; }
        public double? DistanceM { get; set; }
        public double? AccuracyM { get; set; }
        public string ChallengeType { get; set; }
        public string AttemptStatus { get; set; }
    }
}
