using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using ArQuestTrail.Core;
using Xunit;

namespace ArQuestTrail.Core.Tests
{
    public class CompletionOutboxTests
    {
        /// <summary>Answers each call from a script of results, recording which pins were sent.</summary>
        private sealed class ScriptedApi : ICompletionApi
        {
            private readonly Queue<Func<ApiResult<CompletionResponse>>> _script;

            public ScriptedApi(params Func<ApiResult<CompletionResponse>>[] script) =>
                _script = new Queue<Func<ApiResult<CompletionResponse>>>(script);

            public List<string> Sent { get; } = new List<string>();

            public TaskCompletionSource<bool> Gate { get; set; }

            public async Task<ApiResult<CompletionResponse>> CompletePinAsync(
                string attemptId, string pinId, CompletionRequest request, CancellationToken cancellationToken)
            {
                Sent.Add(pinId);
                if (Gate != null)
                {
                    await Gate.Task;
                }

                return _script.Count > 0 ? _script.Dequeue()() : Ok();
            }
        }

        private static ApiResult<CompletionResponse> Ok() =>
            ApiResult<CompletionResponse>.Success(new CompletionResponse { Status = "completed" });

        private static ApiResult<CompletionResponse> Status(int status, string code) =>
            ApiResult<CompletionResponse>.Failure(ApiError.FromResponse(FakeTransport.Respond(status, new { error = code })));

        private static ApiResult<CompletionResponse> Offline() =>
            ApiResult<CompletionResponse>.Failure(ApiError.FromResponse(HttpResponseData.Failed("offline")));

        private static void Queue(CompletionOutbox outbox, string attemptId, params string[] pins)
        {
            foreach (string pin in pins)
            {
                outbox.Enqueue(attemptId, pin, 1, ChallengeTypes.ProximityDwell, new CompletionRequest());
            }
        }

        [Fact]
        public async Task Sends_in_order_and_empties_on_success()
        {
            var api = new ScriptedApi();
            var outbox = new CompletionOutbox(new InMemoryKeyValueStore(), api);
            Queue(outbox, "a-1", "p-1", "p-2", "p-3");

            FlushReport report = await outbox.FlushAsync();

            Assert.Equal(new[] { "p-1", "p-2", "p-3" }, api.Sent);
            Assert.All(report.Results, r => Assert.Equal(OutboxOutcome.Confirmed, r.Outcome));
            Assert.Empty(outbox.Pending);
        }

        [Fact]
        public async Task Keeps_everything_in_order_when_offline()
        {
            var api = new ScriptedApi(Ok, Offline);
            var outbox = new CompletionOutbox(new InMemoryKeyValueStore(), api);
            Queue(outbox, "a-1", "p-1", "p-2", "p-3");

            FlushReport report = await outbox.FlushAsync();

            Assert.True(report.Deferred);
            Assert.Equal(ApiErrorKind.Network, report.DeferredBecause.Kind);
            Assert.Equal(new[] { "p-2", "p-3" }, outbox.Pending.Select(p => p.PinId));
        }

        [Theory]
        [InlineData(500)]
        [InlineData(429)]
        public async Task Treats_server_errors_and_rate_limits_as_try_again_later(int status)
        {
            var outbox = new CompletionOutbox(new InMemoryKeyValueStore(), new ScriptedApi(() => Status(status, "x")));
            Queue(outbox, "a-1", "p-1");

            FlushReport report = await outbox.FlushAsync();

            Assert.True(report.Deferred);
            Assert.Single(outbox.Pending);
        }

        [Fact]
        public async Task Counts_an_already_completed_pin_as_confirmed()
        {
            // The first send landed but its reply was lost; the retry is told it's already done.
            var outbox = new CompletionOutbox(new InMemoryKeyValueStore(), new ScriptedApi(() => Status(409, "pin_already_completed")));
            Queue(outbox, "a-1", "p-1");

            FlushReport report = await outbox.FlushAsync();

            Assert.Equal(OutboxOutcome.Confirmed, report.Results.Single().Outcome);
            Assert.Null(report.Results.Single().Response);
            Assert.Empty(outbox.Pending);
        }

