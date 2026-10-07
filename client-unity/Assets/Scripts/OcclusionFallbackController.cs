using ArQuestTrail.Core;
using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// SR-VIS-01 / SR-VIS-02. Where the device has real environment depth, AR Foundation's
    /// occlusion hides pins behind buildings and this does nothing. Everywhere else it applies the
    /// distance cue instead — so gameplay stays fair across device tiers rather than gating on
    /// hardware (proximity_dwell never needs line of sight).
    /// </summary>
    public class OcclusionFallbackController : MonoBehaviour
    {
        private static readonly int BaseColorId = Shader.PropertyToID("_BaseColor"); // URP
        private static readonly int ColorId = Shader.PropertyToID("_Color");         // Built-in

        [Tooltip("SR-VIS-02 [ASSUMED: ~15m]. Styling is a visual-design call; this is a placeholder default.")]
        [SerializeField] private float fadeStartMeters = 15f;

        [SerializeField] private float fadeEndMeters = 60f;

        private Transform _target;
        private Renderer _renderer;
        private Vector3 _baseScale = Vector3.one;
        private MaterialPropertyBlock _block;
        private DistanceFade _fade;

        public void SetTarget(Transform target, Renderer renderer)
        {
            _target = target;
            _renderer = renderer;
            _baseScale = target != null ? target.localScale : Vector3.one;
            _block = new MaterialPropertyBlock();
            _fade = new DistanceFade(fadeStartMeters, fadeEndMeters);
        }

        private void LateUpdate()
        {
            if (_target == null || !_target.gameObject.activeInHierarchy)
            {
                return;
            }

            bool hardwareDepth = ArIntegrations.Depth != null && ArIntegrations.Depth.HasEnvironmentDepth;
            Camera viewer = Camera.main;
            if (hardwareDepth || viewer == null)
            {
                Apply(1, 1);
                return;
            }

            float distance = Vector3.Distance(viewer.transform.position, _target.position);
            Apply((float)_fade.Alpha(distance), (float)_fade.Scale(distance));
        }

        /// <summary>
        /// Scale always shows. Alpha only shows on a transparent material — the default marker is
        /// opaque, so give the pin prefab a transparent material for the full SR-VIS-02 cue.
        /// </summary>
        private void Apply(float alpha, float scale)
        {
            _target.localScale = _baseScale * scale;
            if (_renderer == null)
            {
                return;
            }

            _renderer.GetPropertyBlock(_block);
            Color color = _renderer.sharedMaterial != null && _renderer.sharedMaterial.HasProperty(BaseColorId)
                ? _renderer.sharedMaterial.GetColor(BaseColorId)
                : _renderer.sharedMaterial != null && _renderer.sharedMaterial.HasProperty(ColorId)
                    ? _renderer.sharedMaterial.GetColor(ColorId)
                    : Color.white;
            color.a = alpha;
            _block.SetColor(BaseColorId, color);
            _block.SetColor(ColorId, color);
            _renderer.SetPropertyBlock(_block);
        }
    }
}
