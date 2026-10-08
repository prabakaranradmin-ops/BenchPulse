using System;

namespace ArQuestTrail.Core
{
    public enum AppScreen
    {
        /// <summary>First run: what the game is.</summary>
        Welcome,

        /// <summary>Why the app needs location, before the operating system asks.</summary>
        LocationPermission,

        /// <summary>The trails this player has joined.</summary>
        MyTrails,

        /// <summary>Enter a code, or confirm one that arrived in a link.</summary>
        JoinTrail,

        /// <summary>One trail: what it is and where the player stands on it.</summary>
        TrailDetails,

        /// <summary>The trail itself — the HUD today, the AR view after the field test.</summary>
        Playing,

        /// <summary>Privacy, and deleting this player's data.</summary>
        Settings,
    }

    /// <summary>
    /// Which non-AR screen the player is on and where each action leads (decision 2026-10-07 #5:
    /// these screens now, the AR view's polish after the field test). Plain state, so the flow is
    /// tested in Core and the Unity layer only draws <see cref="Screen"/> and reports taps.
    /// </summary>
    public sealed class AppFlow
    {
        private const string OnboardedKey = "onboarding_done";
        private const string LocationAskedKey = "location_permission_asked";

        private readonly IKeyValueStore _store;

        public AppFlow(IKeyValueStore store)
        {
            _store = store ?? throw new ArgumentNullException(nameof(store));
        }

        public AppScreen Screen { get; private set; } = AppScreen.Welcome;

        /// <summary>The trail the details and play screens are about.</summary>
        public string SelectedTrailId { get; private set; }

        /// <summary>A code from a link that opened the app, waiting for the join screen.</summary>
        public string PendingJoinCode { get; private set; }

        public bool HasOnboarded => _store.Get(OnboardedKey) != null;

        /// <summary>Whether the location explanation has been shown and the system asked, on this install.</summary>
        public bool HasAskedForLocation => _store.Get(LocationAskedKey) != null;

        public event Action<AppScreen> ScreenChanged;

        /// <summary>
        /// Where the app opens. <paramref name="locationGranted"/> is the platform's answer where
        /// it can give one (Android); null where it can't (iOS reports only after asking), in which
        /// case having asked once is taken as answered — the play screen says if location is off.
        /// </summary>
        public void Start(bool? locationGranted)
        {
            if (!HasOnboarded)
            {
                GoTo(AppScreen.Welcome);
            }
            else if (!(locationGranted ?? HasAskedForLocation))
            {
                GoTo(AppScreen.LocationPermission);
            }
            else
            {
                GoTo(PendingJoinCode != null ? AppScreen.JoinTrail : AppScreen.MyTrails);
            }
        }

        public void ContinueFromWelcome(bool locationGranted)
        {
            _store.Set(OnboardedKey, "1");
            if (locationGranted)
            {
                AfterSetup();
            }
            else
            {
                GoTo(AppScreen.LocationPermission);
            }
        }

        /// <summary>The player answered — either way. Location being off is shown while playing, not a dead end.</summary>
        public void LocationPermissionAnswered()
        {
            _store.Set(LocationAskedKey, "1");
            AfterSetup();
        }

        /// <summary>
        /// An <c>arquest://join/CODE</c> link or a pasted …/join/CODE URL. During first-run setup the
        /// code waits until setup is done. False if the link carries no code.
        /// </summary>
        public bool HandleLink(string url)
        {
            string code = JoinCode.FromInput(url);
            if (code == null)
            {
                return false;
            }

            PendingJoinCode = code;
            if (Screen != AppScreen.Welcome && Screen != AppScreen.LocationPermission)
            {
                GoTo(AppScreen.JoinTrail);
            }

            return true;
        }

        public void OpenJoin() => GoTo(AppScreen.JoinTrail);

        /// <summary>The join screen has used (or given up on) the code a link brought.</summary>
        public void ConsumePendingJoinCode() => PendingJoinCode = null;

        public void Joined(string trailId)
        {
            PendingJoinCode = null;
            OpenTrail(trailId);
        }

        public void OpenTrail(string trailId)
        {
            if (string.IsNullOrEmpty(trailId))
            {
                throw new ArgumentException("A trail id is required.", nameof(trailId));
            }

            SelectedTrailId = trailId;
            GoTo(AppScreen.TrailDetails);
        }

        /// <summary>Straight into a trail — the trail details screen's Start, or the Editor shortcut.</summary>
        public void Play(string trailId = null)
        {
            if (trailId != null)
            {
                SelectedTrailId = trailId;
            }

            if (SelectedTrailId == null)
            {
                throw new InvalidOperationException("Choose a trail before playing.");
            }

            GoTo(AppScreen.Playing);
        }

        public void OpenSettings() => GoTo(AppScreen.Settings);

        /// <summary>Every screen past setup leads back to the trail list.</summary>
        public void Back()
        {
            switch (Screen)
            {
                case AppScreen.JoinTrail:
                    PendingJoinCode = null;
                    GoTo(AppScreen.MyTrails);
                    break;
                case AppScreen.Playing:
                    GoTo(SelectedTrailId != null ? AppScreen.TrailDetails : AppScreen.MyTrails);
                    break;
                case AppScreen.TrailDetails:
                case AppScreen.Settings:
                    GoTo(AppScreen.MyTrails);
                    break;
            }
        }

        /// <summary>The trail was taken off the list from its details screen.</summary>
        public void TrailRemoved()
        {
            SelectedTrailId = null;
            GoTo(AppScreen.MyTrails);
        }

        /// <summary>SR-PRIV-02: the player's data is gone (the store was cleared with it), so this is a first run again.</summary>
        public void PlayerDataDeleted()
        {
            SelectedTrailId = null;
            PendingJoinCode = null;
            GoTo(AppScreen.Welcome);
        }

        private void AfterSetup() => GoTo(PendingJoinCode != null ? AppScreen.JoinTrail : AppScreen.MyTrails);

        private void GoTo(AppScreen screen)
        {
            if (Screen == screen)
            {
                return;
            }

            Screen = screen;
            ScreenChanged?.Invoke(screen);
        }
    }
}
