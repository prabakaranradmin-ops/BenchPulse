using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using ArQuestTrail.Core;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace ArQuestTrail.Tests
{
    /// <summary>
    /// The sample, played by a script: the real app in the Unity runtime against a real server —
    /// first-run screens, join by code, the Editor walker walking to every pin, a code typed
    /// sloppily, the finish, and back to My trails. Anything logged as an error fails it.
    ///
    /// Needs a server and a seeded trail, so it is skipped unless told where they are:
    ///   QUEST_API_URL     e.g. http://127.0.0.1:3000
    ///   QUEST_JOIN_CODE   printed by `npm run seed:field-test` (seed near the walker's start,
    ///                     13.0827, 80.2707 by default)
    ///   QUEST_CODE_ANSWER the seed's --code, if any (default "swan 42" — SWAN42, typed sloppily)
    /// Outside batch mode it saves a screenshot of each screen to Logs/sample-run/.
    /// </summary>
    public class SampleTrailRun
    {
        private const string StorageFolder = "arquest-sample-run";

        private GameObject _game;
        private GameObject _camera;

        [TearDown]
        public void TearDown()
        {
            if (_game != null)
            {
                UnityEngine.Object.Destroy(_game);
            }

            if (_camera != null)
            {
                UnityEngine.Object.Destroy(_camera);
            }
        }

        [UnityTest]
        [Timeout(420000)]
        public IEnumerator Joins_by_code_and_walks_the_whole_trail()
        {
            string api = Environment.GetEnvironmentVariable("QUEST_API_URL");
            string code = Environment.GetEnvironmentVariable("QUEST_JOIN_CODE");
            if (string.IsNullOrEmpty(api) || string.IsNullOrEmpty(code))
            {
                Assert.Ignore("Set QUEST_API_URL and QUEST_JOIN_CODE (from `npm run seed:field-test`) to run the sample.");
            }

            string answer = Environment.GetEnvironmentVariable("QUEST_CODE_ANSWER") ?? "swan 42";

            // Its own player, so the run neither depends on nor disturbs the Editor's usual one.
            string data = Path.Combine(Application.persistentDataPath, StorageFolder);
            if (Directory.Exists(data))
            {
                Directory.Delete(data, true);
            }

            // The test runs in an empty scene; the sample scene's camera is what clears the screen
            // between frames, so without one the play screen's text smears across frames.
            _camera = new GameObject("Camera");
            Camera camera = _camera.AddComponent<Camera>();
            camera.clearFlags = CameraClearFlags.SolidColor;
            camera.backgroundColor = UiKit.Background;
            UsePhoneResolution();

            _game = new GameObject("QuestBootstrap");
            _game.SetActive(false);
            QuestBootstrap game = _game.AddComponent<QuestBootstrap>();
            SetField(game, "apiBaseUrl", api);
            SetField(game, "storageFolder", StorageFolder);
            _game.SetActive(true);
            yield return null;

            // First run: welcome, then (the Editor always has location) straight to My trails.
            Assert.AreEqual(AppScreen.Welcome, game.Flow.Screen);
            yield return Screenshot("01-welcome");
            game.ContinueFromWelcome();
            Assert.AreEqual(AppScreen.MyTrails, game.Flow.Screen);
            yield return Screenshot("02-my-trails-empty");

            game.Flow.OpenJoin();
            yield return Screenshot("03-join");
            Task<ApiResult<LibraryEntry>> join = game.Session.JoinAsync(code);
            yield return WaitFor(() => join.IsCompleted, 30, "the join request");
            Assert.IsTrue(join.Result.Ok, "Joining failed: " + join.Result.Error);
            LibraryEntry entry = join.Result.Value;
            game.Flow.Joined(entry.TrailId);
            Assert.AreEqual(AppScreen.TrailDetails, game.Flow.Screen);
            yield return Screenshot("04-trail-details");

            game.PlayTrail(entry.TrailId);
            yield return WaitFor(() => game.Session.Progress != null && !game.Trail.IsBusy, 30, "the trail to load");
            Assert.AreEqual(AppScreen.Playing, game.Flow.Screen);
            Assert.AreEqual(entry.PinCount, game.Session.Progress.Pins.Count);
            yield return Screenshot("05-playing");

            // Walk each pin in turn at walking pace. Dwell pins complete themselves; code pins get
            // the answer once the walker is standing at them.
            var answered = new HashSet<string>();
            bool dwellCaptured = false;
            float deadline = Time.realtimeSinceStartup + 360f;
            while (game.Trail.CompletedAttempt == null)
            {
                if (Time.realtimeSinceStartup > deadline)
                {
                    Assert.Fail($"The trail didn't finish. Status: {game.Trail.Status}; last message: {game.Trail.LastMessage}");
                }

                PinDto pin = game.Session.Progress.ActivePin?.Pin;
                if (pin != null)
                {
                    game.WalkToActivePin(true);

                    if (!dwellCaptured && game.Dwell.Tracker?.State == DwellState.Dwelling)
                    {
                        dwellCaptured = true;
                        yield return Screenshot("06-dwelling");
                    }

                    LocationFix? fix = game.Localization.Current.Fix;
                    bool standingAtPin = fix.HasValue
                        && GeoMath.HaversineMeters(fix.Value.Lat, fix.Value.Lng, pin.Lat, pin.Lng) < pin.RadiusM / 2;
                    if (pin.ChallengeType == ChallengeTypes.CodeEntry && standingAtPin && answered.Add(pin.PinId))
                    {
                        yield return Screenshot("07-code-pin");
                        Task submit = game.SubmitCodeAsync(answer);
                        yield return WaitFor(() => submit.IsCompleted, 30, "the code check");
                    }
                }

                yield return null;
            }

            yield return Screenshot("08-trail-complete");
            Assert.AreEqual(LibraryStatus.Completed, game.Session.Library.Find(entry.TrailId).Status);
            Assert.IsEmpty(game.Session.PendingCompletions);

            game.LeaveTrail();
            Assert.AreEqual(AppScreen.TrailDetails, game.Flow.Screen);
            yield return Screenshot("09-details-completed");
            game.Flow.Back();
            Assert.AreEqual(AppScreen.MyTrails, game.Flow.Screen);
            yield return Screenshot("10-my-trails");
        }

        private static IEnumerator WaitFor(Func<bool> condition, float seconds, string what)
        {
            float deadline = Time.realtimeSinceStartup + seconds;
            while (!condition())
            {
                if (Time.realtimeSinceStartup > deadline)
                {
                    Assert.Fail($"Timed out after {seconds}s waiting for {what}.");
                }

                yield return null;
            }
        }

        /// <summary>The screen as the player sees it. Batch mode has no Game view to capture.</summary>
        private static IEnumerator Screenshot(string name)
        {
            if (Application.isBatchMode)
            {
                yield break;
            }

            // Two frames: one for the GUI to lay out the new state, one to draw it.
            yield return null;
            yield return null;
            yield return new WaitForEndOfFrame();
            string folder = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "Logs", "sample-run"));
            Directory.CreateDirectory(folder);
            Texture2D shot = ScreenCapture.CaptureScreenshotAsTexture();
            File.WriteAllBytes(Path.Combine(folder, name + ".png"), shot.EncodeToPNG());
            UnityEngine.Object.Destroy(shot);
        }

        /// <summary>
        /// Renders the Game view at a portrait phone size, so the screenshots show the screens as a
        /// player sees them — a Unity launched from the command line can open with a tiny Game view.
        /// (Maximizing the Game view from a script instead crashes Unity 6.0 during play mode.)
        /// </summary>
        private static void UsePhoneResolution()
        {
#if UNITY_EDITOR
            if (!Application.isBatchMode)
            {
                UnityEditor.PlayModeWindow.SetCustomRenderingResolution(540, 1080, "Phone portrait (sample run)");
            }
#endif
        }

        private static void SetField(QuestBootstrap target, string field, string value)
        {
            FieldInfo info = typeof(QuestBootstrap).GetField(field, BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new MissingFieldException(nameof(QuestBootstrap), field);
            info.SetValue(target, value);
        }
    }
}
