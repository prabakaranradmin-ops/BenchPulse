using System;
using System.Threading;
using System.Threading.Tasks;

namespace ArQuestTrail.Core
{
    /// <summary>What the completion outbox needs from the API — narrow, so the outbox is testable alone.</summary>
    public interface ICompletionApi
    {
        Task<ApiResult<CompletionResponse>> CompletePinAsync(
            string attemptId,
            string pinId,
            CompletionRequest request,
            CancellationToken cancellationToken = default);
    }

    /// <summary>
    /// Typed access to the player-facing API (server/README.md). Owns the session token: signs
    /// in lazily with the device key, refreshes ahead of expiry, and on a rejected token
    /// exchanges the key again exactly once — the key is the account (ST-2.6), so re-exchanging
    /// is always safe, and doing it once rather than in a loop keeps a broken setup from spinning.
    /// SR-DATA-01/02 holds by construction: no method takes a player id; the server reads it from
    /// the token.
    ///
    /// No <c>ConfigureAwait(false)</c> anywhere in Core, deliberately: Unity's synchronization
    /// context is what brings continuations back to the main thread, and the session events these
    /// calls raise are handled by MonoBehaviours that may only touch Unity from that thread.
    /// </summary>
    public sealed class QuestApiClient : ICompletionApi
    {
        /// <summary>Refresh a token this close to expiry rather than risk it lapsing mid-request.</summary>
        public static readonly TimeSpan RefreshMargin = TimeSpan.FromMinutes(5);

        private readonly IHttpTransport _transport;
        private readonly string _baseUrl;
        private readonly DeviceIdentity _identity;
        private readonly IClock _clock;
        private string _token;
        private DateTimeOffset _tokenExpiresAt;

        public QuestApiClient(IHttpTransport transport, string baseUrl, DeviceIdentity identity, IClock clock = null)
        {
            _transport = transport ?? throw new ArgumentNullException(nameof(transport));
            if (string.IsNullOrWhiteSpace(baseUrl))
            {
                throw new ArgumentException("The API base URL is required.", nameof(baseUrl));
            }

            _baseUrl = baseUrl.TrimEnd('/');
            _identity = identity ?? throw new ArgumentNullException(nameof(identity));
            _clock = clock ?? SystemClock.Instance;
        }

        /// <summary>The signed-in player's id, once a token exchange has succeeded.</summary>
        public string PlayerId { get; private set; }

        public bool HasSession => _token != null;

        public async Task<ApiResult<TokenResponse>> SignInAsync(CancellationToken cancellationToken = default)
        {
            string body = Json.Serialize(new TokenRequest { DeviceKey = _identity.GetOrCreateDeviceKey() });
            HttpResponseData response = await SendRawAsync("POST", "/api/v1/players/token", body, null, cancellationToken);
            ApiResult<TokenResponse> result = Parse<TokenResponse>(response);
            if (result.Ok)
            {
                _token = result.Value.Token;
                _tokenExpiresAt = _clock.UtcNow + TimeSpan.FromSeconds(result.Value.ExpiresInSeconds);
                PlayerId = result.Value.UserId;
            }

            return result;
        }

        /// <summary>Drops the in-memory session (after SR-PRIV-02 deletion, the token's player is gone).</summary>
        public void ForgetSession()
        {
            _token = null;
            PlayerId = null;
        }

        /// <summary>
        /// ST-2.10: what a join code points at. 400 <c>invalid_join_code</c> for a malformed code,
        /// 404 <c>join_code_not_found</c> for an unknown or unpublished one.
        /// </summary>
        public Task<ApiResult<JoinedTrailDto>> ResolveJoinCodeAsync(string code, CancellationToken cancellationToken = default) =>
            SendAsync<JoinedTrailDto>("GET", $"/api/v1/join/{Escape(code)}", null, cancellationToken);

        public Task<ApiResult<TrailDto>> GetTrailAsync(string trailId, CancellationToken cancellationToken = default) =>
            SendAsync<TrailDto>("GET", $"/api/v1/trails/{Escape(trailId)}", null, cancellationToken);

        /// <summary>GDR-07: the exact version an attempt is playing, even after the Admin replaced it.</summary>
        public Task<ApiResult<TrailDto>> GetTrailVersionAsync(
            string trailId,
            string trailVersionId,
            CancellationToken cancellationToken = default) =>
            SendAsync<TrailDto>(
                "GET",
                $"/api/v1/trails/{Escape(trailId)}/versions/{Escape(trailVersionId)}",
                null,
                cancellationToken);