        [Fact]
        public async Task A_rejection_drops_the_later_pins_of_that_attempt_but_not_other_attempts()
        {
            var api = new ScriptedApi(() => Status(422, "outside_effective_radius"));
            var outbox = new CompletionOutbox(new InMemoryKeyValueStore(), api);
            Queue(outbox, "a-1", "p-1");
            Queue(outbox, "a-2", "q-1");
            Queue(outbox, "a-1", "p-2");

            FlushReport report = await outbox.FlushAsync();

            Assert.Equal(
                new[] { ("p-1", OutboxOutcome.Rejected), ("p-2", OutboxOutcome.Superseded), ("q-1", OutboxOutcome.Confirmed) },
                report.Results.Select(r => (r.Item.PinId, r.Outcome)));
            // p-2 was never sent: it would only have collected pin_locked.
            Assert.Equal(new[] { "p-1", "q-1" }, api.Sent);
            Assert.Empty(outbox.Pending);
        }

        [Fact]
        public void Survives_a_restart_with_the_capture_timestamp_intact()
        {
            var store = new InMemoryKeyValueStore();
            new CompletionOutbox(store, new ScriptedApi())
                .Enqueue("a-1", "p-1", 1, ChallengeTypes.CodeEntry, new CompletionRequest
                {
                    RecordedAt = "2026-05-01T09:00:00.123Z",
                    ChallengeAnswer = "SWAN42",
                });

            PendingCompletion restored = new CompletionOutbox(store, new ScriptedApi()).Pending.Single();

            Assert.Equal("2026-05-01T09:00:00.123Z", restored.Request.RecordedAt);
            Assert.Equal("SWAN42", restored.Request.ChallengeAnswer);
            Assert.Equal(ChallengeTypes.CodeEntry, restored.ChallengeType);
        }

        [Fact]
        public async Task Concurrent_flushes_share_one_pass_instead_of_double_sending()
        {
            var api = new ScriptedApi { Gate = new TaskCompletionSource<bool>() };
            var outbox = new CompletionOutbox(new InMemoryKeyValueStore(), api);
            Queue(outbox, "a-1", "p-1");

            Task<FlushReport> first = outbox.FlushAsync();
            Task<FlushReport> second = outbox.FlushAsync();
            api.Gate.SetResult(true);
            await Task.WhenAll(first, second);

            Assert.Same(first, second);
            Assert.Single(api.Sent);
        }
    }

    public class TrailProgressTests
    {
        private static TrailDto Trail(params string[] types) => new TrailDto
        {
            TrailId = "t-1",
            TrailVersionId = "v-1",
            Pins = types.Select((type, i) => new PinDto
            {
                PinId = "p-" + (i + 1),
                SequenceIndex = i + 1,
                ChallengeType = type,
            }).Reverse().ToList(), // deliberately out of order
        };

        private static AttemptDto Attempt(string status = "active", params string[] pinStatuses) => new AttemptDto
        {
            AttemptId = "a-1",
            TrailVersionId = "v-1",
            Status = status,
            Pins = pinStatuses.Select((s, i) => new AttemptPinDto { PinId = "p-" + (i + 1), SequenceIndex = i + 1, Status = s }).ToList(),
        };

        private static PendingCompletion Pending(string pinId, string type) =>
            new PendingCompletion { AttemptId = "a-1", PinId = pinId, ChallengeType = type };

        private static PinState[] States(TrailProgress progress) => progress.Pins.Select(p => p.State).ToArray();

        [Fact]
        public void Mirrors_the_server_and_orders_pins_by_sequence()
        {
            var progress = new TrailProgress(
                Trail(ChallengeTypes.ProximityDwell, ChallengeTypes.ProximityDwell, ChallengeTypes.ProximityDwell),
                Attempt("active", "completed", "unlocked", "locked"),
                null);

            Assert.Equal(new[] { "p-1", "p-2", "p-3" }, progress.Pins.Select(p => p.Pin.PinId));
            Assert.Equal(new[] { PinState.Completed, PinState.Active, PinState.Locked }, States(progress));
            Assert.Equal("p-2", progress.ActivePin.Pin.PinId);
        }

