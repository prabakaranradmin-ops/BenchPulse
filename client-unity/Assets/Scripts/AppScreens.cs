using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using ArQuestTrail.Core;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// The non-AR screens (decision 2026-10-07 #5): first-run welcome, the location explanation,
    /// My trails, joining by code or link (ST-2.10), a trail's details, and settings with
    /// delete-my-data (SR-PRIV-02). Where each tap leads is Core's <see cref="AppFlow"/>; this only
    /// draws the current screen. While a trail is being played, <see cref="QuestHud"/> draws instead.
    /// </summary>
    public class AppScreens : MonoBehaviour
    {
        private QuestBootstrap _game;
        private Vector2 _scroll;
        private string _codeInput = string.Empty;
        private string _joinError;
        private bool _joining;
        private string _autoJoinedCode;
        private bool _confirmingRemove;
        private bool _confirmingDelete;
        private bool _deleting;
        private string _settingsError;

        /// <summary>
        /// The library as of the last read. OnGUI runs several times a frame and the library lives
        /// in a file, so screens draw this snapshot rather than reading storage on every pass.
        /// </summary>
        private IReadOnlyList<LibraryEntry> _entries = Array.Empty<LibraryEntry>();
        private float _entriesReadAt = float.NegativeInfinity;

        public void Initialize(QuestBootstrap game)
        {
            _game = game;
            game.Flow.ScreenChanged += OnScreenChanged;
        }

        private AppFlow Flow => _game.Flow;

        private QuestSession Session => _game.Session;

        private void Update()
        {
            if (_game == null)
            {
                return;
            }

            // A background sync can finish a trail while the list is open; re-read now and then.
            bool showsLibrary = Flow.Screen == AppScreen.MyTrails || Flow.Screen == AppScreen.TrailDetails;
            if (showsLibrary && Time.unscaledTime - _entriesReadAt > 2f)
            {
                RefreshEntries();
            }

            if (Flow.Screen != AppScreen.JoinTrail || _joining)
            {
                return;
            }

            // A link that opened the app (or arrived while it was open) joins straight away — the
            // player already chose this trail by tapping it. Once per code, so a failure can be read.
            string pending = Flow.PendingJoinCode;
            if (pending != null && pending != _autoJoinedCode)
            {
                _autoJoinedCode = pending;
                _codeInput = JoinCode.Format(pending);
                QuestBootstrap.Fire(JoinAsync());
            }
        }

        private void OnGUI()
        {
            if (_game == null || Flow.Screen == AppScreen.Playing)
            {
                return;
            }

            UiKit ui = UiKit.Styles;
            (Rect screen, Rect safe) = UiKit.BeginScaled();
            GUI.Box(screen, GUIContent.none, ui.Page);

            GUILayout.BeginArea(new Rect(safe.x + 20, safe.y + 20, safe.width - 40, safe.height - 40));
            _scroll = GUILayout.BeginScrollView(_scroll, GUIStyle.none, GUIStyle.none);

            switch (Flow.Screen)
            {
                case AppScreen.Welcome:
                    DrawWelcome(ui);
                    break;
                case AppScreen.LocationPermission:
                    DrawLocationPermission(ui);
                    break;
                case AppScreen.MyTrails:
                    DrawMyTrails(ui);
                    break;
                case AppScreen.JoinTrail:
                    DrawJoin(ui);
                    break;
                case AppScreen.TrailDetails:
                    DrawTrailDetails(ui);
                    break;
                case AppScreen.Settings:
                    DrawSettings(ui);
                    break;
            }

            GUILayout.EndScrollView();
            GUILayout.EndArea();
        }

        private void DrawWelcome(UiKit ui)
        {
            GUILayout.Space(32);
            GUILayout.Label("AR Quest Trail", ui.Title);
            GUILayout.Label("Follow a trail of pins hidden around real places. Find one and the next unlocks.", ui.Body);
            GUILayout.Space(12);
            Bullet(ui, "Get a trail code from whoever made the trail — on a poster, a QR code or a link.");
            Bullet(ui, "Walk to each pin in order. Some ask you to stay a moment; some ask for a code you'll find there.");
            Bullet(ui, "Your progress is saved as you go, even where there's no signal.");
            GUILayout.Space(24);
            if (UiKit.Action("Get started", ui.Primary))
            {
                _game.ContinueFromWelcome();
            }
        }

        private void DrawLocationPermission(UiKit ui)
        {
            GUILayout.Space(32);
            GUILayout.Label("Your location", ui.Title);
            GUILayout.Label("The trail uses your location to show how far away the next pin is, and to confirm you've reached it.", ui.Body);
            GUILayout.Label(
                "Your position goes to the trail server only while you're playing a trail, to check each pin, and location " +
                "history is deleted after 90 days. There's no account — no name or email is ever asked for.",
                ui.Small);
            GUILayout.Space(24);
            if (UiKit.Action("Allow location", ui.Primary))
            {
                _game.RequestLocation();
            }

            if (UiKit.Action("Not now", ui.Secondary))
            {
                Flow.LocationPermissionAnswered();
            }
        }

        private void DrawMyTrails(UiKit ui)
        {
            GUILayout.BeginHorizontal();
            GUILayout.Label("My trails", ui.Title);
            GUILayout.FlexibleSpace();
            if (GUILayout.Button("Settings", ui.Link))
            {
                Flow.OpenSettings();
            }

            GUILayout.EndHorizontal();

            if (Session.IsOffline)
            {
                GUILayout.Label("You're offline — trails you've opened before still work.", ui.Alert);
            }

            IReadOnlyList<LibraryEntry> entries = _entries;
            if (entries.Count == 0)
            {
                GUILayout.Space(8);
                GUILayout.Label("No trails yet.", ui.Heading);
                GUILayout.Label("When someone shares a trail with you — a code, a QR code or a link — join it here.", ui.Body);
            }
            else
            {
                foreach (LibraryEntry entry in entries)
                {
                    string card = $"<b>{UiKit.Plain(entry.Name)}</b>\n<size=14><color=#94a3b8>{StatusLine(entry)}</color></size>";
                    if (GUILayout.Button(card, ui.Card))
                    {
                        Flow.OpenTrail(entry.TrailId);
                    }
                }
            }

            GUILayout.Space(12);
            if (UiKit.Action("Join a trail", ui.Primary))
            {
                Flow.OpenJoin();
            }
        }

        private void DrawJoin(UiKit ui)
        {
            if (GUILayout.Button("← Back", ui.Link))
            {
                Flow.Back();
            }

            GUILayout.Label("Join a trail", ui.Title);
            GUILayout.Label("Enter the code you were given — 8 letters and numbers, like ABCD-EFGH.", ui.Body);
            GUILayout.Label("Scanning a trail's QR code with your camera opens it here directly.", ui.Small);

            GUI.enabled = !_joining;
            _codeInput = GUILayout.TextField(_codeInput ?? string.Empty, 200, ui.Field);
            GUI.enabled = true;

            if (_joinError != null)
            {
                GUILayout.Label(_joinError, ui.Error);
            }

            if (UiKit.Action(_joining ? "Joining…" : "Join", ui.Primary, !_joining && !string.IsNullOrWhiteSpace(_codeInput)))
            {
                QuestBootstrap.Fire(JoinAsync());
            }
        }

        private void DrawTrailDetails(UiKit ui)
        {
            if (GUILayout.Button("← My trails", ui.Link))
            {
                Flow.Back();
                return;
            }

            LibraryEntry entry = _entries.FirstOrDefault(candidate => candidate.TrailId == Flow.SelectedTrailId);
            if (entry == null)
            {
                GUILayout.Label("This trail isn't on your list any more.", ui.Body);
                return;
            }

            GUILayout.Label(UiKit.Plain(entry.Name), ui.Title);
            GUILayout.Label($"{entry.PinCount} pins, found in order.", ui.Body);
            GUILayout.Label(
                entry.ExpiryDays.HasValue
                    ? $"Finish within {entry.ExpiryDays} day{(entry.ExpiryDays == 1 ? "" : "s")} of starting."
                    : "No time limit.",
                ui.Body);
            if (entry.JoinCode != null)
            {
                GUILayout.Label("Trail code " + entry.JoinCode, ui.Small);
            }

            GUILayout.Label(StatusLine(entry), entry.Status == LibraryStatus.Expired ? ui.Alert : ui.Small);
            GUILayout.Space(16);

            if (UiKit.Action(PlayLabel(entry), ui.Primary))
            {
                _game.PlayTrail(entry.TrailId, startOver: entry.Status == LibraryStatus.Expired);
            }

            GUILayout.Space(24);
            if (!_confirmingRemove)
            {
                if (UiKit.Action("Remove from my trails", ui.Secondary))
                {
                    _confirmingRemove = true;
                }

                return;
            }

            GUILayout.Label(
                "Remove it from your list? Your progress stays on the trail server — joining with the code again brings it back.",
                ui.Body);
            if (UiKit.Action("Remove", ui.Destructive))
            {
                Session.Library.Remove(entry.TrailId);
                Flow.TrailRemoved();
            }

            if (UiKit.Action("Keep it", ui.Secondary))
            {
                _confirmingRemove = false;
            }
        }

        private void DrawSettings(UiKit ui)
        {
            if (GUILayout.Button("← My trails", ui.Link))
            {
                Flow.Back();
                return;
            }

            GUILayout.Label("Settings", ui.Title);
            GUILayout.Space(8);
            GUILayout.Label("Your data", ui.Heading);
            GUILayout.Label("There's no account: this phone is your player. Your progress is kept on it and on the trail server.", ui.Body);
            GUILayout.Label(
                "While you play, your position is sent to the trail server to confirm each pin. Location history is deleted after 90 days.",
                ui.Body);
            GUILayout.Space(8);

            if (!_confirmingDelete)
            {
                if (UiKit.Action("Delete my data", ui.Destructive))
                {
                    _confirmingDelete = true;
                }
            }
            else
            {
                GUILayout.Label(
                    "This permanently deletes your progress and location history, on this phone and on the server. " +
                    "The phone then starts over as a new player.",
                    ui.Alert);
                if (UiKit.Action(_deleting ? "Deleting…" : "Delete everything", ui.Destructive, !_deleting))
                {
                    QuestBootstrap.Fire(DeleteAsync());
                }

                if (UiKit.Action("Keep my data", ui.Secondary, !_deleting))
                {
                    _confirmingDelete = false;
                }
            }

            if (_settingsError != null)
            {
                GUILayout.Label(_settingsError, ui.Error);
            }

            GUILayout.Space(24);
            GUILayout.Label("About", ui.Heading);
            GUILayout.Label("Version " + Application.version, ui.Small);
        }

        private async Task JoinAsync()
        {
            _joining = true;
            _joinError = null;
            try
            {
                ApiResult<LibraryEntry> result = await Session.JoinAsync(_codeInput);
                if (result.Ok)
                {
                    _codeInput = string.Empty;
                    Flow.Joined(result.Value.TrailId);
                }
                else
                {
                    _joinError = DescribeJoinError(result.Error);
                    Flow.ConsumePendingJoinCode();
                }
            }
            finally
            {
                _joining = false;
            }
        }

        private async Task DeleteAsync()
        {
            _deleting = true;
            _settingsError = null;
            try
            {
                // Success raises Session.PlayerDataDeleted, which QuestBootstrap turns into a first run.
                ApiResult<DeleteMyDataResponse> result = await Session.DeleteMyDataAsync();
                if (!result.Ok)
                {
                    _settingsError = "Couldn't delete your data: " + TrailManager.Describe(result.Error);
                }
            }
            finally
            {
                _deleting = false;
            }
        }

        private void RefreshEntries()
        {
            _entries = Session.Library.Entries;
            _entriesReadAt = Time.unscaledTime;
        }

        private void OnScreenChanged(AppScreen screen)
        {
            RefreshEntries();
            _scroll = Vector2.zero;
            _confirmingRemove = false;
            _confirmingDelete = false;
            _settingsError = null;
            if (screen == AppScreen.JoinTrail)
            {
                _joinError = null;
                _codeInput = Flow.PendingJoinCode != null ? JoinCode.Format(Flow.PendingJoinCode) : string.Empty;
            }
        }

        private static string DescribeJoinError(ApiError error)
        {
            switch (error.Code)
            {
                case "invalid_join_code":
                    return "That isn't a trail code. Codes are 8 letters and numbers, like ABCD-EFGH.";
                case "join_code_not_found":
                    return "No trail uses that code. Codes can be changed — check with whoever shared it.";
            }

            switch (error.Kind)
            {
                case ApiErrorKind.Network:
                    return "You're offline. Joining a trail needs a connection.";
                case ApiErrorKind.RateLimited:
                    return "Too many tries — wait a minute, then try again.";
                default:
                    return TrailManager.Describe(error);
            }
        }

        private static string StatusLine(LibraryEntry entry)
        {
            switch (entry.Status)
            {
                case LibraryStatus.Active:
                    return $"In progress · {entry.PinsCompleted} of {entry.PinCount} pins";
                case LibraryStatus.Completed:
                    return "Completed ✓";
                case LibraryStatus.Expired:
                    return "Time ran out — you can start again";
                default:
                    return $"Not started · {entry.PinCount} pins";
            }
        }

        private static string PlayLabel(LibraryEntry entry)
        {
            switch (entry.Status)
            {
                case LibraryStatus.Active:
                    return "Continue";
                case LibraryStatus.Completed:
                    return "See your result";
                case LibraryStatus.Expired:
                    return "Start again";
                default:
                    return "Start trail";
            }
        }

        private static void Bullet(UiKit ui, string text)
        {
            GUILayout.BeginHorizontal();
            GUILayout.Label("•", ui.Body, GUILayout.Width(18));
            GUILayout.Label(text, ui.Body);
            GUILayout.EndHorizontal();
        }
    }
}
