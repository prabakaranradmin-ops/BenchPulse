using System.Collections.Generic;

namespace ArQuestTrail.Core
{
    /// <summary>Persistent string storage. Unity backs it with files under Application.persistentDataPath.</summary>
    public interface IKeyValueStore
    {
        /// <summary>The stored value, or null if the key has never been set.</summary>
        string Get(string key);

        void Set(string key, string value);

        void Delete(string key);

        /// <summary>Removes everything — SR-PRIV-02's local half of "delete my data".</summary>
        void Clear();
    }

    public sealed class InMemoryKeyValueStore : IKeyValueStore
    {
        private readonly Dictionary<string, string> _values = new Dictionary<string, string>();

        public int Count => _values.Count;

        public string Get(string key) => _values.TryGetValue(key, out string value) ? value : null;

        public void Set(string key, string value) => _values[key] = value;

        public void Delete(string key) => _values.Remove(key);

        public void Clear() => _values.Clear();
    }
}
