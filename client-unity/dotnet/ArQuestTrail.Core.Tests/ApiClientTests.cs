using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using ArQuestTrail.Core;
using Newtonsoft.Json.Linq;
using Xunit;

namespace ArQuestTrail.Core.Tests
{
    public class QuestApiClientTests
    {
        private static readonly DateTimeOffset T0 = new DateTimeOffset(2026, 5, 1, 9, 0, 0, TimeSpan.Zero);

        private static (QuestApiClient Client, FakeTransport Transport, FakeClock Clock) ClientWith(
            Func<HttpRequestSpec, HttpResponseData> routes,
            int expiresInSeconds = 2592000)
        {
            int tokens = 0;
            var transport = new FakeTransport(request =>
            {
                if (request.Url.EndsWith("/api/v1/players/token", StringComparison.Ordinal))
                {
                    tokens++;
                    return FakeTransport.Respond(200, new TokenResponse
                    {
                        UserId = "user-1",
                        Token = "token-" + tokens,
                        ExpiresInSeconds = expiresInSeconds,
                    });
                }

                return routes(request);
            });
            var clock = new FakeClock(T0);
            var client = new QuestApiClient(transport, "https://api.example.test/", new DeviceIdentity(new InMemoryKeyValueStore()), clock);
            return (client, transport, clock);
        }

        private static HttpResponseData Attempt(HttpRequestSpec _) =>
            FakeTransport.Respond(200, new AttemptDto { AttemptId = "a-1", Status = "active" });

        [Fact]
        public async Task Signs_in_lazily_and_sends_the_token_as_a_bearer()
        {
            var (client, transport, _) = ClientWith(Attempt);

            ApiResult<AttemptDto> result = await client.GetAttemptAsync("a-1");

            Assert.True(result.Ok);
            Assert.Equal(2, transport.Requests.Count);
            Assert.Equal("https://api.example.test/api/v1/players/token", transport.Requests[0].Url);
            Assert.Equal("Bearer token-1", transport.Requests[1].Headers["Authorization"]);
            Assert.Equal("user-1", client.PlayerId);
        }

        [Fact]
        public async Task Exchanges_the_same_device_key_every_time()
        {
            var (client, transport, clock) = ClientWith(Attempt, expiresInSeconds: 600);

            await client.GetAttemptAsync("a-1");
            clock.Advance(TimeSpan.FromMinutes(6)); // inside the 5-minute refresh margin
            await client.GetAttemptAsync("a-1");

            string[] keys = transport.Requests
                .Where(r => r.Url.EndsWith("/players/token", StringComparison.Ordinal))
                .Select(r => JObject.Parse(r.Body)["deviceKey"].ToString())
                .ToArray();
            Assert.Equal(2, keys.Length);
            Assert.Equal(keys[0], keys[1]);
            Assert.Equal(64, keys[0].Length);
        }

        [Fact]
        public async Task Reuses_a_token_that_is_not_close_to_expiry()
        {
            var (client, transport, clock) = ClientWith(Attempt);

            await client.GetAttemptAsync("a-1");
            clock.Advance(TimeSpan.FromDays(10));
            await client.GetAttemptAsync("a-1");

            Assert.Equal(1, transport.Requests.Count(r => r.Url.EndsWith("/players/token", StringComparison.Ordinal)));
        }

        [Fact]
        public async Task Re_exchanges_the_key_once_when_a_token_is_rejected_then_retries()
        {
            int calls = 0;
            var (client, transport, _) = ClientWith(request =>
            {
                calls++;
                return calls == 1 ? FakeTransport.Respond(401, new { error = "unauthorized" }) : Attempt(request);
            });

            ApiResult<AttemptDto> result = await client.GetAttemptAsync("a-1");

            Assert.True(result.Ok);
            Assert.Equal("Bearer token-2", transport.Requests.Last().Headers["Authorization"]);
        }

        [Fact]
        public async Task Gives_up_after_one_re_exchange_instead_of_looping()
        {
            var (client, transport, _) = ClientWith(_ => FakeTransport.Respond(401, new { error = "unauthorized" }));

            ApiResult<AttemptDto> result = await client.GetAttemptAsync("a-1");

            Assert.Equal(ApiErrorKind.Unauthorized, result.Error.Kind);
            Assert.Equal(4, transport.Requests.Count); // token, call, token, call
        }

        [Fact]
        public async Task Recognises_a_deleted_player_rather_than_retrying_the_token()
        {
            var (client, transport, _) = ClientWith(_ => FakeTransport.Respond(401, new { error = "player_not_found" }));

            ApiResult<AttemptDto> result = await client.StartAttemptAsync("trail-1");

            Assert.Equal(ApiErrorKind.PlayerGone, result.Error.Kind);
            Assert.Equal(2, transport.Requests.Count);
        }

        [Fact]
        public async Task Omits_optional_fields_instead_of_sending_null()
        {
            // The server validates with additionalProperties:false and typed optional fields, so
            // `"challengeAnswer": null` is a 400 — the field has to be absent.
            var (client, transport, _) = ClientWith(_ => FakeTransport.Respond(200, new CompletionResponse()));

            await client.CompletePinAsync("a-1", "p-1", new CompletionRequest
            {
                Lat = 1,
                Lng = 2,
                AccuracyM = 5,
                RecordedAt = "2026-05-01T09:00:00.000Z",
                RecentLocationHistory = new List<LocationSampleDto>
                {
                    new LocationSampleDto { Lat = 1, Lng = 2, RecordedAt = "2026-05-01T08:59:59.000Z" },
                },
            });

            JObject body = JObject.Parse(transport.Requests.Last().Body);
            Assert.Equal(
                new[] { "lat", "lng", "accuracyM", "recordedAt", "recentLocationHistory" },
                body.Properties().Select(p => p.Name).ToArray());
            Assert.Equal(
                new[] { "lat", "lng", "recordedAt" },
                ((JObject)body["recentLocationHistory"][0]).Properties().Select(p => p.Name).ToArray());
        }

