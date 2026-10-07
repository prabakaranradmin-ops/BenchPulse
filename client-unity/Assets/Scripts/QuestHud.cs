using System;
using ArQuestTrail.Core;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// ST-4.2's minimal UI, plus the player-facing parts of the spec: the reduced-precision and
    /// offline indicators (SR-NET-03, CR-04, ST-9.2), pin inspection (CR-05), the GDR-04 summary,
    /// replay (GDR-06), "can't find this pin" (GDR-09), and delete-my-data (SR-PRIV-02).
    ///
    /// Immediate-mode on purpose: it needs no prefabs or scene wiring, so the field test runs on a
    /// bare scene. It is a field-test HUD, not the shipping UI — the spec leaves visual design open.
    /// </summary>
    public class QuestHud : MonoBehaviour
    {
        /// <summary>The HUD lays out in a column this wide and scales to the screen.</summary>
        private const float VirtualWidth = 420f;

        private QuestBootstrap _game;
        private string _code = string.Empty;
        private string _reportNote = string.Empty;
        private bool _reporting;
        private bool _confirmingDelete;
        private bool _walking;
        private Vector2 _scroll;
        private GUIStyle _text;
        private GUIStyle _heading;
        private GUIStyle _alert;
        private GUIStyle _panel;

        public void Initialize(QuestBootstrap game)
        {
            _game = game;
        }

        private void OnGUI()
        {
            if (_game == null || _game.Session == null)
            {
                return;
            }

            BuildStyles();
            float scale = Mathf.Max(1f, Screen.width / VirtualWidth);
            GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1f));
            float height = Screen.height / scale;

            GUILayout.BeginArea(new Rect(8, 8, VirtualWidth - 16, height - 16));
            _scroll = GUILayout.BeginScrollView(_scroll);
            GUILayout.BeginVertical(_panel);

            DrawStatus();
            DrawTrail();
            DrawMessage();
            DrawActions();
            DrawSimulator();

            GUILayout.EndVertical();
            GUILayout.EndScrollView();
            GUILayout.EndArea();
        }

        private void DrawStatus()
        {
            PositionEstimate estimate = _game.Localization.Current;
            GUILayout.Label(PositionLine(estimate), estimate.IsReducedPrecision ? _alert : _text);

            QuestSession session = _game.Session;
            int pending = session.PendingCompletions.Count;
            string network = _game.Network.Enabled
                ? "Airplane mode (simulated)"
                : session.IsOffline ? "Offline" : "Online";
            GUILayout.Label(
                pending > 0 ? $"{network} · {pending} completion{(pending == 1 ? "" : "s")} waiting to sync" : network,
                session.IsOffline || pending > 0 ? _alert : _text);

            GUILayout.Label(_game.Trail.Status, _text);
        }

        private string PositionLine(PositionEstimate estimate)
        {
            LocationFix? fix = estimate.Fix;
            switch (estimate.Status)
            {
                case LocalizationStatus.Vps:
                    return $"Position: VPS (±{fix.Value.AccuracyM:0.0} m)";
                case LocalizationStatus.Localizing:
                    return fix.HasValue
                        ? $"Position: localizing VPS… using GPS meanwhile (±{fix.Value.AccuracyM:0} m)"
                        : "Position: localizing VPS…";
                case LocalizationStatus.GpsFallback:
                    return fix.Value.Source == PositionSource.Simulated
                        ? "Position: simulated walker (Editor)"
                        // SR-NET-03: say plainly that precision dropped — never pretend.
                        : $"Position: GPS only — reduced precision (±{fix.Value.AccuracyM:0} m)";
                default:
                    return "Position: waiting for a location fix — " + _game.Localization.GpsStatus;
            }
        }

        private void DrawTrail()
        {
            TrailProgress progress = _game.Session.Progress;
            if (progress == null)
            {
                return;
            }

            GUILayout.Space(8);
            GUILayout.Label(progress.Trail.Name ?? "Trail", _heading);
            if (!progress.Trail.IsCurrentVersion)
            {
                // GDR-07: honest about why this player's pins differ from a fresh start's.
                GUILayout.Label("You're finishing the version you started; the trail has since been updated.", _text);
            }

            if (_game.Trail.CompletedAttempt != null)
            {
                DrawSummary(progress, _game.Trail.CompletedAttempt);
                return;
            }

            if (progress.IsExpired)
            {
                GUILayout.Label("This attempt has expired.", _alert);
                if (GUILayout.Button("Start again"))
                {
                    QuestBootstrap.Fire(_game.Trail.ReplayAsync());
                }

                return;
            }

            if (progress.IsCompletedLocally)
            {
                GUILayout.Label("Every pin done — your finish will be confirmed when you're back online.", _alert);
                return;
            }

            PinView active = progress.ActivePin;
            if (active == null)
            {
                foreach (PinView view in progress.Pins)
                {
                    if (view.State == PinState.AwaitingVerification)
                    {
                        GUILayout.Label(
                            $"Pin {view.Pin.SequenceIndex}: your code will be checked once you're online — the next pin unlocks then.",
                            _alert);
                    }
                }

                return;
            }

            DrawActivePin(progress, active.Pin);
            DrawNextPin(progress, active.Pin);
        }

        private void DrawActivePin(TrailProgress progress, PinDto pin)
        {
            GUILayout.Label($"Pin {pin.SequenceIndex} of {progress.Pins.Count} — {Describe(pin.ChallengeType)}", _heading);
            if (!string.IsNullOrEmpty(pin.Challenge?.Hint))
            {
                GUILayout.Label("Hint: " + pin.Challenge.Hint, _text); // CR-05
            }

            LocationFix? fix = _game.Localization.Current.Fix;
            if (fix.HasValue)
            {
                GUILayout.Label(DistanceAndDirection(fix.Value, pin), _text);
            }

            switch (pin.ChallengeType)
            {
                case ChallengeTypes.ProximityDwell:
                    DrawDwell();
                    break;
                case ChallengeTypes.CodeEntry:
                    DrawCodeEntry(pin);
                    break;
                default:
                    // ST-6.1 isn't built; the server refuses these pins rather than auto-passing them.
                    GUILayout.Label("Photo challenges aren't available yet — report this pin so the author can change it.", _alert);
                    break;
            }
        }

        private void DrawDwell()
        {
            DwellTracker tracker = _game.Dwell.Tracker;
            if (tracker == null)
            {
                return;
            }

            switch (tracker.State)
            {
                case DwellState.WeakSignal:
                    // SR-GEO-04's wording, verbatim.
                    GUILayout.Label("GPS signal weak — move to open sky", _alert);
                    break;
                case DwellState.OutsideRadius:
                    PositionEvaluation evaluation = tracker.LastEvaluation.Value;
                    GUILayout.Label(
                        $"Move closer — {evaluation.DistanceM - evaluation.EffectiveRadiusM:0} m to go (completes within {evaluation.EffectiveRadiusM:0} m).",
                        _text);
                    break;
                case DwellState.Dwelling:
                    GUILayout.Label(
                        $"Stay here… {tracker.ElapsedSeconds:0} of {tracker.RequiredSeconds:0} s  {ProgressBar(tracker.Progress)}",
                        _text);
                    break;
                case DwellState.Satisfied:
                    GUILayout.Label(_game.Dwell.IsSubmitting ? "Done — sending…" : "Done.", _text);
                    break;
                default:
                    GUILayout.Label("Waiting for your position…", _text);
                    break;
            }
        }

        private void DrawCodeEntry(PinDto pin)
        {
            int? length = pin.Challenge?.CodeLength;
            GUILayout.Label(length.HasValue ? $"Enter the code you find here ({length} characters):" : "Enter the code you find here:", _text);
            _code = GUILayout.TextField(_code ?? string.Empty, 40);
            GUI.enabled = !_game.Trail.IsBusy && !string.IsNullOrWhiteSpace(_code);
            if (GUILayout.Button("Check code"))
            {
                string answer = _code;
                QuestBootstrap.Fire(_game.SubmitCodeAsync(answer));
            }

            GUI.enabled = true;
        }

        private void DrawNextPin(TrailProgress progress, PinDto active)
        {
            int index = -1;
            for (int i = 0; i < progress.Pins.Count; i++)
            {
                if (progress.Pins[i].Pin.PinId == active.PinId)
                {
                    index = i;
                }
            }

            if (index >= 0 && index + 1 < progress.Pins.Count)
            {
                // GDR-01: a locked pin is a distance cue, never a target.
                GUILayout.Label($"Next: pin {index + 2} unlocks when this one is done.", _text);
            }
        }

        private void DrawSummary(TrailProgress progress, AttemptDto attempt)
        {
            // GDR-04: a summary/badge screen; points and narrative rewards are out of scope for v1.
            GUILayout.Label("★ Trail complete! ★", _heading);
            GUILayout.Label($"{progress.Pins.Count} pins found.", _text);
            if (!string.IsNullOrEmpty(attempt.StartedAt) && !string.IsNullOrEmpty(attempt.CompletedAt))
            {
                TimeSpan taken = IsoTime.FromWire(attempt.CompletedAt) - IsoTime.FromWire(attempt.StartedAt);
                GUILayout.Label($"Time: {(int)taken.TotalHours}h {taken.Minutes}m {taken.Seconds}s", _text);
            }

            if (GUILayout.Button("Play again"))
            {
                QuestBootstrap.Fire(_game.Trail.ReplayAsync()); // GDR-06: a new attempt; this one stays
            }
        }

        private void DrawMessage()
        {
            if (!string.IsNullOrEmpty(_game.Trail.LastMessage))
            {
                GUILayout.Space(6);
                GUILayout.Label(_game.Trail.LastMessage, _alert);
            }
        }

        private void DrawActions()
        {
            GUILayout.Space(10);
            PinDto active = _game.Session.Progress?.ActivePin?.Pin;

            if (active != null)
            {
                if (!_reporting && GUILayout.Button("Can't find this pin"))
                {
                    _reporting = true;
                }

                if (_reporting)
                {
                    GUILayout.Label("What's wrong? (optional)", _text);
                    _reportNote = GUILayout.TextField(_reportNote ?? string.Empty, 1000);
                    GUILayout.BeginHorizontal();
                    if (GUILayout.Button("Send report"))
                    {
                        QuestBootstrap.Fire(_game.Trail.ReportPinAsync(active, _reportNote));
                        _reporting = false;
                        _reportNote = string.Empty;
                    }

                    if (GUILayout.Button("Cancel"))
                    {
                        _reporting = false;
                    }

                    GUILayout.EndHorizontal();
                }
            }

            _game.Network.Enabled = GUILayout.Toggle(_game.Network.Enabled, " Simulate airplane mode (SR-NET test)");

            if (!_confirmingDelete && GUILayout.Button("Delete my data"))
            {
                _confirmingDelete = true;
            }

            if (_confirmingDelete)
            {
                GUILayout.Label("This deletes your progress and location history for good, and this device starts over as a new player.", _alert);
                GUILayout.BeginHorizontal();
                if (GUILayout.Button("Delete everything"))
                {
                    QuestBootstrap.Fire(_game.Trail.DeleteMyDataAsync());
                    _confirmingDelete = false;
                }

                if (GUILayout.Button("Keep my data"))
                {
                    _confirmingDelete = false;
                }

                GUILayout.EndHorizontal();
            }
        }

        private void DrawSimulator()
        {
            if (_game.Simulator == null)
            {
                return;
            }

            GUILayout.Space(10);
            GUILayout.Label("Editor walker", _heading);
            bool walking = GUILayout.Toggle(_walking, " Walk to the active pin (1.4 m/s)");
            if (walking != _walking || (walking && _game.Simulator.Target == null))
            {
                _walking = walking;
                _game.WalkToActivePin(walking);
            }

            GUILayout.BeginHorizontal();
            if (GUILayout.Button("N +10m")) _game.Simulator.Nudge(0, 10);
            if (GUILayout.Button("S +10m")) _game.Simulator.Nudge(0, -10);
            if (GUILayout.Button("E +10m")) _game.Simulator.Nudge(10, 0);
            if (GUILayout.Button("W +10m")) _game.Simulator.Nudge(-10, 0);
            GUILayout.EndHorizontal();
        }

        private static string DistanceAndDirection(LocationFix fix, PinDto pin)
        {
            double distance = GeoMath.HaversineMeters(fix.Lat, fix.Lng, pin.Lat, pin.Lng);
            string direction = GeoMath.ToCompassPoint(GeoMath.BearingDegrees(fix.Lat, fix.Lng, pin.Lat, pin.Lng));
            return distance >= 1000 ? $"{distance / 1000:0.0} km {direction}" : $"{distance:0} m {direction}";
        }

        private static string Describe(string challengeType)
        {
            switch (challengeType)
            {
                case ChallengeTypes.ProximityDwell: return "stand at the pin";
                case ChallengeTypes.CodeEntry: return "find the code";
                case ChallengeTypes.PhotoConfirmation: return "take a photo";
                default: return challengeType;
            }
        }

        private static string ProgressBar(double fraction)
        {
            int filled = (int)Math.Round(Math.Max(0, Math.Min(1, fraction)) * 10);
            return "[" + new string('#', filled) + new string('-', 10 - filled) + "]";
        }

        private void BuildStyles()
        {
            if (_text != null)
            {
                return;
            }

            _text = new GUIStyle(GUI.skin.label) { wordWrap = true, fontSize = 14 };
            _heading = new GUIStyle(_text) { fontStyle = FontStyle.Bold, fontSize = 16 };
            _alert = new GUIStyle(_text);
            _alert.normal.textColor = new Color(1f, 0.82f, 0.3f);
            _panel = new GUIStyle(GUI.skin.box) { padding = new RectOffset(10, 10, 10, 10) };
        }
    }
}
