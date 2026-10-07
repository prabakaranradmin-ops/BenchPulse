using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using ArQuestTrail.Core;
using Newtonsoft.Json.Linq;
using Xunit;

namespace ArQuestTrail.Core.Tests.Contract
{
    /// <summary>
    /// Runs only when QUEST_API_URL points at a live server. Set but unreachable is a failure,
    /// not a skip — otherwise CI could go green without ever exercising the real contract.
    /// </summary>
    public sealed class ContractFactAttribute : FactAttribute
    {
        public ContractFactAttribute()
        {
            if (string.IsNullOrWhiteSpace(ContractEnvironment.ApiUrl))
            {
                Skip = "QUEST_API_URL is not set — start the server (docker compose up) to run contract tests.";
            }
        }
    }

    internal static class ContractEnvironment
    {
        public static string ApiUrl => Environment.GetEnvironmentVariable("QUEST_API_URL");

        /// <summary>A device key already promoted to Admin (seedFieldTestTrail --admin-key does this).</summary>
        public static string AdminDeviceKey
        {
            get
            {
                string key = Environment.GetEnvironmentVariable("QUEST_ADMIN_DEVICE_KEY");
                if (string.IsNullOrWhiteSpace(key))
                {
                    throw new InvalidOperationException(
                        "QUEST_ADMIN_DEVICE_KEY is required with QUEST_API_URL: the contract tests author their own trails.");
                }

                return key;
            }
        }
    }

    /// <summary>The real network, as UnityWebRequest would see it — minus the Unity.</summary>
    internal sealed class HttpClientTransport : IHttpTransport
    {
        private static readonly HttpClient Client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };

        public async Task<HttpResponseData> SendAsync(HttpRequestSpec request, CancellationToken cancellationToken)
        {
            using var message = new HttpRequestMessage(new HttpMethod(request.Method), request.Url);
            if (request.Body != null)
            {
                message.Content = new StringContent(request.Body, Encoding.UTF8, "application/json");
            }

            foreach (KeyValuePair<string, string> header in request.Headers)
            {
                if (!header.Key.Equals("Content-Type", StringComparison.OrdinalIgnoreCase))
                {
                    message.Headers.TryAddWithoutValidation(header.Key, header.Value);
                }
            }

            try
            {
                using HttpResponseMessage response = await Client.SendAsync(message, cancellationToken);
                return new HttpResponseData((int)response.StatusCode, await response.Content.ReadAsStringAsync(cancellationToken));
            }
            catch (HttpRequestException exception)
            {
                return HttpResponseData.Failed(exception.Message);
            }
        }
    }

    /// <summary>Airplane mode on demand (requirements §7's SR-NET test).</summary>
    internal sealed class SwitchableTransport : IHttpTransport
    {
        private readonly IHttpTransport _inner;

        public SwitchableTransport(IHttpTransport inner) => _inner = inner;

        public bool Offline { get; set; }

        public Task<HttpResponseData> SendAsync(HttpRequestSpec request, CancellationToken cancellationToken) =>
            Offline ? Task.FromResult(HttpResponseData.Failed("airplane mode")) : _inner.SendAsync(request, cancellationToken);
    }

    /// <summary>A player on a real server: their own device key, client, session, and airplane-mode switch.</summary>
    internal sealed class ContractPlayer
    {
        public ContractPlayer()
        {
            Data = new InMemoryKeyValueStore();
            Secure = new InMemoryKeyValueStore();
            Transport = new SwitchableTransport(new HttpClientTransport());
            Identity = new DeviceIdentity(Secure);
            Api = new QuestApiClient(Transport, ContractEnvironment.ApiUrl, Identity);
            Session = new QuestSession(Api, Data, Identity);
            Session.History.MarkSessionStarted(DateTimeOffset.UtcNow.AddMinutes(-4));
        }

        public InMemoryKeyValueStore Data { get; }
        public InMemoryKeyValueStore Secure { get; }
        public SwitchableTransport Transport { get; }
        public DeviceIdentity Identity { get; }
        public QuestApiClient Api { get; }
        public QuestSession Session { get; }

        /// <summary>A fresh session over the same device storage — an app restart.</summary>
        public QuestSession Restart()
        {
            var api = new QuestApiClient(Transport, ContractEnvironment.ApiUrl, Identity);
            return new QuestSession(api, Data, Identity);
        }
    }

    /// <summary>Authors trails through the real Admin API (EPIC 7), so every test owns its fixture.</summary>
    internal static class ContractAdmin
    {
        public const double BaseLat = 13.0827;
        public const double BaseLng = 80.2707;

        private static readonly HttpClientTransport Transport = new HttpClientTransport();
        private static string _token;

        public sealed class PinSpec
        {
            public double EastMeters { get; set; }
            public string Type { get; set; } = ChallengeTypes.ProximityDwell;
            public string Code { get; set; }
            public double RadiusM { get; set; } = 10;
        }

        public static async Task<string> CreateTrailAsync(string name, params PinSpec[] pins)
        {
            JObject created = await SendAsync("POST", "/api/v1/admin/trails", new JObject { ["name"] = name });
            string trailId = created["trailId"].ToString();
            await PublishAsync(trailId, pins);
            return trailId;
        }

        public static async Task<JObject> PublishAsync(string trailId, params PinSpec[] pins)
        {
            var body = new JObject
            {
                ["pins"] = new JArray(pins.Select((pin, index) =>
                {
                    (double lat, double lng) = Geo.EastOf(BaseLat, BaseLng, pin.EastMeters);
                    var config = new JObject();
                    if (pin.Type == ChallengeTypes.ProximityDwell)
                    {
                        config["dwell_seconds"] = 15;
                    }

                    if (pin.Code != null)
                    {
                        config["code"] = pin.Code;
                        config["hint"] = "Read the plaque";
                    }

                    return new JObject
                    {
                        ["sequenceIndex"] = index + 1,
                        ["lat"] = lat,
                        ["lng"] = lng,
                        ["radiusM"] = pin.RadiusM,
                        ["challengeType"] = pin.Type,
                        ["challengeConfig"] = config,
                    };
                })),
            };
            return await SendAsync("POST", $"/api/v1/admin/trails/{trailId}/versions", body);
        }

        private static async Task<JObject> SendAsync(string method, string path, JObject body)
        {
            if (_token == null)
            {
                var signIn = new HttpRequestSpec(
                    "POST",
                    ContractEnvironment.ApiUrl.TrimEnd('/') + "/api/v1/players/token",
                    new JObject { ["deviceKey"] = ContractEnvironment.AdminDeviceKey }.ToString());
                signIn.Headers["Content-Type"] = "application/json";
                HttpResponseData token = await Transport.SendAsync(signIn, CancellationToken.None);
                Assert.True(token.StatusCode == 200, $"Admin sign-in failed: {token.StatusCode} {token.Body ?? token.TransportError}");
                _token = JObject.Parse(token.Body)["token"].ToString();
            }

            var request = new HttpRequestSpec(method, ContractEnvironment.ApiUrl.TrimEnd('/') + path, body.ToString());
            request.Headers["Content-Type"] = "application/json";
            request.Headers["Authorization"] = "Bearer " + _token;
            HttpResponseData response = await Transport.SendAsync(request, CancellationToken.None);
            Assert.True(
                response.StatusCode == 201,
                $"{method} {path} failed: {response.StatusCode} {response.Body ?? response.TransportError}. " +
                "Is QUEST_ADMIN_DEVICE_KEY promoted to admin?");
            return JObject.Parse(response.Body);
        }
    }
}