        /// <summary>GDR-06: always a new attempt — replaying never overwrites history.</summary>
        public Task<ApiResult<AttemptDto>> StartAttemptAsync(string trailId, CancellationToken cancellationToken = default) =>
            SendAsync<AttemptDto>(
                "POST",
                "/api/v1/attempts",
                Json.Serialize(new StartAttemptRequest { TrailId = trailId }),
                cancellationToken);

        public Task<ApiResult<AttemptDto>> GetAttemptAsync(string attemptId, CancellationToken cancellationToken = default) =>
            SendAsync<AttemptDto>("GET", $"/api/v1/attempts/{Escape(attemptId)}", null, cancellationToken);

        public Task<ApiResult<CompletionResponse>> CompletePinAsync(
            string attemptId,
            string pinId,
            CompletionRequest request,
            CancellationToken cancellationToken = default) =>
            SendAsync<CompletionResponse>(
                "POST",
                $"/api/v1/attempts/{Escape(attemptId)}/pins/{Escape(pinId)}/complete",
                Json.Serialize(request),
                cancellationToken);

        /// <summary>GDR-09: "can't find this pin".</summary>
        public Task<ApiResult<PinReportResponse>> ReportPinAsync(
            string pinId,
            string note,
            CancellationToken cancellationToken = default) =>
            SendAsync<PinReportResponse>(
                "POST",
                $"/api/v1/pins/{Escape(pinId)}/report",
                Json.Serialize(new PinReportRequest { Note = string.IsNullOrWhiteSpace(note) ? null : note }),
                cancellationToken);

        /// <summary>SR-PRIV-02. The caller must then discard the device key and local data.</summary>
        public Task<ApiResult<DeleteMyDataResponse>> DeleteMyDataAsync(CancellationToken cancellationToken = default) =>
            SendAsync<DeleteMyDataResponse>("DELETE", "/api/v1/players/me", null, cancellationToken);

        private bool TokenNeedsRefresh => _token == null || _clock.UtcNow >= _tokenExpiresAt - RefreshMargin;

        private async Task<ApiResult<T>> SendAsync<T>(string method, string path, string body, CancellationToken cancellationToken)
        {
            if (TokenNeedsRefresh)
            {
                ApiResult<TokenResponse> signIn = await SignInAsync(cancellationToken);
                if (!signIn.Ok)
                {
                    return ApiResult<T>.Failure(signIn.Error);
                }
            }

            HttpResponseData response = await SendRawAsync(method, path, body, _token, cancellationToken);

            if (response.StatusCode == 401 && ApiError.FromResponse(response).Kind == ApiErrorKind.Unauthorized)
            {
                // Rejected despite looking valid locally — clock skew, or the server rotated its
                // secret. One fresh exchange, then report whatever comes back.
                ApiResult<TokenResponse> signIn = await SignInAsync(cancellationToken);
                if (!signIn.Ok)
                {
                    return ApiResult<T>.Failure(signIn.Error);
                }

                response = await SendRawAsync(method, path, body, _token, cancellationToken);
            }

            return Parse<T>(response);
        }

        private async Task<HttpResponseData> SendRawAsync(
            string method,
            string path,
            string body,
            string token,
            CancellationToken cancellationToken)
        {
            var request = new HttpRequestSpec(method, _baseUrl + path, body);
            request.Headers["Accept"] = "application/json";
            if (body != null)
            {
                request.Headers["Content-Type"] = "application/json";
            }

            if (token != null)
            {
                request.Headers["Authorization"] = "Bearer " + token;
            }

            try
            {
                return await _transport.SendAsync(request, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception exception)
            {
                // A transport that throws instead of reporting is treated as offline: the outbox
                // keeps the completion and retries, rather than the exception losing it.
                return HttpResponseData.Failed(exception.Message);
            }
        }

        private static ApiResult<T> Parse<T>(HttpResponseData response)
        {
            if (response.StatusCode >= 200 && response.StatusCode < 300)
            {
                try
                {
                    return ApiResult<T>.Success(Json.Deserialize<T>(response.Body));
                }
                catch (Newtonsoft.Json.JsonException exception)
                {
                    return ApiResult<T>.Failure(
                        new ApiError(response.StatusCode, ApiErrorKind.Unknown, "malformed_response", exception.Message, null));
                }
            }

            return ApiResult<T>.Failure(ApiError.FromResponse(response));
        }

        private static string Escape(string segment) => Uri.EscapeDataString(segment ?? string.Empty);
    }
}
