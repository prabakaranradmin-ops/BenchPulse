using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using ArQuestTrail.Core;

namespace ArQuestTrail.Core.Tests
{
    internal sealed class FakeClock : IClock
    {
        public FakeClock(DateTimeOffset start) => UtcNow = start;

        public DateTimeOffset UtcNow { get; set; }

        public void Advance(TimeSpan by) => UtcNow += by;
    }

    /// <summary>A transport that answers from a handler and records what it was asked.</summary>
    internal sealed class FakeTransport : IHttpTransport
    {
        private readonly Func<HttpRequestSpec, HttpResponseData> _handler;

        public FakeTransport(Func<HttpRequestSpec, HttpResponseData> handler) => _handler = handler;

        public List<HttpRequestSpec> Requests { get; } = new List<HttpRequestSpec>();

        public Task<HttpResponseData> SendAsync(HttpRequestSpec request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return Task.FromResult(_handler(request));
        }

        public static HttpResponseData Respond(int status, object body) =>
            new HttpResponseData(status, body is string s ? s : Json.Serialize(body));
    }

    /// <summary>
    /// A small in-memory stand-in for the real API, implementing the rules the client depends on:
    /// token exchange, version-snapshotting attempts, GDR-01 sequencing, SR-GEO-04 position, the
    /// ST-6.2 code check, and capture-time completion stamps. The contract tests run the same
    /// flows against the real server, which is what keeps this fake honest.
    /// </summary>
    internal sealed class FakeServer
    {
        private readonly Dictionary<string, string> _usersByDeviceKey = new Dictionary<string, string>();
        private readonly Dictionary<string, string> _usersByToken = new Dictionary<string, string>();
        private readonly HashSet<string> _deletedUsers = new HashSet<string>();
        private readonly Dictionary<string, string> _currentVersionByTrail = new Dictionary<string, string>();
        private readonly Dictionary<string, TrailDto> _versions = new Dictionary<string, TrailDto>();
        private readonly Dictionary<string, string> _codes = new Dictionary<string, string>();
        private readonly Dictionary<string, FakeAttempt> _attempts = new Dictionary<string, FakeAttempt>();
        private int _ids;

        /// <summary>Every request fails as if the device had no connection.</summary>
        public bool Offline { get; set; }

        /// <summary>The next request is processed, but its reply never reaches the client.</summary>
        public bool LoseNextReply { get; set; }

        /// <summary>The next request gets this status (e.g. 500) without being processed.</summary>
        public int? FailNextWith { get; set; }

        public List<(string Path, CompletionRequest Body)> Completions { get; } = new List<(string, CompletionRequest)>();

        public List<string> Reports { get; } = new List<string>();

        public int TokensIssued { get; private set; }

        public FakeTransport Transport => new FakeTransport(Handle);

        public IReadOnlyDictionary<string, FakeAttempt> Attempts => _attempts;

        /// <summary>Publishes a version; pins listed as (lat, lng, type, code-or-null).</summary>
        public TrailDto Publish(string trailId, params (double Lat, double Lng, string Type, string Code)[] pins)
        {
            string versionId = "version-" + (++_ids);
            var trail = new TrailDto
            {
                TrailId = trailId,
                Name = "Trail " + trailId,
                TrailVersionId = versionId,
                VersionNumber = _versions.Values.Count(v => v.TrailId == trailId) + 1,
                Pins = pins.Select((p, i) => new PinDto
                {
                    PinId = versionId + "-pin-" + (i + 1),
                    SequenceIndex = i + 1,
                    Lat = p.Lat,
                    Lng = p.Lng,
                    RadiusM = 10,
                    ChallengeType = p.Type,
                    Challenge = new ChallengeInfo { DwellSeconds = p.Type == ChallengeTypes.ProximityDwell ? 15 : (int?)null },
                }).ToList(),
            };
            for (int i = 0; i < pins.Length; i++)
            {
                if (pins[i].Code != null)
                {
                    _codes[trail.Pins[i].PinId] = pins[i].Code;
                }
            }

            _versions[versionId] = trail;
            _currentVersionByTrail[trailId] = versionId;
            return trail;
        }

        public void DeleteUser(string userId) => _deletedUsers.Add(userId);

        private HttpResponseData Handle(HttpRequestSpec request)
        {
            if (Offline)
            {
                return HttpResponseData.Failed("offline");
            }

            if (FailNextWith.HasValue)
            {
                int status = FailNextWith.Value;
                FailNextWith = null;
                return FakeTransport.Respond(status, new { error = "injected" });
            }

            HttpResponseData response = Route(request);
            if (LoseNextReply)
            {
                LoseNextReply = false;
                return HttpResponseData.Failed("reply lost");
            }

            return response;
        }

