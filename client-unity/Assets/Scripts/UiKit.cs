using UnityEngine;

namespace ArQuestTrail
{
    /// <summary>
    /// The look shared by the app's screens (decision 2026-10-07 #2: a clean default). Dark
    /// surfaces, one teal accent (the admin tool's and the join page's), large touch targets.
    /// Immediate-mode GUI, like the field-test HUD, so nothing needs prefabs or scene wiring.
    /// </summary>
    public sealed class UiKit
    {
        /// <summary>Screens lay out in a column this wide, scaled to the device.</summary>
        public const float VirtualWidth = 420f;

        public static readonly Color Background = new Color32(0x0b, 0x11, 0x20, 0xff);
        public static readonly Color Surface = new Color32(0x11, 0x18, 0x27, 0xff);
        public static readonly Color SurfaceHover = new Color32(0x1f, 0x29, 0x37, 0xff);
        public static readonly Color Accent = new Color32(0x2d, 0xd4, 0xbf, 0xff);
        public static readonly Color AccentPressed = new Color32(0x14, 0xb8, 0xa6, 0xff);
        public static readonly Color OnAccent = new Color32(0x04, 0x2f, 0x2e, 0xff);
        public static readonly Color Text = new Color32(0xe5, 0xe7, 0xeb, 0xff);
        public static readonly Color Muted = new Color32(0x94, 0xa3, 0xb8, 0xff);
        public static readonly Color Warning = new Color32(0xfb, 0xbf, 0x24, 0xff);
        public static readonly Color Danger = new Color32(0xf8, 0x71, 0x71, 0xff);

        private static UiKit _instance;

        private UiKit()
        {
            Page = new GUIStyle { normal = { background = Solid(Background) } };
            Title = Label(26, FontStyle.Bold, Text);
            Heading = Label(18, FontStyle.Bold, Text);
            Body = Label(16, FontStyle.Normal, Text);
            Small = Label(14, FontStyle.Normal, Muted);
            Alert = Label(15, FontStyle.Normal, Warning);
            Error = Label(15, FontStyle.Normal, Danger);
            Code = Label(28, FontStyle.Bold, Accent);
            Code.alignment = TextAnchor.MiddleCenter;

            Card = new GUIStyle
            {
                normal = { background = Solid(Surface), textColor = Text },
                hover = { background = Solid(SurfaceHover), textColor = Text },
                active = { background = Solid(SurfaceHover), textColor = Text },
                padding = new RectOffset(16, 16, 14, 14),
                margin = new RectOffset(0, 0, 0, 10),
                fontSize = 16,
                richText = true,
                wordWrap = true,
                alignment = TextAnchor.MiddleLeft,
            };

            Primary = Button(Accent, AccentPressed, OnAccent);
            Secondary = Button(Surface, SurfaceHover, Text);
            Destructive = Button(Surface, SurfaceHover, Danger);
            Link = new GUIStyle(Label(15, FontStyle.Bold, Accent))
            {
                padding = new RectOffset(0, 0, 10, 10),
                wordWrap = false,
            };

            Field = new GUIStyle
            {
                normal = { background = Solid(Surface), textColor = Text },
                focused = { background = Solid(SurfaceHover), textColor = Text },
                padding = new RectOffset(14, 14, 14, 14),
                margin = new RectOffset(0, 0, 6, 12),
                fontSize = 24,
                fontStyle = FontStyle.Bold,
                alignment = TextAnchor.MiddleCenter,
                clipping = TextClipping.Clip,
            };
        }

        public static UiKit Styles => _instance ?? (_instance = new UiKit());

        public GUIStyle Page { get; }
        public GUIStyle Title { get; }
        public GUIStyle Heading { get; }
        public GUIStyle Body { get; }
        public GUIStyle Small { get; }
        public GUIStyle Alert { get; }
        public GUIStyle Error { get; }
        public GUIStyle Code { get; }
        public GUIStyle Card { get; }
        public GUIStyle Primary { get; }
        public GUIStyle Secondary { get; }
        public GUIStyle Destructive { get; }
        public GUIStyle Link { get; }
        public GUIStyle Field { get; }

        /// <summary>
        /// Scales GUI to the screen. Returns the whole screen and its safe area (clear of notches
        /// and home indicators), both in scaled units.
        /// </summary>
        public static (Rect Screen, Rect Safe) BeginScaled()
        {
            float scale = Mathf.Max(1f, UnityEngine.Screen.width / VirtualWidth);
            GUI.matrix = Matrix4x4.Scale(new Vector3(scale, scale, 1f));
            Rect safe = UnityEngine.Screen.safeArea;
            // safeArea's origin is the bottom-left corner; GUI's is the top-left.
            return (
                new Rect(0, 0, UnityEngine.Screen.width / scale, UnityEngine.Screen.height / scale),
                new Rect(
                    safe.x / scale,
                    (UnityEngine.Screen.height - safe.yMax) / scale,
                    safe.width / scale,
                    safe.height / scale));
        }

        /// <summary>Player-authored text (a trail name) inside rich-text labels, unable to inject tags.</summary>
        public static string Plain(string text) =>
            (text ?? string.Empty).Replace("<", "‹").Replace(">", "›");

        /// <summary>A full-width button that is easy to hit (48 virtual px tall, above the 44pt guideline).</summary>
        public static bool Action(string text, GUIStyle style, bool enabled = true)
        {
            bool wasEnabled = GUI.enabled;
            GUI.enabled = wasEnabled && enabled;
            bool clicked = GUILayout.Button(text, style, GUILayout.Height(48), GUILayout.ExpandWidth(true));
            GUI.enabled = wasEnabled;
            return clicked;
        }

        private static GUIStyle Label(int size, FontStyle fontStyle, Color color) => new GUIStyle
        {
            fontSize = size,
            fontStyle = fontStyle,
            wordWrap = true,
            richText = true,
            normal = { textColor = color },
            margin = new RectOffset(0, 0, 4, 8),
        };

        private static GUIStyle Button(Color fill, Color pressed, Color text) => new GUIStyle
        {
            normal = { background = Solid(fill), textColor = text },
            hover = { background = Solid(pressed), textColor = text },
            active = { background = Solid(pressed), textColor = text },
            fontSize = 17,
            fontStyle = FontStyle.Bold,
            alignment = TextAnchor.MiddleCenter,
            margin = new RectOffset(0, 0, 6, 6),
            padding = new RectOffset(12, 12, 10, 10),
        };

        private static Texture2D Solid(Color color)
        {
            var texture = new Texture2D(1, 1) { hideFlags = HideFlags.HideAndDontSave };
            texture.SetPixel(0, 0, color);
            texture.Apply();
            return texture;
        }
    }
}
