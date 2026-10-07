using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace ArQuestTrail.Core
{
    public enum SubmitOutcome
    {
        /// <summary>The pin isn't the active one (or its type isn't playable) — nothing was sent.</summary>
        NotAccepted,

        /// <summary>The server recorded it.</summary>
        Confirmed,

        /// <summary>The server judged it and said no; see the error (e.g. incorrect_code).</summary>
        Rejected,

        /// <summary>Saved on the device and will be sent when the connection returns (SR-NET-02).</summary>
        Queued,
    }

    public sealed class SubmitResult
    {
        public SubmitResult(SubmitOutcome outcome, CompletionResponse response = null, ApiError error = null)
        {
            Outcome = outcome;
            Response = response;
            Error = error;
        }

        public SubmitOutcome Outcome { get; }
        public CompletionResponse Response { get; }
        public ApiError Error { get; }
    }

    /// <summary>
    /// The client's game session over one trail: loads the trail (cache first when offline),
    /// starts or resumes the player's attempt on the right version, and routes every completion
    /// through the outbox. The Unity layer drives this and renders <see cref="Progress"/>; nothing
    /// here touches Unity, which is what lets it be tested end to end against the real server.
    /// </summary>
    public sealed class QuestSession
    {
        private static readonly ApiError SupersededError = new ApiError(
            0,
            ApiErrorKind.Conflict,
            "superseded_by_rejection",
            "An earlier pin in this trail wasn't accepted, so this one needs to be played again.",
            null);

        private readonly QuestApiClient _api;
        private readonly IKeyValueStore _data;
        private readonly DeviceIdentity _identity;
        private readonly TrailCache _trails;
        private readonly CompletionOutbox _outbox;

        public QuestSession(QuestApiClient api, IKeyValueStore dataStore, DeviceIdentity identity, IClock clock = null)
        {
            _api = api ?? throw new ArgumentNullException(nameof(api));
            _data = dataStore ?? throw new ArgumentNullException(nameof(dataStore));
            _identity = identity ?? throw new ArgumentNullException(nameof(identity));
            _trails = new TrailCache(dataStore);
            _outbox = new CompletionOutbox(dataStore, api, clock);
        }

        /// <summary>SR-SEC-02's input; the Unity layer adds every fix and marks each foreground.</summary>
        public LocationHistoryBuffer History { get; } = new LocationHistoryBuffer();

        public TrailProgress Progress { get; private set; }

        /// <summary>CR-04 / ST-9.2: the last network call failed for lack of a connection.</summary>
        public bool IsOffline { get; private set; }

        public IReadOnlyList<PendingCompletion> PendingCompletions => _outbox.Pending;

        public event Action ProgressChanged;

        public event Action<PinDto, CompletionResponse> CompletionConfirmed;

        public event Action<PinDto, ApiError> CompletionRejected;

        /// <summary>GDR-04: the server has recorded the final pin — show the summary.</summary>
        public event Action<AttemptDto> TrailCompleted;

        /// <summary>SR-PRIV-02: local data and the device key are gone; restart as a new player.</summary>
        public event Action PlayerDataDeleted;

        /// <summary>SR-NET-01: the current trail from the network, or the cached copy when offline.</summary>
        public async Task<ApiResult<TrailDto>> LoadTrailAsync(string trailId, CancellationToken cancellationToken = default)
        {
            ApiResult<TrailDto> result = await _api.GetTrailAsync(trailId, cancellationToken);
            if (result.Ok)
            {
                _trails.Put(result.Value);
                MarkReachable();
                return result;
            }

            if (result.Error.IsRetryable)
            {
                MarkUnreachable(result.Error);
                TrailDto cached = _trails.GetLatest(trailId);
                if (cached != null)
                {
                    return ApiResult<TrailDto>.Success(cached, fromCache: true);
                }
            }

            return result;
        }

        /// <summary>
        /// Resumes this trail's attempt if there is one (CR-02), otherwise starts one (GDR-06).
        /// Always resolves the pins of the version the attempt is playing (GDR-07), which after an
        /// Admin republish is not the version <see cref="LoadTrailAsync"/> returns.
        /// </summary>
        public async Task<ApiResult<TrailProgress>> StartOrResumeAsync(string trailId, CancellationToken cancellationToken = default)
        {
            AttemptDto attempt = null;
            bool fromCache = false;
            string attemptId = _data.Get(AttemptKey(trailId));

            if (attemptId != null)
            {
                ApiResult<AttemptDto> fetched = await _api.GetAttemptAsync(attemptId, cancellationToken);
                if (fetched.Ok)
                {
                    attempt = fetched.Value;
                    MarkReachable();
                }
                else if (fetched.Error.IsRetryable)
                {
                    MarkUnreachable(fetched.Error);
                    attempt = LoadAttemptSnapshot(attemptId);
                    fromCache = true;
                    if (attempt == null)
                    {
                        return ApiResult<TrailProgress>.Failure(fetched.Error);
                    }
                }
                else if (fetched.Error.Kind == ApiErrorKind.NotFound)
                {
                    // The server no longer has it for this player; start over rather than strand them.
                    _data.Delete(AttemptKey(trailId));
                }
                else
                {
                    return Fail(fetched.Error);
                }
            }

            if (attempt == null)
            {
                ApiResult<AttemptDto> started = await _api.StartAttemptAsync(trailId, cancellationToken);
                if (!started.Ok)
                {
                    // Starting needs the server — it snapshots the version (GDR-07) — so there is
                    // no offline fallback for a trail never started on this device.
                    return Fail(started.Error);
                }

                attempt = started.Value;
                _data.Set(AttemptKey(trailId), attempt.AttemptId);
                MarkReachable();
            }

            return await AdoptAttemptAsync(attempt, fromCache, cancellationToken);
        }

        /// <summary>GDR-06: a fresh attempt; the previous one, completed or not, is left untouched.</summary>
        public async Task<ApiResult<TrailProgress>> ReplayAsync(string trailId, CancellationToken cancellationToken = default)
        {
            ApiResult<AttemptDto> started = await _api.StartAttemptAsync(trailId, cancellationToken);
            if (!started.Ok)
            {
                return Fail(started.Error);
            }

            _data.Set(AttemptKey(trailId), started.Value.AttemptId);
            MarkReachable();
            return await AdoptAttemptAsync(started.Value, false, cancellationToken);
        }

        /// <summary>
        /// Submits a completion for the active pin. It is persisted before it is sent, so going
        /// offline — or the app dying — can delay it but not lose it (SR-NET-02).
        /// </summary>
        public async Task<SubmitResult> SubmitCompletionAsync(
            PinDto pin,
            LocationFix fix,
            string challengeAnswer = null,
            CancellationToken cancellationToken = default)
        {
            if (Progress == null)
            {
                throw new InvalidOperationException("Start or resume an attempt before submitting completions.");
            }

            PinView view = Progress.Find(pin.PinId);
            if (view == null || !view.IsInteractable || !ChallengeTypes.IsSupported(pin.ChallengeType))
            {
                return new SubmitResult(SubmitOutcome.NotAccepted);
            }

            CompletionRequest request = BuildRequest(fix, challengeAnswer);
            PendingCompletion item = _outbox.Enqueue(
                Progress.Attempt.AttemptId,
                pin.PinId,
                pin.SequenceIndex,
                pin.ChallengeType,
                request);
            Progress.ApplyLocalCompletion(pin.PinId, pin.ChallengeType);
            ProgressChanged?.Invoke();

            FlushReport report = await FlushAsync(cancellationToken);
            OutboxItemResult mine = report.Results.FirstOrDefault(result => result.Item.Id == item.Id);
            if (mine == null)
            {
                return new SubmitResult(SubmitOutcome.Queued, error: report.DeferredBecause);
            }

            switch (mine.Outcome)
            {
                case OutboxOutcome.Confirmed:
                    return new SubmitResult(SubmitOutcome.Confirmed, mine.Response);
                case OutboxOutcome.Superseded:
                    return new SubmitResult(SubmitOutcome.Rejected, error: SupersededError);
                default:
                    return new SubmitResult(SubmitOutcome.Rejected, error: mine.Error);
            }
        }

        /// <summary>Sends anything queued — call when connectivity returns, and periodically.</summary>
        public async Task<FlushReport> FlushAsync(CancellationToken cancellationToken = default)
        {
            if (_outbox.Pending.Count == 0)
            {
                return new FlushReport();
            }

            bool wasCompleted = Progress?.IsCompletedOnServer ?? false;
            FlushReport report = await _outbox.FlushAsync(cancellationToken);

            if (report.Deferred && report.DeferredBecause?.Kind == ApiErrorKind.Network)
            {
                MarkUnreachable(report.DeferredBecause);
            }
            else
            {
                MarkReachable();
            }

            if (report.Results.Count > 0 && Progress != null)
            {
                foreach (OutboxItemResult result in report.Results)
                {
                    if (result.Outcome == OutboxOutcome.Confirmed && result.Response != null
                        && result.Item.AttemptId == Progress.Attempt.AttemptId)
                    {
                        Progress.ApplyConfirmation(result.Response, _outbox.Pending);
                    }
                }

                await RefreshProgressFromServerAsync(cancellationToken);
            }

            foreach (OutboxItemResult result in report.Results)
            {
                PinDto pin = Progress?.Find(result.Item.PinId)?.Pin;
                switch (result.Outcome)
                {
                    case OutboxOutcome.Confirmed:
                        CompletionConfirmed?.Invoke(pin, result.Response);
                        break;
                    case OutboxOutcome.Rejected:
                        CompletionRejected?.Invoke(pin, result.Error);
                        break;
                    case OutboxOutcome.Superseded:
                        CompletionRejected?.Invoke(pin, SupersededError);
                        break;
                }
            }

            ProgressChanged?.Invoke();
            if (!wasCompleted && Progress != null && Progress.IsCompletedOnServer)
            {
                TrailCompleted?.Invoke(Progress.Attempt);
            }

            return report;
        }

        /// <summary>Re-reads the attempt (e.g. on returning to the foreground) so the view is the server's.</summary>
        public async Task<bool> RefreshProgressFromServerAsync(CancellationToken cancellationToken = default)
        {
            if (Progress == null)
            {
                return false;
            }

            ApiResult<AttemptDto> fetched = await _api.GetAttemptAsync(Progress.Attempt.AttemptId, cancellationToken);
            if (fetched.Ok)
            {
                MarkReachable();
                SaveAttemptSnapshot(fetched.Value);
                Progress.Rebuild(fetched.Value, _outbox.Pending);
                ProgressChanged?.Invoke();
                return true;
            }

            if (fetched.Error.IsRetryable)
            {
                MarkUnreachable(fetched.Error);
            }

            // Without the server, fold what is still queued over the last known truth.
            Progress.Rebuild(Progress.Attempt, _outbox.Pending);
            SaveAttemptSnapshot(Progress.Attempt);
            return false;
        }

        /// <summary>GDR-09: "can't find this pin".</summary>
        public Task<ApiResult<PinReportResponse>> ReportPinAsync(
            string pinId,
            string note,
            CancellationToken cancellationToken = default) =>
            _api.ReportPinAsync(pinId, note, cancellationToken);

        /// <summary>
        /// SR-PRIV-02. On success the server has deleted the player; this then deletes everything
        /// the device holds about them too — queued completions included, since those carry location
        /// data — and discards the device key, as the server instructs.
        /// </summary>
        public async Task<ApiResult<DeleteMyDataResponse>> DeleteMyDataAsync(CancellationToken cancellationToken = default)
        {
            ApiResult<DeleteMyDataResponse> result = await _api.DeleteMyDataAsync(cancellationToken);
            if (result.Ok)
            {
                WipeLocalPlayerData();
            }

            return result;
        }

        private async Task<ApiResult<TrailProgress>> AdoptAttemptAsync(
            AttemptDto attempt,
            bool attemptFromCache,
            CancellationToken cancellationToken)
        {
            SaveAttemptSnapshot(attempt);

            ApiResult<TrailDto> version = await ResolveTrailVersionAsync(attempt.TrailId, attempt.TrailVersionId, cancellationToken);
            if (!version.Ok)
            {
                return ApiResult<TrailProgress>.Failure(version.Error);
            }

            Progress = new TrailProgress(version.Value, attempt, _outbox.Pending);
            ProgressChanged?.Invoke();
            return ApiResult<TrailProgress>.Success(Progress, attemptFromCache);
        }

        /// <summary>Versions are immutable once published, so a cached copy is never stale.</summary>
        private async Task<ApiResult<TrailDto>> ResolveTrailVersionAsync(
            string trailId,
            string trailVersionId,
            CancellationToken cancellationToken)
        {
            TrailDto cached = _trails.GetVersion(trailVersionId);
            if (cached != null)
            {
                return ApiResult<TrailDto>.Success(cached, fromCache: true);
            }

            ApiResult<TrailDto> fetched = await _api.GetTrailVersionAsync(trailId, trailVersionId, cancellationToken);
            if (fetched.Ok)
            {
                _trails.Put(fetched.Value);
                MarkReachable();
            }
            else if (fetched.Error.IsRetryable)
            {
                MarkUnreachable(fetched.Error);
            }

            return fetched;
        }

        private CompletionRequest BuildRequest(LocationFix fix, string challengeAnswer)
        {
            // The completion fix belongs in the history the server checks it against (SR-SEC-02).
            History.Add(fix);
            List<LocationSampleDto> samples = History.Snapshot(fix.RecordedAt)
                .Select(sample => new LocationSampleDto
                {
                    Lat = sample.Lat,
                    Lng = sample.Lng,
                    AccuracyM = sample.AccuracyM,
                    RecordedAt = IsoTime.ToWire(sample.RecordedAt),
                })
                .ToList();

            return new CompletionRequest
            {
                Lat = fix.Lat,
                Lng = fix.Lng,
                AccuracyM = fix.AccuracyM,
                // Built now, at capture time, and stored as-is: a completion sent hours later
                // still carries the moment it happened (SR-NET-02).
                RecordedAt = IsoTime.ToWire(fix.RecordedAt),
                SessionStartedAt = History.SessionStartedAt.HasValue
                    ? IsoTime.ToWire(History.SessionStartedAt.Value)
                    : null,
                RecentLocationHistory = samples.Count > 0 ? samples : null,
                ChallengeAnswer = string.IsNullOrWhiteSpace(challengeAnswer) ? null : challengeAnswer,
            };
        }

        private ApiResult<TrailProgress> Fail(ApiError error)
        {
            if (error.IsRetryable)
            {
                MarkUnreachable(error);
            }

            if (error.Kind == ApiErrorKind.PlayerGone)
            {
                WipeLocalPlayerData();
            }

            return ApiResult<TrailProgress>.Failure(error);
        }

        private void WipeLocalPlayerData()
        {
            _outbox.Clear();
            _data.Clear();
            _identity.Forget();
            _api.ForgetSession();
            History.Clear();
            Progress = null;
            PlayerDataDeleted?.Invoke();
            ProgressChanged?.Invoke();
        }

        private void MarkReachable() => IsOffline = false;

        private void MarkUnreachable(ApiError error)
        {
            if (error.Kind == ApiErrorKind.Network)
            {
                IsOffline = true;
            }
        }

        private void SaveAttemptSnapshot(AttemptDto attempt) =>
            _data.Set(AttemptSnapshotKey(attempt.AttemptId), Json.Serialize(attempt));

        private AttemptDto LoadAttemptSnapshot(string attemptId)
        {
            string json = _data.Get(AttemptSnapshotKey(attemptId));
            return json == null ? null : Json.Deserialize<AttemptDto>(json);
        }

        private static string AttemptKey(string trailId) => "attempt_for_trail_" + trailId;

        private static string AttemptSnapshotKey(string attemptId) => "attempt_snapshot_" + attemptId;
    }
}