        private HttpResponseData Route(HttpRequestSpec request)
        {
            string path = new Uri(request.Url).AbsolutePath;

            if (request.Method == "POST" && path == "/api/v1/players/token")
            {
                string key = Json.Deserialize<TokenRequest>(request.Body).DeviceKey;
                if (!_usersByDeviceKey.TryGetValue(key, out string userId) || _deletedUsers.Contains(userId))
                {
                    userId = "user-" + (++_ids);
                    _usersByDeviceKey[key] = userId;
                }

                string token = "token-" + (++_ids);
                _usersByToken[token] = userId;
                TokensIssued++;
                return FakeTransport.Respond(200, new TokenResponse { UserId = userId, Token = token, ExpiresInSeconds = 2592000 });
            }

            if (!request.Headers.TryGetValue("Authorization", out string auth)
                || !_usersByToken.TryGetValue(auth.Substring("Bearer ".Length), out string caller))
            {
                return FakeTransport.Respond(401, new { error = "unauthorized" });
            }

            Match match;
            if (request.Method == "GET" && (match = Regex.Match(path, "^/api/v1/trails/([^/]+)$")).Success)
            {
                string trailId = Uri.UnescapeDataString(match.Groups[1].Value);
                return _currentVersionByTrail.TryGetValue(trailId, out string versionId)
                    ? FakeTransport.Respond(200, WithCurrentFlag(_versions[versionId]))
                    : FakeTransport.Respond(404, new { error = "trail_not_found" });
            }

            if (request.Method == "GET" && (match = Regex.Match(path, "^/api/v1/trails/([^/]+)/versions/([^/]+)$")).Success)
            {
                string versionId = Uri.UnescapeDataString(match.Groups[2].Value);
                return _versions.TryGetValue(versionId, out TrailDto version)
                    ? FakeTransport.Respond(200, WithCurrentFlag(version))
                    : FakeTransport.Respond(404, new { error = "trail_version_not_found" });
            }

            if (request.Method == "POST" && path == "/api/v1/attempts")
            {
                if (_deletedUsers.Contains(caller))
                {
                    return FakeTransport.Respond(401, new { error = "player_not_found" });
                }

                string trailId = Json.Deserialize<StartAttemptRequest>(request.Body).TrailId;
                if (!_currentVersionByTrail.TryGetValue(trailId, out string versionId))
                {
                    return FakeTransport.Respond(404, new { error = "trail_not_found" });
                }

                var attempt = new FakeAttempt
                {
                    AttemptId = "attempt-" + (++_ids),
                    UserId = caller,
                    TrailId = trailId,
                    TrailVersionId = versionId,
                    Status = "active",
                    StartedAt = "2026-05-01T09:00:00.000Z",
                    Pins = _versions[versionId].Pins
                        .Select(p => new AttemptPinDto
                        {
                            PinId = p.PinId,
                            SequenceIndex = p.SequenceIndex,
                            Status = p.SequenceIndex == 1 ? "unlocked" : "locked",
                        })
                        .ToList(),
                };
                _attempts[attempt.AttemptId] = attempt;
                return FakeTransport.Respond(201, attempt.ToDto());
            }

            if (request.Method == "GET" && (match = Regex.Match(path, "^/api/v1/attempts/([^/]+)$")).Success)
            {
                return _attempts.TryGetValue(match.Groups[1].Value, out FakeAttempt attempt) && attempt.UserId == caller
                    ? FakeTransport.Respond(200, attempt.ToDto())
                    : FakeTransport.Respond(404, new { error = "attempt_not_found" });
            }

            if (request.Method == "POST" && (match = Regex.Match(path, "^/api/v1/attempts/([^/]+)/pins/([^/]+)/complete$")).Success)
            {
                return Complete(caller, match.Groups[1].Value, match.Groups[2].Value, path, request.Body);
            }

            if (request.Method == "POST" && (match = Regex.Match(path, "^/api/v1/pins/([^/]+)/report$")).Success)
            {
                Reports.Add(match.Groups[1].Value);
                return FakeTransport.Respond(201, new PinReportResponse { ReportId = "report-" + (++_ids) });
            }

            if (request.Method == "DELETE" && path == "/api/v1/players/me")
            {
                int attempts = _attempts.Values.Count(a => a.UserId == caller);
                foreach (string id in _attempts.Values.Where(a => a.UserId == caller).Select(a => a.AttemptId).ToList())
                {
                    _attempts.Remove(id);
                }

                _deletedUsers.Add(caller);
                return FakeTransport.Respond(200, new DeleteMyDataResponse
                {
                    Deleted = new DeletedCounts { Attempts = attempts, Player = true },
                    DiscardDeviceKey = true,
                });
            }

            return FakeTransport.Respond(404, new { error = "route_not_found" });
        }

