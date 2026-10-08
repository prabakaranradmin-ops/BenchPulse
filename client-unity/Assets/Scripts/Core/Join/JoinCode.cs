using System;
using System.Text;

namespace ArQuestTrail.Core
{
    /// <summary>
    /// ST-2.10 join codes — how a player finds a trail (decision 2026-10-07 #1: link, QR or code).
    /// The same rules as server/src/services/joinCode.ts: 8 characters from an alphabet with no
    /// look-alikes (no 0/O, no 1/I/L), shown as ABCD-EFGH, matched ignoring case, spaces and dashes.
    /// </summary>
    public static class JoinCode
    {
        public const string Alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
        public const int Length = 8;

        /// <summary>The custom URL scheme the app registers; the server's /join/ page links to it.</summary>
        public const string AppLinkScheme = "arquest";

        /// <summary>The canonical code (upper case, no separators), or null if the input can't be one.</summary>
        public static string Normalize(string input)
        {
            if (input == null)
            {
                return null;
            }

            var code = new StringBuilder(Length);
            foreach (char c in input.ToUpperInvariant())
            {
                if (char.IsWhiteSpace(c) || c == '-')
                {
                    continue;
                }

                if (Alphabet.IndexOf(c) < 0 || code.Length == Length)
                {
                    return null;
                }

                code.Append(c);
            }

            return code.Length == Length ? code.ToString() : null;
        }

        /// <summary>"ABCDEFGH" → "ABCD-EFGH", the way codes are printed.</summary>
        public static string Format(string code)
        {
            string normalized = Normalize(code) ?? throw new ArgumentException("Not a join code.", nameof(code));
            return normalized.Substring(0, 4) + "-" + normalized.Substring(4);
        }

        /// <summary>
        /// The code in anything a player might hand the app: the code itself, an
        /// <c>arquest://join/CODE</c> link that opened it, or the <c>https://…/join/CODE</c> page a
        /// QR code points at, pasted. Null when there is no code to be found.
        /// </summary>
        public static string FromInput(string input)
        {
            if (string.IsNullOrWhiteSpace(input))
            {
                return null;
            }

            string trimmed = input.Trim();
            if (trimmed.IndexOf("://", StringComparison.Ordinal) < 0)
            {
                return Normalize(trimmed);
            }

            if (!Uri.TryCreate(trimmed, UriKind.Absolute, out Uri uri))
            {
                return null;
            }

            string scheme = uri.Scheme.ToLowerInvariant();
            if (scheme == AppLinkScheme)
            {
                // arquest://join/CODE parses with "join" as the host.
                return string.Equals(uri.Host, "join", StringComparison.OrdinalIgnoreCase)
                    ? Normalize(FirstSegment(uri.AbsolutePath))
                    : null;
            }

            if (scheme == "https" || scheme == "http")
            {
                string[] segments = uri.AbsolutePath.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
                for (int i = segments.Length - 2; i >= 0; i--)
                {
                    if (string.Equals(segments[i], "join", StringComparison.OrdinalIgnoreCase))
                    {
                        return Normalize(Uri.UnescapeDataString(segments[i + 1]));
                    }
                }
            }

            return null;
        }

        private static string FirstSegment(string path)
        {
            string[] segments = path.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            return segments.Length == 0 ? null : Uri.UnescapeDataString(segments[0]);
        }
    }
}
