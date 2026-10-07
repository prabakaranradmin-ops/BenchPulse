using System;
using System.IO;
using System.Text;

namespace ArQuestTrail.Core
{
    /// <summary>
    /// One file per key in a directory. Writes go to a temporary file first and are then swapped
    /// into place, so a crash or a killed app mid-write leaves the previous value intact instead
    /// of a truncated one — which matters most for the completion outbox, where a half-written
    /// file would silently lose a player's offline progress (SR-NET-02).
    /// </summary>
    public sealed class FileKeyValueStore : IKeyValueStore
    {
        private const string Extension = ".json";
        private const string TempExtension = ".tmp";
        private readonly string _directory;

        public FileKeyValueStore(string directory)
        {
            _directory = directory ?? throw new ArgumentNullException(nameof(directory));
            Directory.CreateDirectory(_directory);
        }

        public string Get(string key)
        {
            string path = PathFor(key);
            return File.Exists(path) ? File.ReadAllText(path, Encoding.UTF8) : null;
        }

        public void Set(string key, string value)
        {
            string path = PathFor(key);
            string temp = path + TempExtension;
            File.WriteAllText(temp, value ?? string.Empty, Encoding.UTF8);

            if (File.Exists(path))
            {
                File.Replace(temp, path, null);
            }
            else
            {
                File.Move(temp, path);
            }
        }

        public void Delete(string key)
        {
            string path = PathFor(key);
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }

        public void Clear()
        {
            foreach (string file in Directory.GetFiles(_directory))
            {
                if (file.EndsWith(Extension, StringComparison.Ordinal)
                    || file.EndsWith(Extension + TempExtension, StringComparison.Ordinal))
                {
                    File.Delete(file);
                }
            }
        }

        private string PathFor(string key) => Path.Combine(_directory, EncodeFileName(key) + Extension);

        /// <summary>
        /// Keys become file names on every platform, so anything outside a conservative set is
        /// escaped — reversibly, so two different keys can never land on the same file.
        /// </summary>
        public static string EncodeFileName(string key)
        {
            if (string.IsNullOrEmpty(key))
            {
                throw new ArgumentException("A storage key can't be empty.", nameof(key));
            }

            var builder = new StringBuilder(key.Length);
            foreach (char c in key)
            {
                bool safe = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
                    || c == '-' || c == '_' || c == '.';
                if (safe)
                {
                    builder.Append(c);
                }
                else
                {
                    builder.Append('%').Append(((int)c).ToString("X4"));
                }
            }

            return builder.ToString();
        }
    }
}
