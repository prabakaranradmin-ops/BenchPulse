using System;
using System.Linq;
using System.Threading.Tasks;
using ArQuestTrail.Core;
using Xunit;
using PinSpec = ArQuestTrail.Core.Tests.Contract.ContractAdmin.PinSpec;

namespace ArQuestTrail.Core.Tests.Contract
{
    /// <summary>
    /// The Unity client's own C#, driven against the real server and Postgres. The unit tests
    /// prove the client's logic against a fake; these prove the fake and the server agree.
    /// </summary>
    public class ContractTests
    {
        private static string Unique(string name) => $"{name} {Guid.NewGuid():N}";

        /// <summary>
        /// Walks up to a pin from 30m west, recording a fix every few seconds into the session's
        /// SR-SEC-02 history, and returns the arrival fix — what a dwell would have satisfied on.
        /// </summary>
        private static LocationFix WalkTo(QuestSession session, PinDto pin, DateTimeOffset arriveAt)
        {
            for (int step = 5; step >= 1; step--)
            {
                (double lat, double lng) = Geo.EastOf(pin.Lat, pin.Lng, -6 * step);
                session.History.Add(new LocationFix(lat, lng, 5, arriveAt.AddSeconds(-5 * step)));
            }

            var arrival = new LocationFix(pin.Lat, pin.Lng, 4, arriveAt);
            session.History.Add(arrival);
            return arrival;
        }

        [ContractFact]
        public async Task Plays_a_whole_trail_including_a_wrong_code_and_an_offline_finish()
        {
            string trailId = await ContractAdmin.CreateTrailAsync(
                Unique("Contract walkthrough"),
                new PinSpec { EastMeters = 0 },
                new PinSpec { EastMeters = 100, Type = ChallengeTypes.CodeEntry, Code = "SWAN42" },
                new PinSpec { EastMeters = 200 });
            var player = new ContractPlayer();
            QuestSession session = player.Session;

            ApiResult<TrailDto> trail = await session.LoadTrailAsync(trailId);
            Assert.True(trail.Ok, trail.Error?.ToString());
            Assert.Equal("Read the plaque", trail.Value.Pins[1].Challenge.Hint);
            Assert.DoesNotContain("SWAN42", Json.Serialize(trail.Value));

            TrailProgress progress = (await session.StartOrResumeAsync(trailId)).Value;
            DateTimeOffset start = IsoTime.FromWire(progress.Attempt.StartedAt);

            // Pin 1 — a dwell, walked up to and stood on.
            PinDto first = progress.ActivePin.Pin;
            LocationFix atFirst = WalkTo(session, first, start.AddSeconds(20));
            SubmitResult one = await session.SubmitCompletionAsync(first, atFirst);
            Assert.Equal(SubmitOutcome.Confirmed, one.Outcome);
            Assert.Null(one.Response.LocationFlag); // a walking pace is not SR-SEC-02-suspicious

            // Pin 2 — a code: a wrong guess first, then the plaque as a player would type it.
            PinDto codePin = session.Progress.ActivePin.Pin;
            Assert.Equal(ChallengeTypes.CodeEntry, codePin.ChallengeType);
            SubmitResult wrong = await session.SubmitCompletionAsync(codePin, WalkTo(session, codePin, start.AddSeconds(100)), "SWAN43");
            Assert.Equal(SubmitOutcome.Rejected, wrong.Outcome);
            Assert.Equal("incorrect_code", wrong.Error.Code);
            Assert.Equal(PinState.Active, session.Progress.Find(codePin.PinId).State);

            SubmitResult right = await session.SubmitCompletionAsync(
                codePin,
                new LocationFix(codePin.Lat, codePin.Lng, 4, start.AddSeconds(110)),
                " swan-42 ");
            Assert.Equal(SubmitOutcome.Confirmed, right.Outcome);

            // Pin 3 — completed in airplane mode, synced when the connection returns.
            PinDto last = session.Progress.ActivePin.Pin;
            player.Transport.Offline = true;
            LocationFix atLast = WalkTo(session, last, start.AddSeconds(190));
            SubmitResult queued = await session.SubmitCompletionAsync(last, atLast);
            Assert.Equal(SubmitOutcome.Queued, queued.Outcome);
            Assert.True(session.IsOffline);
            Assert.True(session.Progress.IsCompletedLocally);

            AttemptDto completed = null;
            session.TrailCompleted += attempt => completed = attempt;
            player.Transport.Offline = false;
            await session.FlushAsync();

            Assert.NotNull(completed);
            Assert.Empty(session.PendingCompletions);
            // SR-NET-02: the attempt closed at the moment of the offline fix, not at reconnect.
            Assert.Equal(IsoTime.ToWire(atLast.RecordedAt), completed.CompletedAt);
        }

