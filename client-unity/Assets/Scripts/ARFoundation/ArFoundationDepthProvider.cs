using UnityEngine;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;

namespace ArQuestTrail
{
    /// <summary>
    /// SR-VIS-01 / SR-VIS-02's first step: ask AR Foundation for environment depth — which many
    /// non-LiDAR Android devices provide through stereo estimation — and report whether it is
    /// actually running. While it is, AR Foundation occludes pins behind real structures and
    /// OcclusionFallbackController stands down; when it isn't, the distance cue takes over.
    ///
    /// Add it next to the AROcclusionManager on the AR camera.
    /// </summary>
    public sealed class ArFoundationDepthProvider : MonoBehaviour, IDepthCapabilityProvider
    {
        [SerializeField] private AROcclusionManager occlusionManager;

        public bool HasEnvironmentDepth =>
            occlusionManager != null
            && occlusionManager.enabled
            && occlusionManager.currentEnvironmentDepthMode != EnvironmentDepthMode.Disabled;

        private void OnEnable()
        {
            if (occlusionManager == null)
            {
                occlusionManager = GetComponent<AROcclusionManager>();
            }

            if (occlusionManager == null)
            {
                occlusionManager = FindFirstObjectByType<AROcclusionManager>();
            }

            if (occlusionManager != null)
            {
                occlusionManager.requestedEnvironmentDepthMode = EnvironmentDepthMode.Best;
            }

            ArIntegrations.Depth = this;
        }

        private void OnDisable()
        {
            if (ReferenceEquals(ArIntegrations.Depth, this))
            {
                ArIntegrations.Depth = null;
            }
        }
    }
}
