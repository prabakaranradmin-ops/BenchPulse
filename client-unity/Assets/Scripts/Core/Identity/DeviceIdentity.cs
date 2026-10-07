using System.Security.Cryptography;
using System.Text;

namespace ArQuestTrail.Core
{
    /// <summary>
    /// ST-2.6's client half: a high-entropy key generated once and exchanged for session tokens.
    /// For v1 the device key <em>is</em> the account (confirmed for the ST-4.3 field test) — lose
    /// it and the player's progress is gone, so it is generated once and never regenerated
    /// behind the player's back. Only <see cref="Forget"/> (SR-PRIV-02 deletion) discards it.
    /// </summary>
    public sealed class DeviceIdentity
    {
        private const string StoreKey = "device_key";

        /// <summary>256 bits, hex-encoded to 64 characters — comfortably over the server's 32-character floor.</summary>
        private const int KeyBytes = 32;

        private readonly IKeyValueStore _secureStore;

        /// <param name="secureStore">
        /// Should be platform secure storage (iOS Keychain / Android Keystore). The Unity layer
        /// currently passes an app-sandboxed file store, which is fine for a field test and not
        /// for launch — see client-unity/README.md.
        /// </param>
        public DeviceIdentity(IKeyValueStore secureStore)
        {
            _secureStore = secureStore;
        }

        public bool HasDeviceKey => !string.IsNullOrEmpty(_secureStore.Get(StoreKey));

        public string GetOrCreateDeviceKey()
        {
            string existing = _secureStore.Get(StoreKey);
            if (!string.IsNullOrEmpty(existing))
            {
                return existing;
            }

            var bytes = new byte[KeyBytes];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }

            string key = ToHex(bytes);
            _secureStore.Set(StoreKey, key);
            return key;
        }

        /// <summary>SR-PRIV-02: after "delete my data" the server tells the client to discard the key.</summary>
        public void Forget() => _secureStore.Delete(StoreKey);

        private static string ToHex(byte[] bytes)
        {
            var builder = new StringBuilder(bytes.Length * 2);
            foreach (byte b in bytes)
            {
                builder.Append(b.ToString("x2"));
            }

            return builder.ToString();
        }
    }
}