        [ContractFact]
        public async Task The_client_predicts_every_sr_geo_04_verdict_the_server_gives()
        {
            string trailId = await ContractAdmin.CreateTrailAsync(Unique("Contract parity"), new PinSpec { EastMeters = 0 });
            var player = new ContractPlayer();
            PinDto pin = (await player.Api.GetTrailAsync(trailId)).Value.Pins.Single();

            var cases = new (double Meters, double AccuracyM)[]
            {
                (6, 4),       // inside, accuracy tighter than the radius
                (9.9, 5),     // just inside the 10m radius
                (10.2, 5),    // just outside it
                (20, 25),     // widened to the reported accuracy
                (26, 25),     // outside even the widened radius
                (48, 50),     // capped at the ceiling, still inside
                (5, 50.5),    // accuracy past the ceiling: weak signal, not a guess
                (0, 80),      // standing on the pin doesn't rescue a useless fix
            };

            foreach ((double meters, double accuracy) in cases)
            {
                AttemptDto attempt = (await player.Api.StartAttemptAsync(trailId)).Value;
                (double lat, double lng) = Geo.EastOf(pin.Lat, pin.Lng, meters);
                PositionEvaluation predicted = CompletionRules.Evaluate(pin.Lat, pin.Lng, pin.RadiusM, lat, lng, accuracy);

                ApiResult<CompletionResponse> actual = await player.Api.CompletePinAsync(
                    attempt.AttemptId,
                    pin.PinId,
                    new CompletionRequest { Lat = lat, Lng = lng, AccuracyM = accuracy, RecordedAt = IsoTime.ToWire(DateTimeOffset.UtcNow) });

                string label = $"{meters}m at ±{accuracy}m";
                if (predicted.IsWithin)
                {
                    Assert.True(actual.Ok, $"{label}: client predicted a completion, server said {actual.Error}");
                    Assert.Equal(predicted.DistanceM, actual.Value.DistanceM, 6);
                    Assert.Equal(predicted.EffectiveRadiusM, actual.Value.EffectiveRadiusM, 9);
                }
                else
                {
                    string expected = predicted.Verdict == PositionVerdict.AccuracyExceedsCeiling
                        ? "accuracy_exceeds_ceiling"
                        : "outside_effective_radius";
                    Assert.False(actual.Ok, $"{label}: client predicted {expected}, server completed it");
                    Assert.Equal(expected, actual.Error.Code);
                    Assert.Equal(predicted.DistanceM, actual.Error.Body.DistanceM.Value, 6);
                }
            }
        }

        [ContractFact]
        public async Task Resumes_on_its_own_version_after_an_admin_republish_and_a_reinstall()
        {
            string trailId = await ContractAdmin.CreateTrailAsync(
                Unique("Contract versions"),
                new PinSpec { EastMeters = 0 },
                new PinSpec { EastMeters = 100 },
                new PinSpec { EastMeters = 200 });
            var player = new ContractPlayer();
            TrailProgress started = (await player.Session.StartOrResumeAsync(trailId)).Value;
            string startedOn = started.Trail.TrailVersionId;

            await ContractAdmin.PublishAsync(trailId, new PinSpec { EastMeters = 0 }, new PinSpec { EastMeters = 150 });

            // A reinstall: every cache gone; only the attempt id and the device key survive.
            string attemptKey = "attempt_for_trail_" + trailId;
            string attemptId = player.Data.Get(attemptKey);
            player.Data.Clear();
            player.Data.Set(attemptKey, attemptId);

            QuestSession restarted = player.Restart();
            TrailProgress resumed = (await restarted.StartOrResumeAsync(trailId)).Value;

            Assert.Equal(startedOn, resumed.Trail.TrailVersionId);
            Assert.False(resumed.Trail.IsCurrentVersion);
            Assert.Equal(3, resumed.Pins.Count);
            Assert.Equal(2, (await restarted.LoadTrailAsync(trailId)).Value.Pins.Count);
        }

        [ContractFact]
        public async Task An_impossible_capture_time_is_rejected_once_and_not_retried_forever()
        {
            string trailId = await ContractAdmin.CreateTrailAsync(Unique("Contract clock"), new PinSpec { EastMeters = 0 });
            var player = new ContractPlayer();
            TrailProgress progress = (await player.Session.StartOrResumeAsync(trailId)).Value;
            PinDto pin = progress.ActivePin.Pin;

            SubmitResult result = await player.Session.SubmitCompletionAsync(
                pin,
                new LocationFix(pin.Lat, pin.Lng, 4, DateTimeOffset.UtcNow.AddHours(1)));

            Assert.Equal(SubmitOutcome.Rejected, result.Outcome);
            Assert.Equal("recorded_at_in_future", result.Error.Code);
            Assert.Empty(player.Session.PendingCompletions);
            Assert.Equal(PinState.Active, player.Session.Progress.Find(pin.PinId).State);
        }

        [ContractFact]
        public async Task Same_key_same_player_then_a_report_then_delete_my_data()
        {
            string trailId = await ContractAdmin.CreateTrailAsync(Unique("Contract identity"), new PinSpec { EastMeters = 0 });
            var player = new ContractPlayer();
            TrailDto trail = (await player.Session.LoadTrailAsync(trailId)).Value;
            string playerId = player.Api.PlayerId;

            var sameDevice = new QuestApiClient(new HttpClientTransport(), ContractEnvironment.ApiUrl, new DeviceIdentity(player.Secure));
            await sameDevice.SignInAsync();
            Assert.Equal(playerId, sameDevice.PlayerId);

            ApiResult<PinReportResponse> report = await player.Session.ReportPinAsync(trail.Pins[0].PinId, "Scaffolding over the plaque");
            Assert.True(report.Ok, report.Error?.ToString());
            Assert.False(string.IsNullOrEmpty(report.Value.ReportId));

            await player.Session.StartOrResumeAsync(trailId);
            ApiResult<DeleteMyDataResponse> deleted = await player.Session.DeleteMyDataAsync();

            Assert.True(deleted.Ok, deleted.Error?.ToString());
            Assert.True(deleted.Value.DiscardDeviceKey);
            Assert.Equal(1, deleted.Value.Deleted.Attempts);
            Assert.Equal(0, player.Data.Count);
            Assert.False(player.Identity.HasDeviceKey);

            await player.Api.SignInAsync();
            Assert.NotEqual(playerId, player.Api.PlayerId);
        }
    }
}