        private HttpResponseData Complete(string caller, string attemptId, string pinId, string path, string body)
        {
            CompletionRequest completion = Json.Deserialize<CompletionRequest>(body);
            Completions.Add((path, completion));

            if (!_attempts.TryGetValue(attemptId, out FakeAttempt attempt) || attempt.UserId != caller)
            {
                return FakeTransport.Respond(404, new { error = "attempt_not_found" });
            }

            if (attempt.Status != "active")
            {
                return FakeTransport.Respond(409, new { error = "attempt_not_active" });
            }

            List<AttemptPinDto> ordered = attempt.Pins.OrderBy(p => p.SequenceIndex).ToList();
            int index = ordered.FindIndex(p => p.PinId == pinId);
            if (index < 0)
            {
                return FakeTransport.Respond(404, new { error = "pin_not_in_attempt" });
            }

            if (ordered[index].Status == "completed")
            {
                return FakeTransport.Respond(409, new { error = "pin_already_completed" });
            }

            if (ordered[index].Status == "locked")
            {
                return FakeTransport.Respond(409, new { error = "pin_locked" });
            }

            PinDto pin = _versions[attempt.TrailVersionId].Pins.Single(p => p.PinId == pinId);
            PositionEvaluation position = CompletionRules.Evaluate(
                pin.Lat, pin.Lng, pin.RadiusM, completion.Lat, completion.Lng, completion.AccuracyM);
            if (!position.IsWithin)
            {
                string reason = position.Verdict == PositionVerdict.AccuracyExceedsCeiling
                    ? "accuracy_exceeds_ceiling"
                    : "outside_effective_radius";
                return FakeTransport.Respond(422, new { error = reason, distanceM = position.DistanceM });
            }

            if (pin.ChallengeType == ChallengeTypes.CodeEntry)
            {
                if (string.IsNullOrWhiteSpace(completion.ChallengeAnswer))
                {
                    return FakeTransport.Respond(422, new { error = "challenge_answer_required" });
                }

                if (Normalize(completion.ChallengeAnswer) != Normalize(_codes[pinId]))
                {
                    return FakeTransport.Respond(422, new { error = "incorrect_code" });
                }
            }

            ordered[index].Status = "completed";
            string nextPinId = index + 1 < ordered.Count ? ordered[index + 1].PinId : null;
            if (nextPinId != null)
            {
                ordered[index + 1].Status = "unlocked";
            }
            else
            {
                attempt.Status = "completed";
                // SR-NET-02: the attempt closes at the moment of the final fix, not on arrival.
                attempt.CompletedAt = completion.RecordedAt ?? "2026-05-01T10:00:00.000Z";
            }

            return FakeTransport.Respond(200, new CompletionResponse
            {
                AttemptId = attemptId,
                PinId = pinId,
                Status = "completed",
                NextPinId = nextPinId,
                AttemptStatus = attempt.Status,
                EffectiveRadiusM = position.EffectiveRadiusM,
                DistanceM = position.DistanceM,
            });
        }

        private TrailDto WithCurrentFlag(TrailDto version)
        {
            TrailDto copy = Json.Deserialize<TrailDto>(Json.Serialize(version));
            copy.IsCurrentVersion = _currentVersionByTrail[version.TrailId] == version.TrailVersionId;
            return copy;
        }

        /// <summary>Same normalization as server/src/services/challengeVerification.ts.</summary>
        private static string Normalize(string code) =>
            Regex.Replace(code.Normalize(NormalizationForm.FormKC).ToUpper(CultureInfo.InvariantCulture), "[\\s_\\-‐-―]+", "");
    }

    internal sealed class FakeAttempt
    {
        public string AttemptId { get; set; }
        public string UserId { get; set; }
        public string TrailId { get; set; }
        public string TrailVersionId { get; set; }
        public string Status { get; set; }
        public string StartedAt { get; set; }
        public string CompletedAt { get; set; }
        public List<AttemptPinDto> Pins { get; set; }

        public AttemptDto ToDto() => new AttemptDto
        {
            AttemptId = AttemptId,
            TrailId = TrailId,
            TrailVersionId = TrailVersionId,
            Status = Status,
            StartedAt = StartedAt,
            CompletedAt = CompletedAt,
            CurrentPinId = Pins.FirstOrDefault(p => p.Status == "unlocked")?.PinId,
            Pins = Pins.Select(p => new AttemptPinDto { PinId = p.PinId, SequenceIndex = p.SequenceIndex, Status = p.Status }).ToList(),
        };
    }

    internal static class Geo
    {
        /// <summary>A point <paramref name="meters"/> east of (lat, lng), on the same sphere as the rules.</summary>
        public static (double Lat, double Lng) EastOf(double lat, double lng, double meters)
        {
            GeoPoint moved = GeoMath.FromEnu(new GeoPoint(lat, lng), new EnuOffset(meters, 0, 0));
            return (moved.Lat, moved.Lng);
        }
    }
}