        [Fact]
        public async Task Escapes_ids_in_the_path()
        {
            var (client, transport, _) = ClientWith(Attempt);

            await client.GetAttemptAsync("a/../../admin");

            Assert.Equal("https://api.example.test/api/v1/attempts/a%2F..%2F..%2Fadmin", transport.Requests.Last().Url);
        }

        [Fact]
        public async Task Classifies_failures_and_keeps_the_server_hint()
        {
            var (client, _, _) = ClientWith(_ => FakeTransport.Respond(422, new
            {
                error = "accuracy_exceeds_ceiling",
                message = "GPS signal weak — move to open sky",
                effectiveRadiusM = 50,
            }));

            ApiResult<CompletionResponse> result = await client.CompletePinAsync("a-1", "p-1", new CompletionRequest());

            Assert.Equal(ApiErrorKind.Rejected, result.Error.Kind);
            Assert.Equal("accuracy_exceeds_ceiling", result.Error.Code);
            Assert.Equal("GPS signal weak — move to open sky", result.Error.Message);
            Assert.Equal(50, result.Error.Body.EffectiveRadiusM);
            Assert.False(result.Error.IsRetryable);
        }

        [Theory]
        [InlineData(0, ApiErrorKind.Network, true)]
        [InlineData(500, ApiErrorKind.Server, true)]
        [InlineData(503, ApiErrorKind.Server, true)]
        [InlineData(429, ApiErrorKind.RateLimited, true)]
        [InlineData(404, ApiErrorKind.NotFound, false)]
        [InlineData(409, ApiErrorKind.Conflict, false)]
        [InlineData(400, ApiErrorKind.BadRequest, false)]
        public void Decides_what_is_worth_retrying(int status, ApiErrorKind kind, bool retryable)
        {
            HttpResponseData response = status == 0
                ? HttpResponseData.Failed("offline")
                : new HttpResponseData(status, "<html>proxy error page</html>");

            ApiError error = ApiError.FromResponse(response);

            Assert.Equal(kind, error.Kind);
            Assert.Equal(retryable, error.IsRetryable);
        }

        [Fact]
        public async Task Treats_a_throwing_transport_as_offline_so_nothing_is_lost()
        {
            var transport = new FakeTransport(_ => throw new IOException("socket closed"));
            var client = new QuestApiClient(transport, "https://api.example.test", new DeviceIdentity(new InMemoryKeyValueStore()));

            ApiResult<AttemptDto> result = await client.GetAttemptAsync("a-1");

            Assert.Equal(ApiErrorKind.Network, result.Error.Kind);
        }
    }

    public class StorageAndIdentityTests : IDisposable
    {
        private readonly string _directory = Path.Combine(Path.GetTempPath(), "arqt-tests-" + Guid.NewGuid().ToString("N"));

        public void Dispose()
        {
            if (Directory.Exists(_directory))
            {
                Directory.Delete(_directory, recursive: true);
            }
        }

        [Fact]
        public void File_store_round_trips_and_survives_a_new_instance()
        {
            new FileKeyValueStore(_directory).Set("completion_outbox", "[1,2,3]");

            var reopened = new FileKeyValueStore(_directory);

            Assert.Equal("[1,2,3]", reopened.Get("completion_outbox"));
            reopened.Set("completion_outbox", "[]");
            Assert.Equal("[]", reopened.Get("completion_outbox"));
        }

        [Fact]
        public void File_store_keeps_awkward_keys_apart()
        {
            var store = new FileKeyValueStore(_directory);
            store.Set("a/b", "slash");
            store.Set("a:b", "colon");
            store.Set("a_b", "underscore");

            Assert.Equal("slash", store.Get("a/b"));
            Assert.Equal("colon", store.Get("a:b"));
            Assert.Equal("underscore", store.Get("a_b"));
        }

        [Fact]
        public void File_store_delete_and_clear()
        {
            var store = new FileKeyValueStore(_directory);
            store.Set("one", "1");
            store.Set("two", "2");

            store.Delete("one");
            Assert.Null(store.Get("one"));

            store.Clear();
            Assert.Null(store.Get("two"));
            Assert.Empty(Directory.GetFiles(_directory));
        }

        [Fact]
        public void Device_key_is_generated_once_and_kept()
        {
            var store = new InMemoryKeyValueStore();
            var identity = new DeviceIdentity(store);

            string first = identity.GetOrCreateDeviceKey();

            Assert.Matches("^[0-9a-f]{64}$", first);
            Assert.Equal(first, new DeviceIdentity(store).GetOrCreateDeviceKey());
        }

        [Fact]
        public void Forgetting_the_key_makes_the_next_one_a_new_player()
        {
            var identity = new DeviceIdentity(new InMemoryKeyValueStore());
            string first = identity.GetOrCreateDeviceKey();

            identity.Forget();

            Assert.False(identity.HasDeviceKey);
            Assert.NotEqual(first, identity.GetOrCreateDeviceKey());
        }
    }
}
