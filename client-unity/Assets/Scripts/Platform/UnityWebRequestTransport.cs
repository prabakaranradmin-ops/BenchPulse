using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using ArQuestTrail.Core;
using UnityEngine.Networking;

namespace ArQuestTrail
{
    /// <summary>
    /// <see cref="IHttpTransport"/> over UnityWebRequest, which uses each platform's own TLS stack —
    /// the reason iOS ATS and Android's cleartext policy are satisfied by an https tunnel URL
    /// (requirements §6.8). Completes on the main thread, so the Core continuations do too.
    /// </summary>
    public sealed class UnityWebRequestTransport : IHttpTransport
    {
        private readonly int _timeoutSeconds;

        public UnityWebRequestTransport(int timeoutSeconds = 15)
        {
            _timeoutSeconds = timeoutSeconds;
        }

        public Task<HttpResponseData> SendAsync(HttpRequestSpec request, CancellationToken cancellationToken)
        {
            var completion = new TaskCompletionSource<HttpResponseData>();
            var web = new UnityWebRequest(request.Url, request.Method)
            {
                downloadHandler = new DownloadHandlerBuffer(),
                timeout = _timeoutSeconds,
            };

            if (request.Body != null)
            {
                web.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(request.Body));
            }

            foreach (KeyValuePair<string, string> header in request.Headers)
            {
                web.SetRequestHeader(header.Key, header.Value);
            }

            CancellationTokenRegistration registration = cancellationToken.Register(web.Abort);
            UnityWebRequestAsyncOperation operation = web.SendWebRequest();
            operation.completed += _ =>
            {
                registration.Dispose();
                try
                {
                    if (cancellationToken.IsCancellationRequested)
                    {
                        completion.TrySetCanceled(cancellationToken);
                    }
                    else if (web.responseCode == 0)
                    {
                        // No HTTP response at all: offline, DNS, TLS, or timeout. "Offline" is a
                        // normal state for this app (SR-NET-02), so it is reported, not thrown.
                        completion.TrySetResult(HttpResponseData.Failed(web.error));
                    }
                    else
                    {
                        completion.TrySetResult(new HttpResponseData((int)web.responseCode, web.downloadHandler?.text));
                    }
                }
                finally
                {
                    web.Dispose();
                }
            };

            return completion.Task;
        }
    }

    /// <summary>
    /// Airplane mode on demand — the field-test HUD's toggle for requirements §7's SR-NET test,
    /// without actually losing the connection to the dev server.
    /// </summary>
    public sealed class AirplaneModeTransport : IHttpTransport
    {
        private readonly IHttpTransport _inner;

        public AirplaneModeTransport(IHttpTransport inner)
        {
            _inner = inner;
        }

        public bool Enabled { get; set; }

        public Task<HttpResponseData> SendAsync(HttpRequestSpec request, CancellationToken cancellationToken) =>
            Enabled
                ? Task.FromResult(HttpResponseData.Failed("Airplane mode (simulated)"))
                : _inner.SendAsync(request, cancellationToken);
    }
}
