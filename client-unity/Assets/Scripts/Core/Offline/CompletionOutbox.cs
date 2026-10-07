using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace ArQuestTrail.Core
{
    /// <summary>A completion waiting to be confirmed by the server, persisted across restarts.</summary>
    public sealed class PendingCompletion
    {
        public string Id { get; set; }
        public string AttemptId { get; set; }
        public string PinId { get; set; }
        public int SequenceIndex { get; set; }
        public string ChallengeType { get; set; }

        /// <summary>Stored exactly as it will be sent, capture timestamp included (SR-NET-02).</summary>
        public CompletionRequest Request { get; set; }

        public string QueuedAt { get; set; }
    }

    public enum OutboxOutcome
    {
        /// <summary>The server accepted it (or had already, from a send whose reply was lost).</summary>
        Confirmed,

        /// <summary>The server judged it and said no — too far, wrong code, attempt expired, …</summary>
        Rejected,

        /// <summary>Dropped unsent: an earlier pin of the same attempt was rejected, so GDR-01 dooms it.</summary>
        Superseded,
    }

    public sealed class OutboxItemResult
    {
        public OutboxItemResult(PendingCompletion item, OutboxOutcome outcome, CompletionResponse response, ApiError error)
        {
            Item = item;
            Outcome = outcome;
            Response = response;
            Error = error;
        }

        public PendingCompletion Item { get; }
        public OutboxOutcome Outcome { get; }

        /// <summary>Null for an idempotent re-confirmation (409 pin_already_completed) — resync instead.</summary>
        public CompletionResponse Response { get; }

        public ApiError Error { get; }
    }

    public sealed class FlushReport
    {
        public List<OutboxItemResult> Results { get; } = new List<OutboxItemResult>();

        /// <summary>Stopped early on a retryable failure; everything left is still queued, in order.</summary>
        public bool Deferred { get; set; }

        /// <summary>Why the flush deferred, when it did.</summary>
        public ApiError DeferredBecause { get; set; }

        public int Remaining { get; set; }
    }

    /// <summary>
    /// SR-NET-02 / ST-9.1. Every completion goes through here, online or not: it is persisted
    /// first and sent second, so a request that dies mid-flight — offline, a timeout, the app
    /// killed — is retried instead of lost. Items are sent strictly in order, because the server
    /// only accepts pin n+1 once pin n is complete (GDR-01).
    /// </summary>
    public sealed class CompletionOutbox
    {
        private const string StoreKey = "completion_outbox";

        private readonly IKeyValueStore _store;
        private readonly ICompletionApi _api;
        private readonly IClock _clock;
        private List<PendingCompletion> _queue;
        private Task<FlushReport> _inFlight;

        public CompletionOutbox(IKeyValueStore store, ICompletionApi api, IClock clock = null)
        {
            _store = store;
            _api = api;
            _clock = clock ?? SystemClock.Instance;
            _queue = Load();
        }

        public IReadOnlyList<PendingCompletion> Pending => _queue;

        public PendingCompletion Enqueue(
            string attemptId,
            string pinId,
            int sequenceIndex,
            string challengeType,
            CompletionRequest request)
        {
            var item = new PendingCompletion
            {
                Id = Guid.NewGuid().ToString("N"),
                AttemptId = attemptId,
                PinId = pinId,
                SequenceIndex = sequenceIndex,
                ChallengeType = challengeType,
                Request = request,
                QueuedAt = IsoTime.ToWire(_clock.UtcNow),
            };
            _queue.Add(item);
            Save();
            return item;
        }

        public bool IsPending(string attemptId, string pinId) =>
            _queue.Exists(item => item.AttemptId == attemptId && item.PinId == pinId);

        /// <summary>
        /// Sends what's queued. Concurrent callers share the one flush in progress rather than
        /// starting a second, which would send the same completion twice.
        /// </summary>
        public Task<FlushReport> FlushAsync(CancellationToken cancellationToken = default)
        {
            if (_inFlight != null && !_inFlight.IsCompleted)
            {
                return _inFlight;
            }

            _inFlight = FlushCoreAsync(cancellationToken);
            return _inFlight;
        }

        /// <summary>Drops everything — SR-PRIV-02 deletion; queued items hold location data.</summary>
        public void Clear()
        {
            _queue.Clear();
            _store.Delete(StoreKey);
        }

        private async Task<FlushReport> FlushCoreAsync(CancellationToken cancellationToken)
        {
            var report = new FlushReport();

            while (_queue.Count > 0)
            {
                PendingCompletion item = _queue[0];
                ApiResult<CompletionResponse> result =
                    await _api.CompletePinAsync(item.AttemptId, item.PinId, item.Request, cancellationToken);

                if (result.Ok)
                {
                    Remove(item);
                    report.Results.Add(new OutboxItemResult(item, OutboxOutcome.Confirmed, result.Value, null));
                    continue;
                }

                ApiError error = result.Error;
                if (error.Code == "pin_already_completed")
                {
                    // An earlier send landed but its reply never arrived. Same outcome as a 200.
                    Remove(item);
                    report.Results.Add(new OutboxItemResult(item, OutboxOutcome.Confirmed, null, null));
                    continue;
                }

                if (error.IsRetryable || error.Kind == ApiErrorKind.Unauthorized)
                {
                    // Not judged at all — keep it and everything behind it, in order, for next time.
                    report.Deferred = true;
                    report.DeferredBecause = error;
                    break;
                }

                Remove(item);
                report.Results.Add(new OutboxItemResult(item, OutboxOutcome.Rejected, null, error));

                // Later pins of the same attempt were only reachable through this one (GDR-01);
                // sending them would just collect pin_locked. Other attempts are unaffected.
                foreach (PendingCompletion dependent in _queue.FindAll(other => other.AttemptId == item.AttemptId))
                {
                    Remove(dependent);
                    report.Results.Add(new OutboxItemResult(dependent, OutboxOutcome.Superseded, null, null));
                }
            }

            report.Remaining = _queue.Count;
            return report;
        }

        private void Remove(PendingCompletion item)
        {
            _queue.Remove(item);
            Save();
        }

        private List<PendingCompletion> Load()
        {
            string json = _store.Get(StoreKey);
            return json == null
                ? new List<PendingCompletion>()
                : Json.Deserialize<List<PendingCompletion>>(json) ?? new List<PendingCompletion>();
        }

        private void Save() => _store.Set(StoreKey, Json.Serialize(_queue));
    }
}
