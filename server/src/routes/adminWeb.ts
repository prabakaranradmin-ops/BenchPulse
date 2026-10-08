import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { authenticate, requireAdmin } from '../plugins/auth.js';

export interface AdminWebOptions {
  /** The built admin-web/dist directory. If it has no index.html, /admin/ says how to build it. */
  root?: string | null;
  /** Cesium ion token: 3D terrain and OSM buildings on the map. Null → a flat OpenStreetMap map. */
  cesiumIonToken?: string | null;
}

/**
 * The admin page holds a session token that can publish trails, so script is same-origin only.
 * The map needs OpenStreetMap tiles, Cesium ion (terrain, buildings, and the Bing imagery ion
 * serves), WebAssembly for Cesium's mesh decoders, and inline styles from Cesium's widgets.
 */
export const ADMIN_WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.openstreetmap.org https://*.cesium.com https://*.virtualearth.net",
  "connect-src 'self' https://*.openstreetmap.org https://*.cesium.com https://*.virtualearth.net",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Serves the CesiumJS admin tool (ST-7.1, decision 2026-10-07 #3) from the API's own origin, so
 * it needs no CORS and the Admin signs in with the same token endpoint as the app.
 */
export async function adminWebRoutes(
  app: FastifyInstance,
  options: AdminWebOptions,
): Promise<void> {
  // Admin-only: an ion token is billed per use, so it isn't handed to anyone who asks.
  app.get(
    '/api/v1/admin/config',
    { onRequest: [authenticate, requireAdmin] },
    async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { cesiumIonToken: options.cesiumIonToken ?? null };
    },
  );

  app.get('/admin', { config: { rateLimit: false } }, async (_request, reply) =>
    reply.redirect('/admin/'),
  );

  const root = options.root ?? null;
  if (!root || !existsSync(path.join(root, 'index.html'))) {
    app.get('/admin/*', { config: { rateLimit: false } }, async (_request, reply) =>
      reply
        .code(404)
        .type('text/plain; charset=utf-8')
        .send('The admin web app has not been built. Run `npm run build` in admin-web/.'),
    );
    return;
  }

  // serve: false — only reply.sendFile, so the route below decides headers and rate limiting.
  // Dotfiles are a 404: nothing the tool needs starts with a dot, and an .env might.
  await app.register(fastifyStatic, { root, serve: false, dotfiles: 'ignore' });

  // The rate limit guards the API (SR-SEC-03); opening the map pulls dozens of Cesium files at
  // once, and static files are no cheaper to flood through a limiter than around it.
  app.get('/admin/*', { config: { rateLimit: false } }, async (request, reply) => {
    const file = (request.params as { '*': string })['*'] || 'index.html';
    securityHeaders(reply);

    // Vite fingerprints everything under assets/, so those never change under the same name.
    if (file.startsWith('assets/')) {
      return reply.sendFile(file, { maxAge: ONE_YEAR_MS, immutable: true });
    }
    // Everything else (the page itself, Cesium's runtime) is revalidated against its ETag, so a
    // deploy is picked up on the next load.
    return reply.sendFile(file, { maxAge: 0 });
  });
}

function securityHeaders(reply: FastifyReply): void {
  reply
    .header('Content-Security-Policy', ADMIN_WEB_CSP)
    .header('X-Content-Type-Options', 'nosniff')
    // Origin only, cross-origin: OpenStreetMap's tile and Nominatim usage policies ask browser
    // apps to identify themselves by Referer. The hash routes after it never leave the browser.
    .header('Referrer-Policy', 'strict-origin-when-cross-origin');
}
