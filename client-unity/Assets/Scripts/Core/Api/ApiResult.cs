using System;

namespace ArQuestTrail.Core
{
    public enum ApiErrorKind
    {
        /// <summary>No HTTP response at all — the device is offline or the server unreachable.</summary>
        Network,

        /// <summary>5xx.</summary>
        Server,

        /// <summary>429 — SR-SEC-03's per-player limit.</summary>
        RateLimited,

        /// <summary>401 that survived a fresh token exchange.</summary>
        Unauthorized,

        /// <summary>401 player_not_found: SR-PRIV-02 deleted this player; the device key is dead.</summary>
        PlayerGone,

        NotFound,
        Conflict,

        /// <summary>422: the server judged the request and said no (too far, weak GPS, wrong code).</summary>
        Rejected,

        BadRequest,
        Unknown,
    }

    public sealed class ApiError
    {
        public ApiError(int statusCode, ApiErrorKind kind, string code, string message, ApiErrorBody body)
        {
            StatusCode = statusCode;
            Kind = kind;
            Code = code;
            Message = message;
            Body = body;
        }

        public int StatusCode { get; }
        public ApiErrorKind Kind { get; }

        /// <summary>The server's machine-readable <c>error</c> string, e.g. "incorrect_code".</summary>
        public string Code { get; }

        /// <summary>The server's player-facing hint where it sends one, else a transport description.</summary>
        public string Message { get; }

        public ApiErrorBody Body { get; }

        /// <summary>Worth sending again later unchanged: the request itself was never judged.</summary>
        public bool IsRetryable =>
            Kind == ApiErrorKind.Network || Kind == ApiErrorKind.Server || Kind == ApiErrorKind.RateLimited;

        public static ApiError FromResponse(HttpResponseData response)
        {
            if (response.IsTransportFailure)
            {
                return new ApiError(0, ApiErrorKind.Network, "network_unavailable", response.TransportError, null);
            }

            ApiErrorBody body = null;
            try
            {
                body = string.IsNullOrEmpty(response.Body) ? null : Json.Deserialize<ApiErrorBody>(response.Body);
            }
            catch (Newtonsoft.Json.JsonException)
            {
                // A proxy or load balancer error page isn't JSON; the status code still classifies it.
            }

            string code = body?.Error;
            return new ApiError(response.StatusCode, Classify(response.StatusCode, code), code, body?.Message, body);
        }

        private static ApiErrorKind Classify(int status, string code)
        {
            if (status == 401)
            {
                return code == "player_not_found" ? ApiErrorKind.PlayerGone : ApiErrorKind.Unauthorized;
            }

            if (status == 400) return ApiErrorKind.BadRequest;
            if (status == 404) return ApiErrorKind.NotFound;
            if (status == 409) return ApiErrorKind.Conflict;
            if (status == 422) return ApiErrorKind.Rejected;
            if (status == 429) return ApiErrorKind.RateLimited;
            if (status >= 500) return ApiErrorKind.Server;
            return ApiErrorKind.Unknown;
        }

        public override string ToString() => $"{StatusCode} {Code ?? Kind.ToString()}{(Message == null ? "" : ": " + Message)}";
    }

    public sealed class ApiResult<T>
    {
        private ApiResult(bool ok, T value, ApiError error, bool fromCache)
        {
            Ok = ok;
            Value = value;
            Error = error;
            FromCache = fromCache;
        }

        public bool Ok { get; }
        public T Value { get; }
        public ApiError Error { get; }

        /// <summary>True when the value came from local storage because the network was unavailable (SR-NET-01).</summary>
        public bool FromCache { get; }

        public static ApiResult<T> Success(T value, bool fromCache = false) => new ApiResult<T>(true, value, null, fromCache);

        public static ApiResult<T> Failure(ApiError error) =>
            new ApiResult<T>(false, default, error ?? throw new ArgumentNullException(nameof(error)), false);
    }
}
