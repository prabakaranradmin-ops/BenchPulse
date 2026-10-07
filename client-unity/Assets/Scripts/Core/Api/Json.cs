using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;

namespace ArQuestTrail.Core
{
    /// <summary>One set of serializer settings for everything the client sends, receives, or stores.</summary>
    public static class Json
    {
        public static readonly JsonSerializerSettings Settings = new JsonSerializerSettings
        {
            // DTOs use C# names; the API is camelCase. Explicit [JsonProperty] names (the
            // snake_case challenge keys) still win over the resolver.
            ContractResolver = new CamelCasePropertyNamesContractResolver(),

            // The server validates request bodies with JSON Schema and `additionalProperties:
            // false`: an optional field sent as `null` is a 400, not "absent". Omit it instead.
            NullValueHandling = NullValueHandling.Ignore,

            // Timestamps stay strings until IsoTime parses them on purpose. Newtonsoft's default
            // would turn them into local-time DateTimes and quietly shift them by the offset.
            DateParseHandling = DateParseHandling.None,

            MissingMemberHandling = MissingMemberHandling.Ignore,
        };

        public static string Serialize(object value) => JsonConvert.SerializeObject(value, Settings);

        public static T Deserialize<T>(string json) => JsonConvert.DeserializeObject<T>(json, Settings);
    }
}
