using System;
using System.IO;
using System.Threading.Tasks;
using ArQuestTrail.Core;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// The one component a scene needs: put it on an empty GameObject, set the server URL and a
    /// trail id, press Play. It builds the Core services, adds the other components it drives,
    /// and runs the per-frame loop. In the Editor it plays against the real server with a
    /// simulated walker, so the whole loop can be exercised before a phone is involved.
    /// </summary>
    public class QuestBootstrap : MonoBehaviour
    {
        [Header("Server")]
        [Tooltip("The https URL your tunnel exposes. Phones refuse plain http (iOS ATS, Android cleartext policy).")]
        [SerializeField] private string apiBaseUrl = "https://your-tunnel.example.com";

        [Tooltip("From `npm run seed:field-test` (trailId in its output).")]
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

        private void Awake()
        {
            Trail = GetOrAdd<TrailManager>();
            Localization = GetOrAdd<VpsLocalizationService>();
            Dwell = GetOrAdd<ProximityDwellChallenge>();
            QuestHud hud = GetOrAdd<QuestHud>();

            string root = Path.Combine(Application.persistentDataPath, "arquest");
            var data = new FileKeyValueStore(Path.Combine(root, "data"));
            // The device key lives in the app sandbox for the field test. Before launch it belongs
            // in iOS Keychain / Android Keystore — see client-unity/README.md.
            var identity = new DeviceIdentity(new FileKeyValueStore(Path.Combine(root, "identity")));

            Network = new AirplaneModeTransport(new UnityWebRequestTransport());
            var api = new QuestApiClient(Network, apiBaseUrl, identity);
            Session = new QuestSession(api, data, identity);
            Session.History.MarkSessionStarted(DateTimeOffset.UtcNow);

            ILocationSource location;
            if (Application.isEditor && simulateLocationInEditor)
            {
                Simulator = new SimulatedWalker(new GeoPoint(simulatedStartLat, simulatedStartLng));
                location = Simulator;
            }
            else
            {
                var gps = new DeviceGpsSource();
                StartCoroutine(gps.Start());
                location = gps;
            }

            Localization.Initialize(location);
            Trail.Initialize(Session, trailId);
            Dwell.OnChallengeCompleted += (pin, fix) => Fire(SubmitDwellAsync(pin, fix));
            hud.Initialize(this);
        }

        private void Start()
        {
            Fire(Trail.BeginAsync());
        }

        private void Update()
        {
            Simulator?.Tick(DateTimeOffset.UtcNow, Time.deltaTime);

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
