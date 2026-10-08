using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace ArQuestTrail.EditorTools
{
    /// <summary>
    /// Builds <c>Assets/Scenes/SampleTrail.unity</c>: the default camera and light plus a
    /// <see cref="QuestBootstrap"/> pointed at a local server. In the Editor that is the whole app —
    /// every screen, a simulated walker instead of GPS, no AR — so pressing Play plays a real trail.
    /// </summary>
    public static class SampleScene
    {
        public const string ScenePath = "Assets/Scenes/SampleTrail.unity";
        public const string DefaultApiBaseUrl = "http://127.0.0.1:3000";

        [MenuItem("AR Quest Trail/Create Sample Scene")]
        public static void CreateFromMenu()
        {
            Create(DefaultApiBaseUrl);
            EditorSceneManager.OpenScene(ScenePath);
            Debug.Log($"Created {ScenePath}. Start the server on {DefaultApiBaseUrl}, press Play, and join with a code from `npm run seed:field-test`.");
        }

        /// <summary>
        /// For the command line:
        /// <c>Unity -batchmode -quit -projectPath client-unity -executeMethod ArQuestTrail.EditorTools.SampleScene.CreateInBatch [-apiBaseUrl URL]</c>
        /// </summary>
        public static void CreateInBatch() => Create(Argument("-apiBaseUrl") ?? DefaultApiBaseUrl);

        /// <summary>
        /// Opens the Editor straight into the running app:
        /// <c>Unity -projectPath client-unity -executeMethod ArQuestTrail.EditorTools.SampleScene.OpenAndPlay</c>
        /// </summary>
        public static void OpenAndPlay()
        {
            EditorSceneManager.OpenScene(ScenePath);
            EditorApplication.EnterPlaymode();
        }

        public static void Create(string apiBaseUrl)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);

            var game = new GameObject("QuestBootstrap");
            var bootstrap = game.AddComponent<QuestBootstrap>();
            var settings = new SerializedObject(bootstrap);
            settings.FindProperty("apiBaseUrl").stringValue = apiBaseUrl;
            settings.ApplyModifiedPropertiesWithoutUndo();

            if (!EditorSceneManager.SaveScene(scene, ScenePath))
            {
                throw new InvalidOperationException("Couldn't save " + ScenePath);
            }

            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            AssetDatabase.SaveAssets();
        }

        private static string Argument(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            int index = Array.IndexOf(args, name);
            return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
        }
    }
}
