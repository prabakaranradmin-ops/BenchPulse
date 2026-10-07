using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using ArQuestTrail.Core;
using Xunit;

namespace ArQuestTrail.Core.Tests
{
    public class QuestSessionTests
    {
        private static readonly DateTimeOffset T0 = new DateTimeOffset(2026, 5, 1, 9, 0, 0, TimeSpan.Zero);

        private const double BaseLat = 13.0827;
        private const double BaseLng = 80.2707;

        private readonly FakeServer _server = new FakeServer();
        private readonly InMemoryKeyValueStore _data = new InMemoryKeyValueStore();
        private readonly InMemoryKeyValueStore _secure = new InMemoryKeyValueStore();

        private QuestSession NewSession()
        {
            var identity = new DeviceIdentity(_secure);
            var api = new QuestApiClient(_server.Transport, "https://api.example.test", identity, new FakeClock(T0));
            var session = new QuestSession(api, _data, identity, new FakeClock(T0));
            session.History.MarkSessionStarted(T0);
            return session;
        }

        /// <summary>Dwell, code (SWAN42), dwell — 300m apart, eastward.</summary>
        private TrailDto PublishTrail(string trailId = "t-1")
        {
            (double lat2, double lng2) = Geo.EastOf(BaseLat, BaseLng, 300);
            (double lat3, double lng3) = Geo.EastOf(BaseLat, BaseLng, 600);
            return _server.Publish(
                trailId,
                (BaseLat, BaseLng, ChallengeTypes.ProximityDwell, null),
                (lat2, lng2, ChallengeTypes.CodeEntry, "SWAN42"),
                (lat3, lng3, ChallengeTypes.ProximityDwell, null));
        }

        private static LocationFix FixAt(PinDto pin, double seconds, double accuracy = 5) =>
            new LocationFix(pin.Lat, pin.Lng, accuracy, T0.AddSeconds(seconds));

        [Fact]
        public async Task Loads_a_trail_online_and_serves_it_from_cache_when_offline()
        {
            PublishTrail();
            QuestSession session = NewSession();

            ApiResult<TrailDto> online = await session.LoadTrailAsync("t-1");
            _server.Offline = true;
            ApiResult<TrailDto> offline = await NewSession().LoadTrailAsync("t-1");

            Assert.False(online.FromCache);
            Assert.True(offline.Ok);
            Assert.True(offline.FromCache);
            Assert.Equal(3, offline.Value.Pins.Count);
        }

        [Fact]
        public async Task Starts_an_attempt_and_resumes_the_same_one_after_a_restart()
        {
            PublishTrail();
            ApiResult<TrailProgress> first = await NewSession().StartOrResumeAsync("t-1");

            ApiResult<TrailProgress> resumed = await NewSession().StartOrResumeAsync("t-1");

            Assert.Equal(first.Value.Attempt.AttemptId, resumed.Value.Attempt.AttemptId);
            Assert.Single(_server.Attempts);
            Assert.Equal(PinState.Active, resumed.Value.Pins[0].State);
        }

        [Fact]
        public async Task Completes_a_dwell_pin_online()
        {
            PublishTrail();
            QuestSession session = NewSession();
            TrailProgress progress = (await session.StartOrResumeAsync("t-1")).Value;
            PinDto first = progress.ActivePin.Pin;

            SubmitResult result = await session.SubmitCompletionAsync(first, FixAt(first, 15));

            Assert.Equal(SubmitOutcome.Confirmed, result.Outcome);
            Assert.Equal(new[] { PinState.Completed, PinState.Active, PinState.Locked }, progress.Pins.Select(p => p.State));
            Assert.Empty(session.PendingCompletions);
        }

        [Fact]
        public async Task Sends_the_sr_sec_02_inputs_with_every_completion()
        {
            PublishTrail();
            QuestSession session = NewSession();
            TrailProgress progress = (await session.StartOrResumeAsync("t-1")).Value;
            PinDto first = progress.ActivePin.Pin;
            for (int s = 0; s < 15; s++)
            {
                session.History.Add(FixAt(first, s));
            }

            await session.SubmitCompletionAsync(first, FixAt(first, 15));

            CompletionRequest sent = _server.Completions.Single().Body;
            Assert.Equal("2026-05-01T09:00:15.000Z", sent.RecordedAt);
            Assert.Equal("2026-05-01T09:00:00.000Z", sent.SessionStartedAt);
            Assert.Equal(16, sent.RecentLocationHistory.Count);
            Assert.Null(sent.ChallengeAnswer);
        }