        [Fact]
        public void A_dwell_completion_unlocks_the_next_pin_before_the_server_confirms()
        {
            var progress = new TrailProgress(
                Trail(ChallengeTypes.ProximityDwell, ChallengeTypes.ProximityDwell),
                Attempt("active", "unlocked", "locked"),
                null);

            Assert.True(progress.ApplyLocalCompletion("p-1", ChallengeTypes.ProximityDwell));

            Assert.Equal(new[] { PinState.CompletedPendingSync, PinState.Active }, States(progress));
            Assert.Equal(1, progress.UnconfirmedCount);
        }

        [Fact]
        public void A_code_completion_holds_the_trail_until_the_server_has_checked_it()
        {
            var progress = new TrailProgress(
                Trail(ChallengeTypes.CodeEntry, ChallengeTypes.ProximityDwell),
                Attempt("active", "unlocked", "locked"),
                null);

            progress.ApplyLocalCompletion("p-1", ChallengeTypes.CodeEntry);

            Assert.Equal(new[] { PinState.AwaitingVerification, PinState.Locked }, States(progress));
            Assert.Null(progress.ActivePin);
        }

        [Fact]
        public void Refuses_a_local_completion_of_anything_but_the_active_pin()
        {
            var progress = new TrailProgress(
                Trail(ChallengeTypes.ProximityDwell, ChallengeTypes.ProximityDwell),
                Attempt("active", "unlocked", "locked"),
                null);

            Assert.False(progress.ApplyLocalCompletion("p-2", ChallengeTypes.ProximityDwell));
            Assert.Equal(new[] { PinState.Active, PinState.Locked }, States(progress));
        }

        [Fact]
        public void Replays_queued_completions_over_the_server_state_after_a_restart()
        {
            var progress = new TrailProgress(
                Trail(ChallengeTypes.ProximityDwell, ChallengeTypes.ProximityDwell, ChallengeTypes.ProximityDwell),
                Attempt("active", "unlocked", "locked", "locked"),
                new[] { Pending("p-1", ChallengeTypes.ProximityDwell), Pending("p-2", ChallengeTypes.ProximityDwell) });

            Assert.Equal(new[] { PinState.CompletedPendingSync, PinState.CompletedPendingSync, PinState.Active }, States(progress));
        }

        [Fact]
        public void An_expired_attempt_offers_nothing_to_play()
        {
            var progress = new TrailProgress(
                Trail(ChallengeTypes.ProximityDwell, ChallengeTypes.ProximityDwell),
                Attempt("expired", "unlocked", "locked"),
                null);

            Assert.Null(progress.ActivePin);
            Assert.True(progress.IsExpired);
        }

        [Fact]
        public void Applies_a_confirmation_the_way_the_server_did()
        {
            var progress = new TrailProgress(
                Trail(ChallengeTypes.ProximityDwell, ChallengeTypes.ProximityDwell),
                Attempt("active", "unlocked", "locked"),
                null);

            progress.ApplyConfirmation(new CompletionResponse { PinId = "p-1", NextPinId = "p-2", AttemptStatus = "active" }, null);
            Assert.Equal(new[] { PinState.Completed, PinState.Active }, States(progress));

            progress.ApplyConfirmation(new CompletionResponse { PinId = "p-2", NextPinId = null, AttemptStatus = "completed" }, null);
            Assert.True(progress.IsCompletedOnServer);
            Assert.True(progress.IsCompletedLocally);
        }

        [Fact]
        public void Refuses_to_render_one_version_s_pins_for_another_version_s_attempt()
        {
            AttemptDto attempt = Attempt("active", "unlocked");
            attempt.TrailVersionId = "v-2";

            Assert.Throws<ArgumentException>(() => new TrailProgress(Trail(ChallengeTypes.ProximityDwell), attempt, null));
        }
    }

    public class TrailCacheTests
    {
        [Fact]
        public void Serves_the_latest_current_version_and_any_version_by_id()
        {
            var cache = new TrailCache(new InMemoryKeyValueStore());
            cache.Put(new TrailDto { TrailId = "t-1", TrailVersionId = "v-2", Name = "New", IsCurrentVersion = true });
            cache.Put(new TrailDto { TrailId = "t-1", TrailVersionId = "v-1", Name = "Old", IsCurrentVersion = false });

            Assert.Equal("New", cache.GetLatest("t-1").Name);
            Assert.Equal("Old", cache.GetVersion("v-1").Name);
            Assert.Null(cache.GetLatest("t-unknown"));
        }
    }
}
