import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../plugins/auth.js';
import { formatJoinCode, normalizeJoinCode } from '../services/joinCode.js';

/** The custom URL scheme the Unity app registers (client-unity/README.md). */
export const APP_LINK_SCHEME = 'arquest';

/**
 * Per IP, and tighter than the per-player limit (SR-SEC-03): a code is all that stands between a
 * player and an unlisted trail, and fresh device keys mint fresh players for free — so guessing
 * has to be slow for an address, not just for an account.
 */
const JOIN_RATE_LIMIT = {
  max: 20,
  timeWindow: '1 minute',
  keyGenerator: (request: FastifyRequest) => request.ip,
};

/**
 * Join codes — how players find a trail (decision 2026-10-07): a link, a QR code, or a code typed
 * into the app. There is deliberately no listing or nearby search (SR-DATA-02).
 */
export async function joinRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/join/:code — what the app calls to turn a code into a trail.
  app.get(
    '/api/v1/join/:code',
    { onRequest: [authenticate], config: { rateLimit: JOIN_RATE_LIMIT } },
    async (request, reply) => {
      const code = normalizeJoinCode((request.params as { code: string }).code);
      if (!code) {
        // Distinct from "not found" so the app can say "check the code" rather than "no trail".
        return reply.code(400).send({ error: 'invalid_join_code' });
      }

      const trail = await app.store.getTrailByJoinCode(code);
      // An unpublished trail is indistinguishable from no trail: there is nothing to play.
      if (!trail || !trail.currentVersionId) {
        return reply.code(404).send({ error: 'join_code_not_found' });
      }

      const pins = await app.store.getPinsForVersion(trail.currentVersionId);
      return reply.send({
        trailId: trail.id,
        name: trail.name,
        joinCode: formatJoinCode(trail.joinCode),
        pinCount: pins.length,
        expiryDays: trail.expiryDays,
      });
    },
  );

  // GET /join/:code — what a QR code or shared link opens in a phone's browser. Hands off to the
  // app. Shows only the code itself — never trail details, which need a signed-in player
  // (SR-DATA-02) — and renders the same page whether or not the code exists, so this public page
  // can't be used to test codes.
  app.get('/join/:code', { config: { rateLimit: JOIN_RATE_LIMIT } }, async (request, reply) => {
    const code = normalizeJoinCode((request.params as { code: string }).code);
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer');

    if (!code) {
      return reply
        .code(404)
        .send(
          page(
            'Link not valid',
            '<p>This trail link isn’t valid. Check it with whoever shared it.</p>',
          ),
        );
    }

    // Safe to interpolate: a normalized code is only ever characters from the join alphabet.
    const display = formatJoinCode(code);
    return reply.send(
      page(
        `Join trail ${display}`,
        `<p class="lead">You’ve been invited to an AR quest trail.</p>
           <p class="code" aria-label="Trail code">${display}</p>
           <a class="button" href="${APP_LINK_SCHEME}://join/${code}">Open in the app</a>
           <p class="hint">If nothing happens, open the app, choose <strong>Join a trail</strong>, and enter the code above.</p>`,
      ),
    );
  });
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #111827; --muted: #4b5563; --accent: #0f766e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1120; --card: #111827; --text: #f3f4f6; --muted: #9ca3af; --accent: #2dd4bf; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 16px; box-sizing: border-box; }
  main { background: var(--card); border-radius: 16px; padding: 28px 24px; max-width: 420px; width: 100%; text-align: center;
         box-shadow: 0 10px 30px rgb(0 0 0 / 0.08); }
  .lead { color: var(--muted); margin: 0 0 12px; }
  .code { font: 700 2rem/1.2 ui-monospace, "SF Mono", Consolas, monospace; letter-spacing: 0.08em; margin: 8px 0 24px; }
  .button { display: block; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600;
            padding: 14px 18px; border-radius: 12px; }
  .hint { color: var(--muted); font-size: 0.9rem; margin: 20px 0 0; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