        [Fact]
        public async Task Offline_dwell_completions_queue_unlock_locally_and_sync_with_their_capture_times()
        {
            PublishTrail();
            QuestSession session = NewSession();
            TrailProgress progress = (await session.StartOrResumeAsync("t-1")).Value;
            PinDto first = progress.ActivePin.Pin;

            _server.Offline = true;
            SubmitResult queued = await session.SubmitCompletionAsync(first, FixAt(first, 15));

            Assert.Equal(SubmitOutcome.Queued, queued.Outcome);
            Assert.True(session.IsOffline);
            Assert.Equal(PinState.CompletedPendingSync, progress.Pins[0].State);
            Assert.Equal(PinState.Active, progress.Pins[1].State);

            _server.Offline = false;
            await session.FlushAsync();

            Assert.False(session.IsOffline);
            Assert.Empty(session.PendingCompletions);
            Assert.Equal(PinState.Completed, session.Progress.Pins[0].State);
            Assert.Equal("2026-05-01T09:00:15.000Z", _server.Completions.Last().Body.RecordedAt);
        }

        [Fact]
        public async Task A_code_entered_offline_waits_for_the_server_before_the_trail_moves_on()
        {
            PublishTrail();
            QuestSession session = NewSession();
            TrailProgress progress = (await session.StartOrResumeAsync("t-1")).Value;
            await session.SubmitCompletionAsync(progress.ActivePin.Pin, FixAt(progress.ActivePin.Pin, 15));
            PinDto codePin = session.Progress.ActivePin.Pin;

            _server.Offline = true;
            await session.SubmitCompletionAsync(codePin, FixAt(codePin, 100), "swan 42");

            Assert.Equal(PinState.AwaitingVerification, session.Progress.Pins[1].State);
            Assert.Null(session.Progress.ActivePin);

            _server.Offline = false;
            await session.FlushAsync();

            Assert.Equal(PinState.Completed, session.Progress.Pins[1].State);
            Assert.Equal(PinState.Active, session.Progress.Pins[2].State);
        }

        [Fact]
        public async Task A_wrong_code_is_reported_and_the_pin_stays_playable()
        {
            PublishTrail();
            QuestSession session = NewSession();
            TrailProgress progress = (await session.StartOrResumeAsync("t-1")).Value;
            await session.SubmitCompletionAsync(progress.ActivePin.Pin, FixAt(progress.ActivePin.Pin, 15));
            PinDto codePin = session.Progress.ActivePin.Pin;
            var rejections = new List<string>();
            session.CompletionRejected += (pin, error) => rejections.Add(pin.PinId + ":" + error.Code);

            SubmitResult wrong = await session.SubmitCompletionAsync(codePin, FixAt(codePin, 100), "SWAN43");

            Assert.Equal(SubmitOutcome.Rejected, wrong.Outcome);
            Assert.Equal("incorrect_code", wrong.Error.Code);
            Assert.Equal(new[] { codePin.PinId + ":incorrect_code" }, rejections);
            Assert.Equal(PinState.Active, session.Progress.Pins[1].State);

            // GDR-10: unlimited retries.
            SubmitResult right = await session.SubmitCompletionAsync(codePin, FixAt(codePin, 110), "swan-42");
            Assert.Equal(SubmitOutcome.Confirmed, right.Outcome);
        }

        [Fact]
        public async Task A_lost_reply_is_retried_and_counted_as_done_rather_than_duplicated()
        {
            PublishTrail();
            QuestSession session = NewSession();
            TrailProgress progress = (await session.StartOrResumeAsync("t-1")).Value;
            PinDto first = progress.ActivePin.Pin;

            _server.LoseNextReply = true;
            SubmitResult lost = await session.SubmitCompletionAsync(first, FixAt(first, 15));
            Assert.Equal(SubmitOutcome.Queued, lost.Outcome);

            await session.FlushAsync();

            Assert.Empty(session.PendingCompletions);
            Assert.Equal(PinState.Completed, session.Progress.Pins[0].State);
            Assert.Equal(PinState.Active, session.Progress.Pins[1].State);
        }

        [Fact]
        public async Task The_final_pin_completed_offline_closes_the_attempt_at_its_capture_time()
        {
            PublishTrail();
            QuestSession session = NewSession();
            TrailProgress progress = (await session.StartOrResumeAsync("t-1")).Value;
            await session.SubmitCompletionAsync(progress.ActivePin.Pin, FixAt(progress.ActivePin.Pin, 15));
            await session.SubmitCompletionAsync(session.Progress.ActivePin.Pin, FixAt(session.Progress.ActivePin.Pin, 100), "SWAN42");
            PinDto last = session.Progress.ActivePin.Pin;
            AttemptDto completed = null;
            session.TrailCompleted += attempt => completed = attempt;

            _server.Offline = true;
            await session.SubmitCompletionAsync(last, FixAt(last, 400));
            Assert.True(session.Progress.IsCompletedLocally);
            Assert.False(session.Progress.IsCompletedOnServer);
            Assert.Null(completed);

            _server.Offline = false;
            await session.FlushAsync();

            Assert.NotNull(completed);
            Assert.Equal("2026-05-01T09:06:40.000Z", completed.CompletedAt);
        }

