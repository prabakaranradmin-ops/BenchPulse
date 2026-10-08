using System;
using System.Collections.Concurrent;
using System.IO;
using System.Threading.Tasks;
using ArQuestTrail.Core;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// The one component a scene needs: put it on an empty GameObject, set the server URL, press
    /// Play. It builds the Core services, adds the other components it drives, and runs the
    /// per-frame loop. Players reach a trail through the app's screens (a join code or link); in
    /// the Editor it plays against the real server with a simulated walker, so the whole loop can
    /// be exercised before a phone is involved.
    /// </summary>
    public class QuestBootstrap : MonoBehaviour
    {
        [Header("Server")]
        [Tooltip("The https URL your tunnel exposes. Phones refuse plain http (iOS ATS, Android cleartext policy).")]
        [SerializeField] private string apiBaseUrl = "https://your-tunnel.example.com";

        [Tooltip("Optional shortcut for testing: open this trail directly (trailId from `npm run seed:field-test`), " +
                 "skipping the join screens. Leave empty to use join codes like a player.")]
        [SerializeField] private string trailId = "";

        [Header("Editor")]
        [Tooltip("The Editor has no GPS. A simulated walker stands in for the player.")]
        [SerializeField] private bool simulateLocationInEditor = true;

        [Tooltip("Where the simulated walker starts. 30m west of the first seeded pin is a good choice.")]
        [SerializeField] private double simulatedStartLat = 13.0827;

        [SerializeField] private double simulatedStartLng = 80.2704;

        public TrailManager Trail { get; private set; }

        public VpsLocalizationService Localization { get; private set; }

        public ProximityDwellChallenge Dwell { get; private set; }

        public QuestSession Session { get; private set; }

        /// <summary>Null on a device — only the Editor walks a simulated player.</summary>
        public SimulatedWalker Simulator { get; private set; }

        public AirplaneModeTransport Network { get; private set; }

        /// <summary>Which screen the player is on (Core's navigation rules).</summary>
        public AppFlow Flow { get; private set; }

        /// <summary>Null in the Editor's simulation; started only once location has been explained.</summary>
        private DeviceGpsSource _gps;
        private bool _gpsStarted;

        /// <summary>Work handed over from other threads (Android's permission callbacks), run in Update.</summary>
        private readonly ConcurrentQueue<Action> _mainThread = new ConcurrentQueue<Action>();

        private void Awake()
        {
            Trail = GetOrAdd<TrailManager>();
            Localization = GetOrAdd<VpsLocalizationService>();
            Dwell = GetOrAdd<ProximityDwellChallenge>();
            QuestHud hud = GetOrAdd<QuestHud>();
            AppScreens screens = GetOrAdd<AppScreens>();

            string root = Path.Combine(Application.persistentDataPath, "arquest");
            var data = new FileKeyValueStore(Path.Combine(root, "data"));
            // The device key lives in the app sandbox for the field test. Before launch it belongs
            // in iOS Keychain / Android Keystore — see client-unity/README.md.
            var identity = new DeviceIdentity(new FileKeyValueStore(Path.Combine(root, "identity")));

            Network = new AirplaneModeTransport(new UnityWebRequestTransport());
            var api = new QuestApiClient(Network, apiBaseUrl, identity);
            Session = new QuestSession(api, data, identity);
            Session.History.MarkSessionStarted(DateTimeOffset.UtcNow);
            Flow = new AppFlow(data);

            ILocationSource location;
            if (Application.isEditor && simulateLocationInEditor)
            {
                Simulator = new SimulatedWalker(new GeoPoint(simulatedStartLat, simulatedStartLng));
                location = Simulator;
            }
            else
            {
                _gps = new DeviceGpsSource();
                location = _gps;
            }

            Localization.Initialize(location);
            Trail.Initialize(Session);
            Dwell.OnChallengeCompleted += (pin, fix) => Fire(SubmitDwellAsync(pin, fix));
            // SR-PRIV-02: everything about this player is gone, so the app starts over as a first run.
            Session.PlayerDataDeleted += () => Flow.PlayerDataDeleted();
            Application.deepLinkActivated += OnDeepLink;
            hud.Initialize(this);
            screens.Initialize(this);
        }

        private void Start()
        {
            // A link that launched the app (arquest://join/CODE) waits in the flow until setup is done.
            if (!string.IsNullOrEmpty(Application.absoluteURL))
            {
                Flow.HandleLink(Application.absoluteURL);
            }

            bool? granted = LocationPermission.IsGranted();
            Flow.Start(granted);
            if (granted ?? Flow.HasAskedForLocation)
            {
                StartLocation();
            }

            if (!string.IsNullOrWhiteSpace(trailId))
            {
                PlayTrail(trailId);
            }
        }

        private void OnDestroy()
        {
            Application.deepLinkActivated -= OnDeepLink;
        }

        private void Update()
        {
            while (_mainThread.TryDequeue(out Action action))
            {
                action();
            }

            Simulator?.Tick(DateTimeOffset.UtcNow, Time.deltaTime);
            if (Flow.Screen != AppScreen.Playing)
            {
                // Location is used while a trail is being played, and only then: no history is
                // gathered in the menus, and no pin can complete from behind a menu.
                Dwell.Track(null);
                return;
            }

            PositionEstimate estimate = Localization.Current;
            if (estimate.Fix.HasValue)
            {
                // Every fix becomes SR-SEC-02 history, whichever source produced it.
                Session.History.Add(estimate.Fix.Value);
            }

            Dwell.Track(Session.Progress?.ActivePin?.Pin);
            if (estimate.Fix.HasValue)
            {
                Dwell.OnLocationUpdate(estimate.Fix.Value);
            }

            Camera viewer = Camera.main;
            Trail.UpdatePins(estimate, viewer != null ? viewer.transform : transform);
        }

        /// <summary>Welcome screen's "Get started".</summary>
        public void ContinueFromWelcome()
        {
            bool granted = LocationPermission.IsGranted() == true;
            Flow.ContinueFromWelcome(granted);
            if (granted)
            {
                StartLocation();
            }
        }

        /// <summary>The location screen's "Allow": the system prompt, now that the app has said why.</summary>
        public void RequestLocation()
        {
            LocationPermission.Request(granted => _mainThread.Enqueue(() =>
            {
                Flow.LocationPermissionAnswered();
                if (granted)
                {
                    StartLocation();
                }
            }));
        }

        /// <summary>Opens a trail on the play screen; <paramref name="startOver"/> begins a fresh attempt (GDR-06).</summary>
        public void PlayTrail(string id, bool startOver = false)
        {
            Flow.Play(id);
            Fire(BeginTrailAsync(id, startOver));
        }

        /// <summary>The play screen's back button.</summary>
        public void LeaveTrail()
        {
            Trail.Leave();
            Flow.Back();
        }

        private async Task BeginTrailAsync(string id, bool startOver)
        {
            await Trail.BeginAsync(id);
            if (startOver && Trail.Progress != null && Trail.Progress.IsExpired)
            {
                await Trail.ReplayAsync();
            }
        }

        private void OnDeepLink(string url)
        {
            bool wasPlaying = Flow.Screen == AppScreen.Playing;
            if (Flow.HandleLink(url) && wasPlaying)
            {
                Trail.Leave();
            }
        }

        private void StartLocation()
        {
            if (_gps == null || _gpsStarted)
            {
                return;
            }

            _gpsStarted = true;
            StartCoroutine(_gps.Start());
        }

        private void OnApplicationPause(bool paused)
        {
            if (!paused)
            {
                OnReturnToForeground();
            }
        }

        private void OnApplicationFocus(bool hasFocus)
        {
            if (hasFocus && Session != null)
            {
                OnReturnToForeground();
            }
        }

        /// <summary>The Editor walker can head for the active pin — the HUD's "walk there" button.</summary>
        public void WalkToActivePin(bool walk)
        {
            if (Simulator == null)
            {
                return;
            }

            PinDto pin = Session.Progress?.ActivePin?.Pin;
            Simulator.Target = walk && pin != null ? new GeoPoint(pin.Lat, pin.Lng) : (GeoPoint?)null;
        }

        /// <summary>ST-6.2: the player's typed answer, submitted with where they are standing now.</summary>
        public async Task SubmitCodeAsync(string answer)
        {
            PinDto pin = Session.Progress?.ActivePin?.Pin;
            LocationFix? fix = Localization.Current.Fix;
            if (pin == null || pin.ChallengeType != ChallengeTypes.CodeEntry)
            {
                return;
            }

            if (!fix.HasValue)
            {
                // The server re-checks position for code pins too — the code proves you read the
                // plaque, the fix proves you were standing at it — so there is nothing to send yet.
                Trail.ShowMessage("Waiting for your position before checking the code…");
                return;
            }

            await Trail.SubmitAsync(pin, fix.Value, answer);
        }

        private void OnReturnToForeground()
        {
            DateTimeOffset now = DateTimeOffset.UtcNow;
            // SR-SEC-02 suspends its check for 15s after a foreground — and only the client knows
            // when that was. §6.8 wants tracking back within 2s, so VPS gets a fresh attempt.
            Session.History.MarkSessionStarted(now);
            Localization.RequestLocalization();
            Fire(Trail.ResyncAsync());
        }

        private async Task SubmitDwellAsync(PinDto pin, LocationFix fix)
        {
            SubmitResult result = await Trail.SubmitAsync(pin, fix);
            if (result.Outcome == SubmitOutcome.Rejected || result.Outcome == SubmitOutcome.NotAccepted)
            {
                Dwell.ResetAfterRejection();
            }
        }

        private T GetOrAdd<T>() where T : Component
        {
            T existing = GetComponent<T>();
            return existing != null ? existing : gameObject.AddComponent<T>();
        }

        /// <summary>Runs a task from a Unity callback without letting an exception vanish.</summary>
        public static async void Fire(Task task)
        {
            try
            {
                await task;
            }
            catch (Exception exception)
            {
                Debug.LogException(exception);
            }
        }
    }
}
