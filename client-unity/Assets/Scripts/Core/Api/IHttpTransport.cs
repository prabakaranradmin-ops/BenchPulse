using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace ArQuestTrail.Core
{
    public sealed class HttpRequestSpec
    {
        public HttpRequestSpec(string method, string url, string body = null)
        {
            Method = method;
            Url = url;
            Body = body;
        }

        public string Method { get; }
        public string Url { get; }

        /// <summary>JSON, or null for a bodyless request.</summary>
        public string Body { get; }

        public Dictionary<string, string> Headers { get; } = new Dictionary<string, string>();
    }

    public sealed class HttpResponseData
    {
        public HttpResponseData(int statusCode, string body, string transportError = null)
        {
            StatusCode = statusCode;
            Body = body;
            TransportError = transportError;
        }

        /// <summary>0 when no HTTP response arrived at all (offline, DNS, TLS, timeout).</summary>
        public int StatusCode { get; }

        public string Body { get; }

        public string TransportError { get; }

        public bool IsTransportFailure => StatusCode == 0;

        public static HttpResponseData Failed(string error) => new HttpResponseData(0, null, error);
    }

    /// <summary>
    /// The one seam between the client's logic and the network. Unity implements it with
    /// UnityWebRequest (the platform TLS stack on iOS/Android); tests use fakes or HttpClient.
    /// Implementations must not throw for an HTTP error status — only report it — and must
    /// turn a network failure into <see cref="HttpResponseData.Failed"/>, because "offline" is
    /// an expected state for this app (SR-NET-02), not an exceptional one.
    /// </summary>
    public interface IHttpTransport
    {
        Task<HttpResponseData> SendAsync(HttpRequestSpec request, CancellationToken cancellationToken);
    }
}
