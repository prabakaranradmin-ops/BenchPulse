using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using ArQuestTrail.Core;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// The trail as the scene sees it: loads it (cached for offline browsing, SR-NET-01), starts or
    /// resumes the player's attempt on the right version (GDR-06/07, CR-02), keeps one
    /// <see cref="PinController"/> per pin in step with <see cref="TrailProgress"/> (GDR-01), and
    /// syncs queued completions (SR-NET-02). All of the rules live in Core's QuestSession.
    /// </summary>
    public class TrailManager : MonoBehaviour
    {
        [Tooltip("Optional pin prefab with a PinController. Without one, a simple marker is built.")]
        [SerializeField] private PinController pinPrefab = null;

        [Tooltip("How often to retry queued completions while any are waiting.")]
        [SerializeField] private float flushIntervalSeconds = 15f;

        private readonly Dictionary<string, PinController> _pins = new Dictionary<string, PinController>();
        private float _nextFlushAt;
        private NetworkReachability _lastReachability;

        public QuestSession Session { get; private set; }

        public string TrailId { get; private set; }

        public TrailProgress Progress => Session?.Progress;

        /// <summary>One line for the HUD about where loading stands.</summary>
        public string Status { get; private set; } = "Starting…";

        /// <summary>The latest thing worth telling the player — a rejection, a confirmation.</summary>
        public string LastMessage { get; private set; }

        /// <summary>GDR-04: set once the server has recorded the final pin.</summary>
        public AttemptDto CompletedAttempt { get; private set; }

        public bool IsBusy { get; private set; }

        public event Action<PinDto, ApiError> OnCompletionRejected;

        public void Initialize(QuestSession session, string trailId)
        {
            Session = session;
            TrailId = trailId;
            _lastReachability = Application.internetReachability;

            session.ProgressChanged += SyncPins;
            session.CompletionConfirmed += (pin, response) =>
            {
                LastMessage = pin == null ? "Synced." : $"Pin {pin.SequenceIndex} confirmed.";
                if (response?.LocationFlag != null)
                {
                    // SR-SEC-02 flags, never blocks; it is logged server-side for review.
                    Debug.Log($"[SR-SEC-02] completion flagged: {response.LocationFlag.Reason}");
                }
            };
            session.CompletionRejected += (pin, error) =>
            {
                LastMessage = Describe(error);
                OnCompletionRejected?.Invoke(pin, error);
            };
            session.TrailCompleted += attempt => CompletedAttempt = attempt;
            session.PlayerDataDeleted += () =>
            {
                ClearPins();
                CompletedAttempt = null;
                Status = "Your data has been deleted. Restart the app to play as a new player.";
            };
        }

        public async Task BeginAsync()
        {
            if (string.IsNullOrWhiteSpace(TrailId))
            {
                Status = "No trail id set on QuestBootstrap — run `npm run seed:field-test` and paste one in.";
                return;
            }

            await Run(async () =>
            {
                Status = "Loading trail…";
                ApiResult<TrailDto> trail = await Session.LoadTrailAsync(TrailId);
                if (!trail.Ok)
                {
                    Status = "Couldn't load the trail: " + Describe(trail.Error);
                    return;
                }

                ApiResult<TrailProgress> progress = await Session.StartOrResumeAsync(TrailId);
                if (!progress.Ok)
                {
                    Status = "Couldn't start the trail: " + Describe(progress.Error);
                    return;
                }

                Status = progress.FromCache ? "Offline — playing from this device." : "Ready.";
                CompletedAttempt = progress.Value.IsCompletedOnServer ? progress.Value.Attempt : null;
                SyncPins();
            });
        }

        public async Task<SubmitResult> SubmitAsync(PinDto pin, LocationFix fix, string challengeAnswer = null)
        {
            SubmitResult result = await Session.SubmitCompletionAsync(pin, fix, challengeAnswer);
            switch (result.Outcome)
            {
                case SubmitOutcome.Queued:
                    LastMessage = ChallengeTypes.CanVerifyOnDevice(pin.ChallengeType)
                        ? "Saved — it will sync when you're back online."
                        : "Saved — your code will be checked when you're back online.";
                    break;
                case SubmitOutcome.NotAccepted:
                    LastMessage = "That pin isn't the one to play right now.";
                    break;
            }

            return result;
        }

        /// <summary>GDR-06: a fresh attempt; the finished one stays in the player's history.</summary>
        public Task ReplayAsync() => Run(async () =>
        {
            ApiResult<TrailProgress> replay = await Session.ReplayAsync(TrailId);
            if (replay.Ok)
            {
                CompletedAttempt = null;
                LastMessage = "New attempt started.";
            }
            else
            {
                LastMessage = "Couldn't restart: " + Describe(replay.Error);
            }

            SyncPins();
        });

        /// <summary>GDR-09: "can't find this pin".</summary>
        public Task ReportPinAsync(PinDto pin, string note) => Run(async () =>
        {
            ApiResult<PinReportResponse> report = await Session.ReportPinAsync(pin.PinId, note);
            LastMessage = report.Ok ? "Thanks — the trail author will take a look." : "Couldn't send the report: " + Describe(report.Error);
        });

        /// <summary>SR-PRIV-02.</summary>
        public Task DeleteMyDataAsync() => Run(async () =>
        {
            ApiResult<DeleteMyDataResponse> result = await Session.DeleteMyDataAsync();
            if (!result.Ok)
            {
                LastMessage = "Couldn't delete your data: " + Describe(result.Error);
            }
        });

        /// <summary>After returning to the foreground: re-read progress and send anything queued.</summary>
        public Task ResyncAsync() => Run(async () =>
        {
            await Session.RefreshProgressFromServerAsync();
            await Session.FlushAsync();
        });

        public void ShowMessage(string message) => LastMessage = message;

        public void UpdatePins(PositionEstimate estimate, Transform viewer)
        {
            foreach (PinController pin in _pins.Values)
            {
                pin.UpdatePlacement(estimate, viewer);
            }
        }

        private void Update()
        {
            if (Session == null || Session.PendingCompletions.Count == 0)
            {
                return;
            }

            // Retry on a timer, and immediately when the device says the network came back.
            NetworkReachability reachability = Application.internetReachability;
            bool reconnected = _lastReachability == NetworkReachability.NotReachable
                && reachability != NetworkReachability.NotReachable;
            _lastReachability = reachability;

            if (reconnected || Time.unscaledTime >= _nextFlushAt)
            {
                _nextFlushAt = Time.unscaledTime + flushIntervalSeconds;
                QuestBootstrap.Fire(Session.FlushAsync());
            }
        }

        private void SyncPins()
        {
            TrailProgress progress = Progress;
            if (progress == null)
            {
                ClearPins();
                return;
            }

            // A replay or a resumed older version can change which pins exist.
            var wanted = new HashSet<string>();
            foreach (PinView view in progress.Pins)
            {
                wanted.Add(view.Pin.PinId);
                if (!_pins.TryGetValue(view.Pin.PinId, out PinController controller))
                {
                    controller = pinPrefab != null
                        ? Instantiate(pinPrefab)
                        : new GameObject("Pin").AddComponent<PinController>();
                    controller.Initialize(view.Pin);
                    _pins[view.Pin.PinId] = controller;
                }

                controller.SetState(view.State);
            }

            foreach (string stale in new List<string>(_pins.Keys))
            {
                if (!wanted.Contains(stale))
                {
                    _pins[stale].Despawn();
                    _pins.Remove(stale);
                }
            }
        }

        private void ClearPins()
        {
            foreach (PinController pin in _pins.Values)
            {
                if (pin != null)
                {
                    pin.Despawn();
                }
            }

            _pins.Clear();
        }

        private async Task Run(Func<Task> work)
        {
            IsBusy = true;
            try
            {
                await work();
            }
            finally
            {
                IsBusy = false;
            }
        }

        /// <summary>Player-facing wording for a failure; the server's own hint wins when it sent one.</summary>
        public static string Describe(ApiError error)
        {
            if (error == null)
            {
                return "Something went wrong.";
            }

            if (!string.IsNullOrEmpty(error.Message) && error.Kind != ApiErrorKind.Network)
            {
                return error.Message;
            }

            switch (error.Code)
            {
                case "outside_effective_radius":
                    return error.Body?.DistanceM != null
                        ? $"Not close enough yet — {error.Body.DistanceM.Value:0} m away."
                        : "Not close enough yet.";
                case "accuracy_exceeds_ceiling":
                    return "GPS signal weak — move to open sky";
                case "incorrect_code":
                    return "That code doesn't match — check the plaque and try again.";
                case "attempt_expired":
                    return "This attempt has expired — start a new one.";
                case "recorded_at_in_future":
                case "recorded_at_before_attempt":
                    return "This phone's clock looks wrong — set it to automatic time and try again.";
                case "superseded_by_rejection":
                    return "An earlier pin wasn't accepted, so this one needs to be played again.";
            }

            switch (error.Kind)
            {
                case ApiErrorKind.Network:
                    return "You're offline.";
                case ApiErrorKind.RateLimited:
                    return "Too many requests — wait a moment.";
                case ApiErrorKind.Server:
                    return "The server had a problem — it will retry.";
                default:
                    return error.Code ?? $"Request failed ({error.StatusCode}).";
            }
        }
    }
}