        [Fact]
        public async Task A_queued_completion_survives_an_app_restart()
        {
            PublishTrail();
            QuestSession first = NewSession();
            TrailProgress progress = (await first.StartOrResumeAsync("t-1")).Value;
            _server.Offline = true;
            await first.SubmitCompletionAsync(progress.ActivePin.Pin, FixAt(progress.ActivePin.Pin, 15));

            QuestSession restarted = NewSession();
            ApiResult<TrailProgress> resumed = await restarted.StartOrResumeAsync("t-1");

            Assert.True(resumed.FromCache);
            Assert.Single(restarted.PendingCompletions);
            Assert.Equal(PinState.CompletedPendingSync, resumed.Value.Pins[0].State);

            _server.Offline = false;
            await restarted.FlushAsync();
            Assert.Equal(PinState.Completed, restarted.Progress.Pins[0].State);
        }

        [Fact]
        public async Task Resumes_on_the_version_the_attempt_started_on_after_the_admin_republishes()
        {
            TrailDto v1 = PublishTrail();
            await NewSession().StartOrResumeAsync("t-1");
            _data.Clear(); // a reinstall: the v1 cache is gone, only the attempt id survives…
            _data.Set("attempt_for_trail_t-1", _server.Attempts.Keys.Single());
            _server.Publish("t-1", (BaseLat, BaseLng, ChallengeTypes.ProximityDwell, null)); // …and v2 replaced v1.

            ApiResult<TrailProgress> resumed = await NewSession().StartOrResumeAsync("t-1");

            Assert.Equal(v1.TrailVersionId, resumed.Value.Trail.TrailVersionId);
            Assert.False(resumed.Value.Trail.IsCurrentVersion);
            Assert.Equal(3, resumed.Value.Pins.Count);
        }

        [Fact]
        public async Task Replay_starts_a_new_attempt_and_leaves_the_old_one()
        {
            PublishTrail();
            QuestSession session = NewSession();
            string firstId = (await session.StartOrResumeAsync("t-1")).Value.Attempt.AttemptId;

            ApiResult<TrailProgress> replay = await session.ReplayAsync("t-1");

            Assert.NotEqual(firstId, replay.Value.Attempt.AttemptId);
            Assert.Equal(2, _server.Attempts.Count);
        }

        [Fact]
        public async Task Refuses_to_complete_anything_but_the_active_pin()
        {
            PublishTrail();
            QuestSession session = NewSession();
            TrailProgress progress = (await session.StartOrResumeAsync("t-1")).Value;
            PinDto third = progress.Pins[2].Pin;

            SubmitResult result = await session.SubmitCompletionAsync(third, FixAt(third, 15));

            Assert.Equal(SubmitOutcome.NotAccepted, result.Outcome);
            Assert.Empty(_server.Completions);
        }

        [Fact]
        public async Task Deleting_my_data_wipes_the_device_and_the_next_sign_in_is_a_new_player()
        {
            PublishTrail();
            QuestSession session = NewSession();
            TrailProgress progress = (await session.StartOrResumeAsync("t-1")).Value;
            _server.Offline = true;
            await session.SubmitCompletionAsync(progress.ActivePin.Pin, FixAt(progress.ActivePin.Pin, 15));
            _server.Offline = false;
            string oldKey = new DeviceIdentity(_secure).GetOrCreateDeviceKey();
            bool deletedRaised = false;
            session.PlayerDataDeleted += () => deletedRaised = true;

            ApiResult<DeleteMyDataResponse> result = await session.DeleteMyDataAsync();

            Assert.True(result.Ok);
            Assert.True(deletedRaised);
            Assert.Null(session.Progress);
            Assert.Empty(session.PendingCompletions); // queued items carry location data
            Assert.Equal(0, _data.Count);
            Assert.NotEqual(oldKey, new DeviceIdentity(_secure).GetOrCreateDeviceKey());
        }

        [Fact]
        public async Task Reports_a_pin()
        {
            TrailDto trail = PublishTrail();

            ApiResult<PinReportResponse> result = await NewSession().ReportPinAsync(trail.Pins[0].PinId, "Gate locked");

            Assert.True(result.Ok);
            Assert.Equal(new[] { trail.Pins[0].PinId }, _server.Reports);
        }
    }
}
